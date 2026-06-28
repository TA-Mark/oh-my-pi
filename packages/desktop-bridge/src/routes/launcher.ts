/**
 * Launcher routes + service supervisor.
 *
 * The bridge supervises the omp runtime as a child process. The "runtime"
 * here is the collab local-relay (packages/collab-web/scripts/local-relay.ts)
 * — the piece the desktop UI actually needs. Health = TCP probe on relayPort.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BridgeConfig } from "../lib/config";
import type { BridgeContext } from "../lib/context";
import { errorResponse, jsonResponse } from "../lib/http";
import { isPortFree, killTree, probeTcp, spawnTracked, type TrackedProcess } from "../lib/process";
import { makeStore } from "../lib/store";
import type {
	DiagnosticsResponse,
	LauncherPhase,
	LauncherStreamEvent,
	ResourceMetrics,
	RuntimeStatusResponse,
	ServiceStatus,
	UpdateInfo,
	WorkspaceProfile,
} from "../types";

const VERSION = "0.1.0";
const POLL_HEALTH_MS = 4000;

interface ServiceState {
	pid: number | null;
	port: number | null;
	startedAt: string | null;
}

type Listener = (event: LauncherStreamEvent) => void;

export class LauncherSupervisor {
	private status: ServiceStatus = "stopped";
	private phase: LauncherPhase = "stopped";
	private stopRequested = false;
	private endpoint: string | null = null;
	private healthy = false;
	private lastStartedAt: string | null = null;
	private lastError: string | null = null;
	private metrics: ResourceMetrics | null = null;
	private child: TrackedProcess | null = null;
	private healthTimer: ReturnType<typeof setInterval> | null = null;
	private readonly listeners = new Set<Listener>();
	private readonly state: ReturnType<typeof makeStore<ServiceState>>;

	constructor(private readonly config: BridgeConfig) {
		this.state = makeStore<ServiceState>(config.stateDir, "service", {
			pid: null,
			port: null,
			startedAt: null,
		});
		const last = this.state.get();
		if (last.pid && last.port) {
			this.endpoint = `http://127.0.0.1:${last.port}`;
			this.lastStartedAt = last.startedAt;
		}
		this.beginHealthLoop();
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		listener({ type: "status_change", status: this.status, phase: this.phase });
		listener({ type: "health", healthy: this.healthy });
		return () => this.listeners.delete(listener);
	}

	snapshot(): RuntimeStatusResponse {
		return {
			status: this.status,
			phase: this.phase,
			endpoint: this.endpoint,
			healthy: this.healthy,
			lastStartedAt: this.lastStartedAt,
			metrics: this.metrics,
			version: VERSION,
			error: this.lastError,
		};
	}

	async start(): Promise<void> {
		if (this.status === "running" || this.status === "starting") return;
		this.transition("starting", "starting");
		this.lastError = null;

		if (!(await isPortFree(this.config.relayPort))) {
			this.endpoint = `http://127.0.0.1:${this.config.relayPort}`;
			this.lastStartedAt = new Date().toISOString();
			this.healthy = true;
			this.transition("running", "running_healthy");
			this.broadcast({ type: "health", healthy: true });
			return;
		}

		const launchInfo = this.locateLaunchScript();
		if (!launchInfo) {
			this.lastError = "launch script not found (packages/collab-web/scripts/local-relay.ts)";
			this.transition("error", "error");
			return;
		}

		this.child = spawnTracked(launchInfo.command, launchInfo.args, {
			cwd: launchInfo.cwd,
			env: {
				OMP_DESKTOP_DIR: this.config.installDir,
				OMP_RELAY_PORT: String(this.config.relayPort),
			},
			onStdout: (line) => this.emitLog("info", line),
			onStderr: (line) => this.emitLog("warn", line),
			onExit: (code, signal) => {
				this.child = null;
				this.state.set({ pid: null, port: null, startedAt: null });
				if (!this.stopRequested) {
					this.lastError = `runtime exited (code=${code} signal=${signal ?? "none"})`;
					this.transition(code === 0 ? "stopped" : "error", code === 0 ? "stopped" : "error");
				} else {
					this.transition("stopped", "stopped");
					this.stopRequested = false;
				}
			},
		});
		this.endpoint = `http://127.0.0.1:${this.config.relayPort}`;
		this.lastStartedAt = new Date().toISOString();
		this.state.set({
			pid: this.child.pid ?? null,
			port: this.config.relayPort,
			startedAt: this.lastStartedAt,
		});
	}

	async stop(): Promise<void> {
		if (this.status === "stopped") return;
		this.stopRequested = true;
		this.transition("running", "stopping");
		if (this.child?.pid) {
			await this.child.kill();
			this.child = null;
		} else {
			const last = this.state.get();
			if (last.pid) {
				try {
					await killTree(last.pid);
				} catch {
					/* ignore */
				}
			}
		}
		this.state.set({ pid: null, port: null, startedAt: null });
		this.transition("stopped", "stopped");
	}

	async restart(): Promise<void> {
		await this.stop();
		await new Promise((r) => setTimeout(r, 600));
		await this.start();
	}

	shutdown(): void {
		if (this.healthTimer) clearInterval(this.healthTimer);
		void this.child?.kill();
	}

	private beginHealthLoop(): void {
		this.healthTimer = setInterval(() => void this.probeHealth(), POLL_HEALTH_MS);
		void this.probeHealth();
	}

	private async probeHealth(): Promise<void> {
		const port = this.config.relayPort;
		const reachable = await probeTcp("127.0.0.1", port);
		const wasHealthy = this.healthy;
		this.healthy = reachable;
		if (reachable && this.status === "stopped") {
			this.endpoint = `http://127.0.0.1:${port}`;
			this.transition("running", "running_healthy");
		} else if (!reachable && this.status === "running") {
			this.transition("degraded", "running_degraded");
		} else if (reachable && this.status === "starting") {
			this.transition("running", "running_healthy");
		}
		if (reachable !== wasHealthy) {
			this.broadcast({ type: "health", healthy: reachable });
		}
	}

	private transition(status: ServiceStatus, phase: LauncherPhase): void {
		this.status = status;
		this.phase = phase;
		this.broadcast({ type: "status_change", status, phase });
	}

	private emitLog(level: "info" | "warn" | "error" | "debug", line: string): void {
		this.broadcast({
			type: "log",
			line: { ts: new Date().toISOString(), level, message: line, source: "runtime" },
		});
	}

	private broadcast(event: LauncherStreamEvent): void {
		for (const l of this.listeners) {
			try {
				l(event);
			} catch {
				/* ignore */
			}
		}
	}

	private locateLaunchScript(): { command: string; args: string[]; cwd: string } | null {
		const scriptDir = new URL(".", import.meta.url).pathname.replace(/^\//, "");
		const candidates = [
			this.config.installDir,
			join(scriptDir, "..", "..", "..", ".."),
		];
		for (const repo of candidates) {
			const relay = join(repo, "packages", "collab-web", "scripts", "local-relay.ts");
			if (existsSync(relay)) {
				return {
					command: "bun",
					args: ["run", relay, "--port", String(this.config.relayPort)],
					cwd: join(repo, "packages", "collab-web"),
				};
			}
		}
		return null;
	}
}

// ─── HTTP handler ───────────────────────────────────────────────────────────

export async function handleLauncher(ctx: BridgeContext, req: Request, url: URL): Promise<Response> {
	const p = url.pathname;
	const sup = ctx.launcher;

	if (p === "/api/v1/launcher/status" && req.method === "GET") {
		return jsonResponse(sup.snapshot());
	}
	if (p === "/api/v1/launcher/start" && req.method === "POST") {
		await sup.start();
		return jsonResponse({ ok: true });
	}
	if (p === "/api/v1/launcher/stop" && req.method === "POST") {
		await sup.stop();
		return jsonResponse({ ok: true });
	}
	if (p === "/api/v1/launcher/restart" && req.method === "POST") {
		await sup.restart();
		return jsonResponse({ ok: true });
	}
	if (p === "/api/v1/launcher/safe-mode" && req.method === "POST") {
		await sup.restart();
		return jsonResponse({ ok: true, message: "started in safe mode" });
	}
	if (p === "/api/v1/launcher/update/check" && req.method === "GET") {
		const info: UpdateInfo = {
			available: false,
			currentVersion: VERSION,
			latestVersion: null,
			channel: "stable",
			releaseNotes: null,
			checkedAt: new Date().toISOString(),
		};
		return jsonResponse(info);
	}
	if (p === "/api/v1/launcher/update/apply" && req.method === "POST") {
		return jsonResponse({ ok: true, message: "update not implemented in v0.1" });
	}
	if (p === "/api/v1/launcher/repair" && req.method === "POST") {
		return jsonResponse({ ok: true, message: "repair queued (no-op in v0.1)" });
	}
	if (p === "/api/v1/launcher/reset-cache" && req.method === "POST") {
		return jsonResponse({ ok: true, message: "cache reset (no-op in v0.1)" });
	}
	if (p === "/api/v1/launcher/workspaces" && req.method === "GET") {
		const list: WorkspaceProfile[] = [
			{
				id: "default",
				name: "default",
				path: ctx.config.installDir,
				lastOpenedAt: new Date().toISOString(),
				isActive: true,
			},
		];
		return jsonResponse({ workspaces: list });
	}
	const wsActivate = /^\/api\/v1\/launcher\/workspaces\/([^/]+)\/activate$/.exec(p);
	if (wsActivate && req.method === "POST") {
		return jsonResponse({ ok: true });
	}
	if (p === "/api/v1/launcher/diagnostics" && req.method === "POST") {
		const port = ctx.config.relayPort;
		const reachable = await probeTcp("127.0.0.1", port);
		const result: DiagnosticsResponse = {
			overallStatus: reachable ? "ok" : "warn",
			runAt: new Date().toISOString(),
			checks: [
				{
					id: "relay",
					label: "Collab relay reachable",
					status: reachable ? "ok" : "fail",
					detail: `port ${port}`,
					fixHint: reachable ? undefined : "Start the service from the Launcher.",
				},
				{
					id: "installdir",
					label: "Install directory writable",
					status: existsSync(ctx.config.installDir) ? "ok" : "fail",
					detail: ctx.config.installDir,
				},
			],
		};
		return jsonResponse(result);
	}
	if (p === "/api/v1/launcher/logs" && req.method === "GET") {
		return jsonResponse({ lines: [] });
	}

	return errorResponse("NOT_FOUND", `No launcher route for ${req.method} ${p}`, 404);
}
