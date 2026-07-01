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

// MUST be the very first import — stages the bundled pi-natives addon into a
// path the loader recognizes before any transitive import of the module
// runs. See lib/stage-native.ts for the why.
import "./lib/stage-native";

import { dirname } from "node:path";
import { ApiKeyStore } from "./lib/api-keys";
import { loadConfig } from "./lib/config";
import type { BridgeContext } from "./lib/context";
import { corsPreflight, errorResponse } from "./lib/http";
import { JobManager } from "./lib/jobs";
import { startLocalRelay } from "./lib/local-relay";
import { OmpSessionManager } from "./lib/omp-manager";
import { OmpPtyManager } from "./lib/omp-pty-manager";
import { execShell } from "./lib/shell-exec";
import { handleChat } from "./routes/chat";
import { handleConfig } from "./routes/config";
import { handleDiff } from "./routes/diff";
import { handleFs } from "./routes/fs";
import { handleHealth } from "./routes/health";
import { handleInstaller } from "./routes/installer";
import { handleLauncher, LauncherSupervisor } from "./routes/launcher";
import { handleMcp } from "./routes/mcp";
import { handleUsage } from "./routes/usage";

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
	/** Active when this socket is a PTY byte stream for an omp TUI session. */
	ptySessionId?: string;
	/** Last envelope seq the client already saw — replay only newer frames. */
	sinceSeq?: number;
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
	// Embed the collab relay inside this Bun process so the CollabHost in every
	// PTY-spawned omp TUI can connect to ws://127.0.0.1:<relayPort> without us
	// supervising a second process. The relay is content-blind (sealed
	// envelopes), so multiple sessions multiplex through distinct rooms safely.
	const relay = startLocalRelay(config.relayPort);
	const ompPty = new OmpPtyManager(config, omp.bindings);
	const apiKeys = new ApiKeyStore(config.stateDir);
	const ctx: BridgeContext = { config, jobs, launcher, omp, ompPty, relay, apiKeys };

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
			// @deprecated Phase 5A — the /shell WS supported the legacy MainChatPage
			// bash-tool shell path. New PTY-backed UI runs bash directly in the
			// terminal or via `/chat/sessions/:id/input` synthing shell text.
			// Removed in Phase 5B once no consumer references it.
			const wsShell = /^\/api\/v1\/chat\/sessions\/([^/]+)\/shell$/.exec(p);
			if (wsShell) {
				const data: SocketData = {
					topic: `shell:${wsShell[1]}`,
					shellSessionId: wsShell[1]!,
				};
				if (srv.upgrade(req, { data })) return undefined;
				return errorResponse("UPGRADE_REQUIRED", "WebSocket upgrade required", 426);
			}
			// @deprecated Phase 5A — the /rpc WS pipes NDJSON to omp --mode rpc-ui.
			// Kept as fallback while the PTY transport bakes; new consumers should
			// use `/api/v1/chat/sessions/{id}/pty` (binary) instead. Removed in
			// Phase 5B after ≥ 1 week stability on PTY.
			const wsChat = /^\/api\/v1\/chat\/sessions\/([^/]+)\/rpc$/.exec(p);
			if (wsChat) {
				// On reconnect the client passes `?since=<seq>` so we replay only the
				// envelopes it hasn't seen yet (dedup). Absent/0 → full replay.
				const sinceRaw = url.searchParams.get("since");
				const since = sinceRaw !== null ? Number(sinceRaw) : Number.NaN;
				const data: SocketData = {
					topic: `chat:${wsChat[1]}`,
					chatSessionId: wsChat[1]!,
					...(Number.isFinite(since) && since > 0 ? { sinceSeq: since } : {}),
				};
				if (srv.upgrade(req, { data })) return undefined;
				return errorResponse("UPGRADE_REQUIRED", "WebSocket upgrade required", 426);
			}
			const wsPty = /^\/api\/v1\/chat\/sessions\/([^/]+)\/pty$/.exec(p);
			if (wsPty) {
				const sinceRaw = url.searchParams.get("since");
				const since = sinceRaw !== null ? Number(sinceRaw) : Number.NaN;
				const data: SocketData = {
					topic: `pty:${wsPty[1]}`,
					ptySessionId: wsPty[1]!,
					...(Number.isFinite(since) && since > 0 ? { sinceSeq: since } : {}),
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
			// Phase 4 read/manage surfaces
			if (p === "/api/v1/mcp" || p.startsWith("/api/v1/mcp/")) return handleMcp(req, url);
			if (p === "/api/v1/usage") return handleUsage(req, url);
			if (p === "/api/v1/fs") return handleFs(ctx, req, url);
			if (p === "/api/v1/diff") return handleDiff(ctx, req, url);

			return errorResponse("NOT_FOUND", `No route for ${req.method} ${p}`, 404);
		},
		websocket: {
			// Bun closes idle sockets after `idleTimeout` seconds (default 120). The
			// agent can "think" far longer than that without emitting a frame, so we
			// also send protocol-level pings to keep the socket warm server→client.
			// The browser auto-pongs; the client adds an app-level ping for the
			// reverse direction (browsers can't send protocol pings manually).
			idleTimeout: 120,
			sendPings: true,
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
					const unsub = omp.subscribe(id, envelope => ws.send(JSON.stringify(envelope)), ws.data.sinceSeq);
					subscribers.set(ws, unsub);
				}
				if (ws.data.ptySessionId) {
					const id = ws.data.ptySessionId;
					if (!ompPty.get(id)) {
						// TEXT control frame so the client can disambiguate from PTY bytes
						// (everything else on this WS is binary).
						ws.send(JSON.stringify({ type: "error", message: "pty session not started" }));
						ws.close(4404, "pty session not started");
						return;
					}
					const unsub = ompPty.subscribe(
						id,
						envelope => {
							// chunk → binary frame so xterm.js/ghostty-web sees raw bytes.
							// Anything else (exit/error/respawning) → small JSON control TEXT.
							if (envelope.type === "chunk" && envelope.data) {
								try {
									ws.send(envelope.data);
								} catch {
									/* socket closed mid-send */
								}
								return;
							}
							try {
								ws.send(
									JSON.stringify({
										type: envelope.type,
										seq: envelope.seq,
										ts: envelope.ts,
										exitCode: envelope.exitCode,
										cancelled: envelope.cancelled,
										timedOut: envelope.timedOut,
										message: envelope.message,
										attempt: envelope.attempt,
									}),
								);
							} catch {
								/* socket closed mid-send */
							}
						},
						ws.data.sinceSeq,
					);
					subscribers.set(ws, unsub);
				}
			},
			close(ws): void {
				subscribers.get(ws)?.();
				subscribers.delete(ws);
			},
			message(ws, raw): void {
				// PTY input path is binary-first: keystrokes come in as raw bytes from
				// xterm.js/ghostty-web's `onData(d => ws.send(d))`. We forward them to
				// the PtySession unchanged. JSON-shaped TEXT on this socket is a small
				// control channel (resize, ping); we route it through the JSON branch
				// below after stringifying the buffer.
				if (ws.data.ptySessionId) {
					if (typeof raw !== "string") {
						const text = new TextDecoder().decode(raw);
						ompPty.write(ws.data.ptySessionId, text);
						return;
					}
					// TEXT on PTY socket = control frame (resize, ping). Parse, dispatch,
					// done. Never forward plain text to the PTY — that would type literal
					// JSON into the agent.
					let ctrl: Record<string, unknown>;
					try {
						ctrl = JSON.parse(raw) as Record<string, unknown>;
					} catch {
						return;
					}
					if (ctrl.type === "ping") {
						ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
						return;
					}
					if (ctrl.type === "resize") {
						const cols = Number(ctrl.cols);
						const rows = Number(ctrl.rows);
						if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
							ompPty.resize(ws.data.ptySessionId, cols, rows);
						}
						return;
					}
					return;
				}

				const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
				let frame: Record<string, unknown>;
				try {
					frame = JSON.parse(text) as Record<string, unknown>;
				} catch {
					ws.send(JSON.stringify({ type: "error", message: "malformed JSON" }));
					return;
				}

				// App-level heartbeat: the browser can't send protocol-level pings, so
				// the client emits {type:"ping"} and we echo a pong. Never forward this
				// down to the omp child — it doesn't understand the frame.
				if (frame.type === "ping") {
					ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
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
							try {
								ws.send(JSON.stringify({ type: "chunk", data: chunk }));
							} catch {
								/* closed */
							}
						},
					}).then(result => {
						if (!hidden && result.output && ws.data.shellSessionId) {
							const contextMsg = `User ran: \`${command}\`\nOutput:\n\`\`\`\n${result.output.slice(0, 8000)}\n\`\`\`\nExit code: ${result.exitCode ?? "unknown"}`;
							omp.send(ws.data.shellSessionId, {
								id: `bridge-shell-${Date.now()}`,
								type: "prompt",
								message: contextMsg,
							});
						}
						try {
							ws.send(JSON.stringify({ type: "exit", exitCode: result.exitCode, cancelled: result.cancelled }));
							ws.close(1000, "done");
						} catch {
							/* closed */
						}
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
	console.log(`[desktop-bridge] relay:      ${relay.url}`);

	return {
		url,
		async stop(): Promise<void> {
			await ompPty.shutdown();
			await omp.shutdown();
			launcher.shutdown();
			relay.stop();
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
