/**
 * @deprecated (Phase 5A, marked 2026-07-01) — superseded by {@link OmpPtyManager}.
 *
 * Kept as a rollback path while the new PTY+Collab transport bakes. Phase 5B
 * removes this manager, the paired {@link OmpProcess}, and the
 * `/api/v1/chat/sessions/{id}/rpc` WebSocket in `server.ts` once the new
 * pipeline has ≥ 1 week of stable operation.
 *
 * New code MUST NOT reach for `ctx.omp` — use `ctx.ompPty` and the PTY
 * routes (`/start-pty`, `/stop-pty`, `/state-pty`, `/input`) added in Phase
 * 0.1. The two managers currently share `ctx.omp.bindings` so sessions
 * created here can still resume under PTY (and vice-versa).
 *
 * ─── original description ──────────────────────────────────────────────────
 * OmpSessionManager — one omp child per chat session.
 *
 * - start(id, opts): spawn the child (idempotent) and register the session
 * - stop(id):       kill the child + drop session
 * - send(id, frame): forward an RpcCommand to the child's stdin
 * - subscribe(id, listener): receive every frame/log from the child
 *
 * A bounded recent-frame buffer per session lets a reconnecting WS catch up
 * without forcing the agent to re-emit state.
 */

import type { BridgeConfig } from "./config";
import { OmpProcess, type OmpResolution, type OmpSpawnOpts } from "./omp-process";
import { SessionBindingStore } from "./session-binding";

const REPLAY_BUFFER = 64;
/** Give up auto-respawning after this many consecutive fast crashes. */
const MAX_RESPAWN_ATTEMPTS = 5;
/** A child alive at least this long before dying isn't part of a crash loop. */
const STABLE_UPTIME_MS = 30_000;

export interface OmpFrameEnvelope {
	type: "frame" | "log" | "exit" | "respawning";
	frame?: unknown;
	line?: string;
	stream?: "stdout" | "stderr";
	code?: number | null;
	signal?: NodeJS.Signals | null;
	ts: string;
	/** Monotonic per-session sequence. Lets a reconnecting WS skip frames it already saw. */
	seq?: number;
	/** Respawn attempt number (only on `respawning` envelopes). */
	attempt?: number;
}

export interface OmpSessionSnapshot {
	id: string;
	running: boolean;
	pid: number | null;
	resolution: OmpResolution;
	startedAt: string | null;
	exitedAt: string | null;
	exitCode: number | null;
}

type Listener = (envelope: OmpFrameEnvelope) => void;

interface SessionRecord {
	id: string;
	proc: OmpProcess;
	startedAt: string | null;
	exitedAt: string | null;
	exitCode: number | null;
	listeners: Set<Listener>;
	recent: OmpFrameEnvelope[];
	seqCounter: number;
	/** Opts from the original start(), reused verbatim on respawn (keeps env/API keys). */
	spawnOpts: OmpSpawnOpts;
	/** Set true by stop() so the exit handler knows the death was intentional. */
	intentionalStop: boolean;
	/** Consecutive fast-crash count; reset once a child stays up past STABLE_UPTIME_MS. */
	respawnAttempt: number;
	/** Epoch ms the current child was spawned — used to detect crash loops. */
	spawnedAtMs: number;
	respawnTimer: ReturnType<typeof setTimeout> | null;
}

export class OmpSessionManager {
	private readonly sessions = new Map<string, SessionRecord>();
	readonly bindings: SessionBindingStore;

	constructor(private readonly config: BridgeConfig) {
		this.bindings = new SessionBindingStore(config.stateDir);
	}

	async start(id: string, opts: OmpSpawnOpts = {}): Promise<OmpSessionSnapshot> {
		let rec = this.sessions.get(id);
		if (rec?.proc.running) return this.snapshotOf(rec);

		rec = {
			id,
			proc: null as unknown as OmpProcess, // assigned by spawnProc below
			startedAt: new Date().toISOString(),
			exitedAt: null,
			exitCode: null,
			listeners: new Set(),
			recent: [],
			seqCounter: 0,
			spawnOpts: opts,
			intentionalStop: false,
			respawnAttempt: 0,
			spawnedAtMs: 0,
			respawnTimer: null,
		};
		this.sessions.set(id, rec);

		await this.spawnProc(rec, opts.extraArgs);
		return this.snapshotOf(rec);
	}

	/**
	 * Create a fresh OmpProcess for `rec`, wire its listeners, and start it. Reused
	 * by both start() and the crash-respawn path. A new OmpProcess has empty
	 * listener sets, so there's no stale-listener leak across respawns.
	 *
	 * On respawn (`resync`), the client's WS to the bridge never dropped, so its
	 * `open` handler won't re-fire to request state. We inject a `get_state` into
	 * the new child ourselves; the client rehydrates from the response (it routes
	 * get_state by command, not reqId), keeping model/mode in sync after a crash.
	 */
	private async spawnProc(rec: SessionRecord, extraArgs?: string[], resync = false): Promise<void> {
		const opts = rec.spawnOpts;
		const proc = new OmpProcess({
			cwd: opts.cwd ?? this.config.installDir,
			env: opts.env,
			repoRoot: opts.repoRoot,
			...(opts.command ? { command: opts.command } : {}),
		});
		rec.proc = proc;

		proc.onFrame(frame => {
			this.publish(rec, { type: "frame", frame, ts: new Date().toISOString() });
			this.snoopSessionFile(rec.id, frame);
		});
		proc.onLog((line, stream) => this.publish(rec, { type: "log", line, stream, ts: new Date().toISOString() }));
		proc.onExit((code, signal) => this.handleExit(rec, code, signal));

		await proc.start({
			cwd: opts.cwd ?? this.config.installDir,
			env: opts.env,
			repoRoot: opts.repoRoot,
			...(extraArgs ? { extraArgs } : {}),
		});
		rec.spawnedAtMs = Date.now();
		if (resync) proc.send({ id: `bridge-resync-${Date.now()}`, type: "get_state" });
	}

	/**
	 * Exit handler shared by every spawn. Distinguishes three cases:
	 *  - intentional stop()         → publish exit, no respawn (session is being torn down)
	 *  - clean exit (code 0)        → publish exit, no respawn (omp finished normally)
	 *  - crash (non-zero/signal)    → respawn with --resume + exponential backoff
	 * A child that stayed up past STABLE_UPTIME_MS resets the attempt counter, so
	 * only *fast* repeated crashes count toward MAX_RESPAWN_ATTEMPTS.
	 */
	private handleExit(rec: SessionRecord, code: number | null, signal: NodeJS.Signals | null): void {
		rec.exitedAt = new Date().toISOString();
		rec.exitCode = code;

		const uptime = rec.spawnedAtMs > 0 ? Date.now() - rec.spawnedAtMs : 0;
		if (uptime > STABLE_UPTIME_MS) rec.respawnAttempt = 0;

		const crashed = !rec.intentionalStop && (code === null ? true : code !== 0);
		if (!crashed) {
			this.publish(rec, { type: "exit", code, signal, ts: rec.exitedAt });
			return;
		}

		if (rec.respawnAttempt >= MAX_RESPAWN_ATTEMPTS) {
			this.publish(rec, {
				type: "log",
				line: `omp crashed ${rec.respawnAttempt} times — giving up. Use Reconnect to retry.`,
				stream: "stderr",
				ts: new Date().toISOString(),
			});
			this.publish(rec, { type: "exit", code, signal, ts: rec.exitedAt });
			return;
		}

		const attempt = rec.respawnAttempt++;
		const delay = Math.min(1000 * 2 ** attempt, 15000);
		const binding = this.bindings.get(rec.id);
		const resumeArgs = binding?.sessionFile ? ["--resume", binding.sessionFile] : undefined;
		this.publish(rec, {
			type: "respawning",
			attempt: attempt + 1,
			line: `omp exited (code=${code ?? `signal:${signal}`}) — restarting in ${delay}ms`,
			ts: new Date().toISOString(),
		});

		if (rec.respawnTimer) clearTimeout(rec.respawnTimer);
		rec.respawnTimer = setTimeout(() => {
			rec.respawnTimer = null;
			// Session may have been stopped/deleted while we waited.
			if (!this.sessions.has(rec.id) || rec.intentionalStop) return;
			this.spawnProc(rec, resumeArgs, true).catch(err => {
				this.publish(rec, {
					type: "log",
					line: `respawn failed: ${err instanceof Error ? err.message : String(err)}`,
					stream: "stderr",
					ts: new Date().toISOString(),
				});
				// Re-enter handleExit semantics so backoff/giving-up still applies.
				this.handleExit(rec, null, null);
			});
		}, delay);
	}

	/**
	 * Pull the sessionFile out of any RpcResponse that carries one (get_state,
	 * set_session_name, etc.) and persist it as a binding for next /start.
	 */
	private snoopSessionFile(id: string, frame: unknown): void {
		if (!frame || typeof frame !== "object") return;
		const f = frame as { type?: string; data?: { sessionFile?: unknown } };
		if (f.type !== "response" || !f.data) return;
		const file = f.data.sessionFile;
		if (typeof file !== "string" || !file) return;
		const existing = this.bindings.get(id);
		if (existing?.sessionFile === file) return;
		this.bindings.set(id, file);
	}

	async stop(id: string): Promise<boolean> {
		const rec = this.sessions.get(id);
		if (!rec) return false;
		// Mark intentional so the exit handler doesn't treat this kill as a crash
		// and respawn. Cancel any pending respawn from an earlier crash too.
		rec.intentionalStop = true;
		if (rec.respawnTimer) {
			clearTimeout(rec.respawnTimer);
			rec.respawnTimer = null;
		}
		await rec.proc.stop();
		this.sessions.delete(id);
		return true;
	}

	send(id: string, frame: unknown): boolean {
		const rec = this.sessions.get(id);
		if (!rec) return false;
		return rec.proc.send(frame);
	}

	get(id: string): OmpSessionSnapshot | null {
		const rec = this.sessions.get(id);
		return rec ? this.snapshotOf(rec) : null;
	}

	list(): OmpSessionSnapshot[] {
		return Array.from(this.sessions.values()).map(r => this.snapshotOf(r));
	}

	/**
	 * Subscribe to a session's frame stream. On reconnect, pass the last seq the
	 * client already saw — only envelopes with `seq > sinceSeq` are replayed, so
	 * the client never re-renders frames it already has. Omit `sinceSeq` (first
	 * connect) to replay the whole recent buffer.
	 */
	subscribe(id: string, listener: Listener, sinceSeq?: number): () => void {
		const rec = this.sessions.get(id);
		if (!rec) return () => {};
		for (const env of rec.recent) {
			if (sinceSeq === undefined || (env.seq ?? 0) > sinceSeq) listener(env);
		}
		rec.listeners.add(listener);
		return () => rec.listeners.delete(listener);
	}

	async shutdown(): Promise<void> {
		const ids = Array.from(this.sessions.keys());
		await Promise.all(ids.map(id => this.stop(id)));
	}

	private publish(rec: SessionRecord, envelope: OmpFrameEnvelope): void {
		envelope.seq = ++rec.seqCounter;
		rec.recent.push(envelope);
		if (rec.recent.length > REPLAY_BUFFER) {
			rec.recent.splice(0, rec.recent.length - REPLAY_BUFFER);
		}
		for (const l of rec.listeners) {
			try {
				l(envelope);
			} catch {
				/* ignore */
			}
		}
	}

	private snapshotOf(rec: SessionRecord): OmpSessionSnapshot {
		return {
			id: rec.id,
			running: rec.proc.running,
			pid: rec.proc.pid ?? null,
			resolution: rec.proc.resolution,
			startedAt: rec.startedAt,
			exitedAt: rec.exitedAt,
			exitCode: rec.exitCode,
		};
	}
}
