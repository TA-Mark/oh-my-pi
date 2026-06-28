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

import { loadConfig } from "./lib/config";
import type { BridgeContext } from "./lib/context";
import { corsPreflight, errorResponse } from "./lib/http";
import { JobManager } from "./lib/jobs";
import { OmpSessionManager } from "./lib/omp-manager";
import { handleChat } from "./routes/chat";
import { handleHealth } from "./routes/health";
import { handleInstaller } from "./routes/installer";
import { handleLauncher, LauncherSupervisor } from "./routes/launcher";

interface SocketData {
	topic: string;
	jobId?: string;
	chatSessionId?: string;
}

export function start(opts: { port?: number } = {}): { url: string; stop(): Promise<void> } {
	const config = loadConfig({ port: opts.port });
	const jobs = new JobManager();
	const launcher = new LauncherSupervisor(config);
	const omp = new OmpSessionManager(config);
	const ctx: BridgeContext = { config, jobs, launcher, omp };

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
					const unsub = jobs.subscribe(ws.data.jobId, (event) => ws.send(JSON.stringify(event)));
					subscribers.set(ws, unsub);
					return;
				}
				if (ws.data.topic === "launcher") {
					const unsub = launcher.subscribe((event) => ws.send(JSON.stringify(event)));
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
					const unsub = omp.subscribe(id, (envelope) => ws.send(JSON.stringify(envelope)));
					subscribers.set(ws, unsub);
				}
			},
			close(ws): void {
				subscribers.get(ws)?.();
				subscribers.delete(ws);
			},
			message(ws, raw): void {
				// Chat WS is bidirectional: client RPC commands forward to omp stdin.
				if (!ws.data.chatSessionId) return;
				const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
				let frame: unknown;
				try {
					frame = JSON.parse(text);
				} catch {
					ws.send(JSON.stringify({ type: "error", message: "malformed JSON" }));
					return;
				}
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
