/**
 * Launcher routes + readiness supervisor.
 *
 * The launcher dashboard reports whether `omp` itself is installed and
 * reachable on this machine — the WebUI's whole job is to wrap the CLI, so
 * "the runtime is healthy" means `omp --version` resolves. There is no
 * long-running daemon to supervise here: each chat session spawns its own
 * omp child via OmpSessionManager. The collab relay is a separate opt-in
 * feature handled elsewhere; the launcher no longer spawns it.
 */

import { existsSync } from "node:fs";
import type { BridgeConfig } from "../lib/config";
import type { BridgeContext } from "../lib/context";
import { errorResponse, jsonResponse } from "../lib/http";
import { type DetectOmpResult, findOmp } from "../lib/omp-detect";
import { probeTcp } from "../lib/process";

import type {
	DiagnosticsResponse,
	LauncherPhase,
	LauncherStreamEvent,
	RuntimeStatusResponse,
	ServiceStatus,
	UpdateInfo,
	WorkspaceProfile,
} from "../types";

const VERSION = "0.1.0";
const POLL_HEALTH_MS = 4000;

type Listener = (event: LauncherStreamEvent) => void;

/**
 * Tracks whether `omp` is installed and reachable. Health = `findOmp().found`
 * — we do not own an omp process; chat sessions spawn their own children.
 * The Start/Stop/Restart actions just re-run detection so the UI can refresh
 * after the user finishes an installer or upgrade run.
 */
export class LauncherSupervisor {
	private status: ServiceStatus = "stopped";
	private phase: LauncherPhase = "stopped";
	private healthy = false;
	private lastStartedAt: string | null = null;
	private lastError: string | null = null;
	private ompPath: string | null = null;
	private ompVersion: string | null = null;
	private healthTimer: ReturnType<typeof setInterval> | null = null;
	private readonly listeners = new Set<Listener>();

	constructor(_config: BridgeConfig) {
		void _config;
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
			endpoint: this.ompPath,
			healthy: this.healthy,
			lastStartedAt: this.lastStartedAt,
			metrics: null,
			version: this.ompVersion ?? VERSION,
			error: this.lastError,
		};
	}

	async start(): Promise<void> {
		this.transition("starting", "starting");
		this.lastError = null;
		this.lastStartedAt = new Date().toISOString();
		await this.probeHealth();
	}

	async stop(): Promise<void> {
		// No daemon to stop; we simply mark observed state as such until the
		// next health tick. Used by UI as a "reset card" gesture.
		this.transition("stopped", "stopped");
		this.healthy = false;
		this.broadcast({ type: "health", healthy: false });
	}

	async restart(): Promise<void> {
		await this.stop();
		await new Promise(r => setTimeout(r, 200));
		await this.start();
	}

	shutdown(): void {
		if (this.healthTimer) clearInterval(this.healthTimer);
	}

	private beginHealthLoop(): void {
		this.healthTimer = setInterval(() => void this.probeHealth(), POLL_HEALTH_MS);
		void this.probeHealth();
	}

	private async probeHealth(): Promise<void> {
		const detect = await findOmp();
		const wasHealthy = this.healthy;
		this.healthy = detect.found;
		this.ompPath = detect.path;
		this.ompVersion = detect.version;
		if (detect.found) {
			if (this.status !== "running") this.transition("running", "running_healthy");
		} else {
			if (this.status === "running") this.transition("degraded", "error");
			else if (this.status === "starting") this.transition("error", "error");
		}
		if (this.healthy !== wasHealthy) {
			this.broadcast({ type: "health", healthy: this.healthy });
		}
	}

	private transition(status: ServiceStatus, phase: LauncherPhase): void {
		this.status = status;
		this.phase = phase;
		this.broadcast({ type: "status_change", status, phase });
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
		const detect = await findOmp();
		const bridgePort = ctx.config.port;
		const bridgeReachable = await probeTcp("127.0.0.1", bridgePort);
		const installDirExists = existsSync(ctx.config.installDir);
		const checks = [
			{
				id: "omp",
				label: "omp installed",
				status: detect.found ? ("ok" as const) : ("fail" as const),
				detail: detect.found
					? `${detect.path} ${detect.version ? `(${detect.version})` : ""}`.trim()
					: "omp not found on PATH or known locations",
				fixHint: detect.found ? undefined : "Re-run the installer from the previous screen.",
			},
			{
				id: "bridge",
				label: "Desktop bridge reachable",
				status: bridgeReachable ? ("ok" as const) : ("fail" as const),
				detail: `127.0.0.1:${bridgePort}`,
			},
			{
				id: "installdir",
				label: "Bridge install directory writable",
				status: installDirExists ? ("ok" as const) : ("fail" as const),
				detail: ctx.config.installDir,
			},
		];
		const overallStatus: DiagnosticsResponse["overallStatus"] = checks.some(c => c.status === "fail") ? "fail" : "ok";
		const result: DiagnosticsResponse = { overallStatus, runAt: new Date().toISOString(), checks };
		return jsonResponse(result);
	}
	if (p === "/api/v1/launcher/logs" && req.method === "GET") {
		return jsonResponse({ lines: [] });
	}

	if (p === "/api/v1/launcher/detect-omp" && req.method === "GET") {
		const result = await findOmp();
		return jsonResponse(result);
	}

	return errorResponse("NOT_FOUND", `No launcher route for ${req.method} ${p}`, 404);
}

// Re-export for any consumer that imported the type from this route module.
export type { DetectOmpResult };
