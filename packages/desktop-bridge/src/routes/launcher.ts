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

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BridgeConfig } from "../lib/config";
import type { BridgeContext } from "../lib/context";
import { errorResponse, jsonResponse } from "../lib/http";
import type { JobManager } from "../lib/jobs";
import { type DetectOmpResult, findOmp } from "../lib/omp-detect";
import { probeTcp, spawnTracked } from "../lib/process";

import type {
	DiagnosticsResponse,
	InstallProgress,
	LauncherPhase,
	LauncherStreamEvent,
	RuntimeStatusResponse,
	ServiceStatus,
	UpdateInfo,
	WorkspaceProfile,
} from "../types";

const VERSION = "0.1.0";
const POLL_HEALTH_MS = 15000;
const AUTO_INSTALL_COOLDOWN_MS = 60_000;
const LAST_INSTALL_FILE = "last-install-attempt.json";

interface LastInstallAttempt {
	attemptedAt: string;
	exitCode: number | null;
	message?: string;
}

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
	private lastFoundAt = 0;
	private readonly listeners = new Set<Listener>();

	// Auto-install state
	private readonly bridgeConfig: BridgeConfig;
	private jobs: JobManager | null = null;
	private installing = false;
	private installProgress: InstallProgress | null = null;
	private lastInstallExitCode: number | null = null;
	private lastInstallAt = 0;

	constructor(config: BridgeConfig) {
		this.bridgeConfig = config;
		const prev = this.loadLastInstallAttempt();
		if (prev) {
			this.lastInstallAt = new Date(prev.attemptedAt).getTime();
			this.lastInstallExitCode = prev.exitCode;
		}
		this.beginHealthLoop();
	}

	/**
	 * Wire the supervisor to the JobManager once it exists. Called from
	 * server.ts after the context is assembled, so auto-install can stream
	 * logs through the standard job pipeline.
	 */
	attachJobs(jobs: JobManager): void {
		this.jobs = jobs;
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		listener({ type: "status_change", status: this.status, phase: this.phase });
		listener({ type: "health", healthy: this.healthy });
		if (this.installProgress) {
			listener({ type: "install_progress", progress: this.installProgress });
		}
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
			installProgress: this.installProgress,
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
		// Don't probe while an auto-install job is mid-flight — the file
		// `omp.exe` will materialise underneath us at the end and we'd race.
		if (this.installing) return;

		const now = Date.now();
		const cacheValidMs = 120_000;
		if (this.healthy && this.ompPath && now - this.lastFoundAt < cacheValidMs) {
			return;
		}
		const detect = await findOmp();
		const wasHealthy = this.healthy;
		this.healthy = detect.found;
		this.ompPath = detect.path;
		this.ompVersion = detect.version;
		if (detect.found) {
			this.lastFoundAt = now;
			if (this.status !== "running") this.transition("running", "running_healthy");
		} else if (this.canAutoInstall(now)) {
			// First boot on a clean machine — try to install omp from the
			// bundled Bun sidecar before flashing the red banner.
			void this.runAutoInstall();
			return;
		} else {
			if (this.status === "running") this.transition("degraded", "error");
			else if (this.status === "starting") this.transition("error", "error");
			else if (this.status === "stopped" || this.status === "installing") this.transition("error", "error");
		}
		if (this.healthy !== wasHealthy) {
			this.broadcast({ type: "health", healthy: this.healthy });
		}
	}

	private canAutoInstall(now: number): boolean {
		if (!process.env.OMP_BUNDLED_BUN) return false; // dev mode w/o bundle
		if (this.installing) return false;
		// Cooldown after a recent failed attempt so we don't spam install
		// every health tick when the user is offline.
		if (this.lastInstallExitCode !== null && this.lastInstallExitCode !== 0) {
			if (now - this.lastInstallAt < AUTO_INSTALL_COOLDOWN_MS) return false;
		}
		return true;
	}

	private async runAutoInstall(): Promise<void> {
		const jobs = this.jobs;
		const bun = process.env.OMP_BUNDLED_BUN;
		if (!jobs || !bun) return;
		this.installing = true;
		this.transition("installing", "installing");
		this.healthy = true; // suppress red banner during install
		this.broadcast({ type: "health", healthy: true });

		const job = jobs.create([{ id: "auto-install", label: "Install omp runtime" }]);
		const target = "@oh-my-pi/pi-coding-agent@latest";
		jobs.emitLog(job.id, "info", `> ${bun} install -g ${target}`);
		jobs.setPhase(job.id, "installing", 5, "auto-install");
		const logTail: string[] = [];
		const pushTail = (line: string): void => {
			logTail.push(line);
			if (logTail.length > 8) logTail.shift();
			this.publishProgress(job.id, this.installProgress?.percent ?? 10, this.installProgress?.message ?? "Đang tải omp runtime…", logTail);
		};
		this.publishProgress(job.id, 10, "Đang tải omp runtime…");

		const child = spawnTracked(bun, ["install", "-g", target], {
			onStdout(line) {
				jobs.emitLog(job.id, "info", line, line);
				pushTail(line);
			},
			onStderr(line) {
				jobs.emitLog(job.id, "warn", line, line);
				pushTail(line);
			},
		});

		const { code } = await child.waitExit();
		this.lastInstallAt = Date.now();
		this.lastInstallExitCode = code;
		this.saveLastInstallAttempt({
			attemptedAt: new Date(this.lastInstallAt).toISOString(),
			exitCode: code,
		});
		this.installing = false;

		if (code === 0) {
			jobs.completeStep(job.id, "auto-install", "pass");
			jobs.setPhase(job.id, "success", 100);
			jobs.emitLog(job.id, "info", "omp runtime ready");
			this.publishProgress(job.id, 100, "omp runtime ready", logTail);
			// Re-probe to pick up new omp.exe
			this.installProgress = null;
			await this.probeHealth();
			return;
		}

		jobs.fail(job.id, {
			code: "INSTALL_FAILED",
			message: `bun install exited with ${code}. Check network or open Installer.`,
		});
		this.installProgress = null;
		this.lastError = "auto-install failed";
		this.transition("error", "error");
		this.healthy = false;
		this.broadcast({ type: "health", healthy: false, error: this.lastError });
	}

	private publishProgress(jobId: string, percent: number, message: string, logTail?: string[]): void {
		this.installProgress = { jobId, percent, message, logTail };
		this.broadcast({ type: "install_progress", progress: this.installProgress });
	}

	private loadLastInstallAttempt(): LastInstallAttempt | null {
		try {
			const raw = readFileSync(join(this.bridgeConfig.stateDir, LAST_INSTALL_FILE), "utf8");
			return JSON.parse(raw) as LastInstallAttempt;
		} catch {
			return null;
		}
	}

	private saveLastInstallAttempt(attempt: LastInstallAttempt): void {
		try {
			writeFileSync(join(this.bridgeConfig.stateDir, LAST_INSTALL_FILE), JSON.stringify(attempt, null, 2), "utf8");
		} catch {
			/* best-effort */
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

// ─── Update helpers ─────────────────────────────────────────────────────────

const NPM_LATEST_URL = "https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/latest";
const NPM_CHANNEL_URL: Record<string, string> = {
	stable: NPM_LATEST_URL,
	// npm dist-tags `beta` / `nightly` aren't published yet; fall back to latest
	// so the UI never breaks when the user toggles channel before they exist.
	beta: NPM_LATEST_URL,
	nightly: NPM_LATEST_URL,
};

/** Strip any leading `v` / `omp ` / `omp/` prefix so we compare bare semver strings. */
function normalizeVersion(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const cleaned = raw
		.replace(/^\s*omp[\s/]/i, "")
		.replace(/^v/i, "")
		.trim();
	return cleaned || null;
}

async function fetchNpmLatest(channel: string): Promise<string | null> {
	const url = NPM_CHANNEL_URL[channel] ?? NPM_LATEST_URL;
	try {
		const res = await fetch(url, { headers: { accept: "application/json" } });
		if (!res.ok) return null;
		const data = (await res.json()) as { version?: unknown };
		return typeof data.version === "string" ? data.version : null;
	} catch {
		return null;
	}
}

function buildUpdateSpawn(): { command: string; args: string[] } {
	const cmd = "bun install -g --force @oh-my-pi/pi-coding-agent@latest";
	if (process.platform === "win32") {
		return { command: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmd] };
	}
	return { command: "sh", args: ["-c", cmd] };
}

/**
 * Run `bun install -g --force` and stream its output through the JobManager.
 * Returns the new job id immediately; callers can poll
 * `/installer/jobs/:id/{status,logs}` for progress and the WS stream for logs.
 */
function runUpdateJob(ctx: BridgeContext, reason: "update" | "repair"): string {
	const job = ctx.jobs.create([{ id: "install", label: reason === "update" ? "Update omp CLI" : "Repair install" }]);
	const spec = buildUpdateSpawn();
	ctx.jobs.emitLog(job.id, "info", `> ${spec.args[spec.args.length - 1]}`);
	ctx.jobs.setPhase(job.id, "installing", 10, "install");

	const child = spawnTracked(spec.command, spec.args, {
		onStdout(line) {
			ctx.jobs.emitLog(job.id, "info", line, line);
		},
		onStderr(line) {
			ctx.jobs.emitLog(job.id, "warn", line, line);
		},
	});
	const jobRef = ctx.jobs.get(job.id);
	if (jobRef) jobRef.cancel = () => void child.kill();

	void child.waitExit().then(({ code }) => {
		if (code === null) {
			ctx.jobs.emitLog(job.id, "warn", `${reason} cancelled`);
			return;
		}
		if (code !== 0) {
			ctx.jobs.fail(job.id, {
				code: "EXIT_NON_ZERO",
				message: `${reason} command exited with code ${code}. See log panel.`,
			});
			return;
		}
		ctx.jobs.completeStep(job.id, "install", "pass");
		ctx.jobs.setPhase(job.id, "success", 100);
		ctx.jobs.emitLog(job.id, "info", `${reason} complete`);
	});
	return job.id;
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
		const channelParam = url.searchParams.get("channel") ?? "stable";
		const channel = (["stable", "beta", "nightly"].includes(channelParam) ? channelParam : "stable") as
			| "stable"
			| "beta"
			| "nightly";
		const [latestRaw, detect] = await Promise.all([fetchNpmLatest(channel), findOmp()]);
		const latest = normalizeVersion(latestRaw);
		const current = normalizeVersion(detect.version);
		const info: UpdateInfo = {
			available: latest !== null && current !== null && latest !== current,
			currentVersion: current ?? "unknown",
			latestVersion: latest,
			channel,
			releaseNotes: null,
			checkedAt: new Date().toISOString(),
		};
		return jsonResponse(info);
	}
	if (p === "/api/v1/launcher/update/apply" && req.method === "POST") {
		const jobId = runUpdateJob(ctx, "update");
		return jsonResponse({ ok: true, jobId, message: "update started" });
	}
	if (p === "/api/v1/launcher/repair" && req.method === "POST") {
		const jobId = runUpdateJob(ctx, "repair");
		return jsonResponse({ ok: true, jobId, message: "repair started" });
	}
	if (p === "/api/v1/launcher/reset-cache" && req.method === "POST") {
		const removed: string[] = [];
		const tryRemove = (path: string): void => {
			try {
				if (existsSync(path)) {
					rmSync(path, { recursive: true, force: true });
					removed.push(path);
				}
			} catch {
				/* best-effort */
			}
		};
		tryRemove(join(ctx.config.installDir, "logs"));
		tryRemove(join(ctx.config.installDir, "session-bindings.json"));
		return jsonResponse({
			ok: true,
			message: removed.length > 0 ? `cleared ${removed.length} cache entries` : "no cache to clear",
			removed,
		});
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
