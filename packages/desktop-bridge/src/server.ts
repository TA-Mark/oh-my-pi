/**
 * @oh-my-pi/desktop-bridge — Bun HTTP + WebSocket server (port 8787 default).
 *
 * Hosts three feature surfaces consumed by packages/collab-web:
 *   /api/v1/installer/*   (POST/GET + WS jobs/{id}/stream)
 *   /api/v1/launcher/*    (POST/GET + WS stream)
 *   /api/v1/chat/*        (sessions, data-sources, runtime-config)
 *
 * One process; subroutes are dispatched by pathname. Permissive CORS for
 * localhost only — the bridge binds to 127.0.0.1 and is never exposed.
 */

import { dirname } from "node:path";
import { ApiKeyStore } from "./lib/api-keys";
import { loadConfig } from "./lib/config";
import { execShell } from "./lib/shell-exec";
import type { BridgeContext } from "./lib/context";
import { corsPreflight, errorResponse } from "./lib/http";
import { JobManager } from "./lib/jobs";
import { OmpSessionManager } from "./lib/omp-manager";
import { handleChat } from "./routes/chat";
import { handleConfig } from "./routes/config";
import { handleHealth } from "./routes/health";
import { handleInstaller } from "./routes/installer";
import { handleLauncher, LauncherSupervisor } from "./routes/launcher";

/**
 * If the Tauri shell bundles a Bun sidecar, it forwards the absolute path via
 * `OMP_BUNDLED_BUN`. Prepend that directory to PATH so every child we spawn
 * (PowerShell running `bun install -g`, install.ps1 detecting Bun, etc.)
 * resolves `bun` against the bundled binary — no internet round-trip required
 * on a clean machine.
 */
function prependBundledToPath(): void {
	const bun = process.env.OMP_BUNDLED_BUN;
	if (!bun) return;
	const sep = process.platform === "win32" ? ";" : ":";
	const dir = dirname(bun);
	const current = process.env.PATH ?? "";
	if (current.split(sep).some(p => p.toLowerCase() === dir.toLowerCase())) return;
	process.env.PATH = `${dir}${sep}${current}`;
	console.log(`[desktop-bridge] prepended bundled bun dir to PATH: ${dir}`);
}

interface SocketData {
	topic: string;
	jobId?: string;
	chatSessionId?: string;
	shellSessionId?: string;
}

export function start(opts: { port?: number } = {}): { url: string; stop(): Promise<void> } {
	prependBundledToPath();
	const config = loadConfig({ port: opts.port });
	// Persist job logs to <installDir>/logs/install-<jobId>.log so the user
	// has a stable artifact to share when something fails.
	const jobs = new JobManager({ logDir: `${config.installDir}/logs` });
	const launcher = new LauncherSupervisor(config);
	launcher.attachJobs(jobs); // enable auto-install via shared JobManager
	const omp = new OmpSessionManager(config);
	const apiKeys = new ApiKeyStore(config.stateDir);
	const ctx: BridgeContext = { config, jobs, launcher, omp, apiKeys };

	const subscribers = new WeakMap<Bun.ServerWebSocket<SocketData>, () => void>();

	const server = Bun.serve<SocketData>({
		port: config.port,
		hostname: "127.0.0.1",
		async fetch(req, srv): Promise<Response | undefined> {
			if (req.method === "OPTIONS") return corsPreflight();

			const url = new URL(req.url);
			const p = url.pathname;

			// ─── WebSocket upgrades ───────────────────────────────────────────
			const wsInstaller = /^\/api\/v1\/installer\/jobs\/([^/]+)\/stream$/.exec(p);
			if (wsInstaller) {
				const data: SocketData = {
					topic: `installer:${wsInstaller[1]}`,
					jobId: wsInstaller[1]!,
				};
				if (srv.upgrade(req, { data })) return undefined;
				return errorResponse("UPGRADE_REQUIRED", "WebSocket upgrade required", 426);
			}
			if (p === "/api/v1/launcher/stream") {
				const data: SocketData = { topic: "launcher" };
				if (srv.upgrade(req, { data })) return undefined;
				return errorResponse("UPGRADE_REQUIRED", "WebSocket upgrade required", 426);
			}
			const wsShell = /^\/api\/v1\/chat\/sessions\/([^/]+)\/shell$/.exec(p);
			if (wsShell) {
				const data: SocketData = {
					topic: `shell:${wsShell[1]}`,
					shellSessionId: wsShell[1]!,
				};
				if (srv.upgrade(req, { data })) return undefined;
				return errorResponse("UPGRADE_REQUIRED", "WebSocket upgrade required", 426);
			}
			const wsChat = /^\/api\/v1\/chat\/sessions\/([^/]+)\/rpc$/.exec(p);
			if (wsChat) {
				const data: SocketData = {
					topic: `chat:${wsChat[1]}`,
					chatSessionId: wsChat[1]!,
				};
				if (srv.upgrade(req, { data })) return undefined;
				return errorResponse("UPGRADE_REQUIRED", "WebSocket upgrade required", 426);
			}

			// ─── HTTP routes ──────────────────────────────────────────────────
			if (p === "/api/v1/health" || p === "/health") return handleHealth(ctx, req);
			if (p.startsWith("/api/v1/installer/")) return handleInstaller(ctx, req, url);
			if (p.startsWith("/api/v1/launcher/")) return handleLauncher(ctx, req, url);
			if (p.startsWith("/api/v1/chat/")) return handleChat(ctx, req, url);
			if (p === "/api/v1/config" || p.startsWith("/api/v1/config/")) return handleConfig(req, url);

			return errorResponse("NOT_FOUND", `No route for ${req.method} ${p}`, 404);
		},
		websocket: {
			open(ws): void {
				if (ws.data.jobId) {
					const job = jobs.get(ws.data.jobId);
					if (job) {
						for (const line of job.logs) {
							ws.send(JSON.stringify({ type: "log", jobId: job.id, line }));
						}
						ws.send(
							JSON.stringify({
								type: "phase_change",
								jobId: job.id,
								phase: job.phase,
								progress: job.progress,
							}),
						);
					}
					const unsub = jobs.subscribe(ws.data.jobId, event => ws.send(JSON.stringify(event)));
					subscribers.set(ws, unsub);
					return;
				}
				if (ws.data.topic === "launcher") {
					const unsub = launcher.subscribe(event => ws.send(JSON.stringify(event)));
					subscribers.set(ws, unsub);
					return;
				}
				if (ws.data.chatSessionId) {
					const id = ws.data.chatSessionId;
					if (!omp.get(id)) {
						ws.send(JSON.stringify({ type: "error", message: "session not started" }));
						ws.close(4404, "session not started");
						return;
					}
					const unsub = omp.subscribe(id, envelope => ws.send(JSON.stringify(envelope)));
					subscribers.set(ws, unsub);
				}
			},
			close(ws): void {
				subscribers.get(ws)?.();
				subscribers.delete(ws);
			},
			message(ws, raw): void {
				const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
				let frame: Record<string, unknown>;
				try {
					frame = JSON.parse(text) as Record<string, unknown>;
				} catch {
					ws.send(JSON.stringify({ type: "error", message: "malformed JSON" }));
					return;
				}

				if (ws.data.shellSessionId) {
					const command = typeof frame.command === "string" ? frame.command : "";
					const hidden = frame.hidden === true;
					if (!command) {
						ws.send(JSON.stringify({ type: "error", message: "command is required" }));
						return;
					}
					void execShell(command, {
						cwd: config.installDir,
						timeout: 120_000,
						onChunk: (chunk: string) => {
							try { ws.send(JSON.stringify({ type: "chunk", data: chunk })); } catch { /* closed */ }
						},
					}).then(result => {
						if (!hidden && result.output && ws.data.shellSessionId) {
							const contextMsg = `User ran: \`${command}\`\nOutput:\n\`\`\`\n${result.output.slice(0, 8000)}\n\`\`\`\nExit code: ${result.exitCode ?? "unknown"}`;
							omp.send(ws.data.shellSessionId, { id: `bridge-shell-${Date.now()}`, type: "prompt", message: contextMsg });
						}
						try {
							ws.send(JSON.stringify({ type: "exit", exitCode: result.exitCode, cancelled: result.cancelled }));
							ws.close(1000, "done");
						} catch { /* closed */ }
					});
					return;
				}

				if (!ws.data.chatSessionId) return;
				omp.send(ws.data.chatSessionId, frame);
			},
		},
	});

	const url = `http://${server.hostname}:${server.port}/api/v1`;
	console.log(`[desktop-bridge] listening on ${url}`);
	console.log(`[desktop-bridge] installDir: ${config.installDir}`);
	console.log(`[desktop-bridge] relayPort:  ${config.relayPort}`);

	return {
		url,
		async stop(): Promise<void> {
			await omp.shutdown();
			launcher.shutdown();
			server.stop(true);
		},
	};
}

function parsePort(argv: readonly string[]): number | undefined {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--port") return Number(argv[i + 1]);
		if (arg.startsWith("--port=")) return Number(arg.slice("--port=".length));
	}
	return undefined;
}

if (import.meta.main) {
	const port = parsePort(Bun.argv.slice(2));
	const handle = start(port !== undefined ? { port } : {});
	let stopping = false;
	const shutdown = (): void => {
		if (stopping) return;
		stopping = true;
		console.log("[desktop-bridge] shutting down…");
		handle.stop().finally(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
