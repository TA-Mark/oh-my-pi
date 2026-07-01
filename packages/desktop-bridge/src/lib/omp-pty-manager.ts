/**
 * OmpPtyManager — one PTY-backed omp TUI process per chat session.
 *
 * Mirrors {@link OmpSessionManager} (the rpc-ui process supervisor) but
 * speaks bytes instead of NDJSON. We keep the same supervisor contract —
 * idempotent start, intentional stop, crash respawn with exponential
 * backoff, and a bounded recent buffer for reconnects — so the bridge's
 * existing session lifecycle endpoints can switch transports without
 * rewriting their orchestration.
 *
 * Key differences from rpc-ui supervisor:
 *   - No frame parsing: chunks are raw PTY bytes (already re-encoded to
 *     Uint8Array by {@link OmpPtyProcess}).
 *   - Recent buffer is sized by bytes (default 256 KiB) rather than frame
 *     count, because a single ANSI scroll can emit hundreds of small writes.
 *     On reconnect we replay the tail so xterm.js/ghostty-web has something
 *     to render before the next write lands.
 *   - sessionFile is not snooped from the stream (the TUI writes the file
 *     itself); callers persist bindings via the shared {@link SessionBindingStore}.
 */

import type { BridgeConfig } from "./config";
import { OmpPtyProcess, type OmpPtyResolution, type OmpPtySpawnOpts } from "./omp-pty-process";
import type { SessionBindingStore } from "./session-binding";

/** Rolling tail size for reconnect replay. 256 KiB ≈ one full screen of ANSI. */
const REPLAY_BUFFER_BYTES = 256 * 1024;
/** Give up auto-respawning after this many consecutive fast crashes. */
const MAX_RESPAWN_ATTEMPTS = 5;
/** A child alive at least this long before dying isn't part of a crash loop. */
const STABLE_UPTIME_MS = 30_000;
/**
 * How long we wait after the LAST PTY chunk before sending `/collab start`.
 * OMP's boot animation (`splash-screen`) writes for ~5-6s on a warm host and
 * ignores any input queued during that window. Rather than pick a fixed
 * delay, we wait for the byte stream to fall quiet for {@link COLLAB_QUIESCE_MS}
 * — a reliable "editor is ready" signal.
 */
const COLLAB_QUIESCE_MS = 800;
/** Absolute cap on how long we'll wait for quiescence before sending anyway. */
const COLLAB_AUTOSTART_FALLBACK_MS = 15_000;
/** Cap on the rolling scan buffer we keep per session while hunting for the collab link. */
const COLLAB_SCAN_BUFFER_MAX_BYTES = 16 * 1024;
/** ROOM_KEY_BYTES from @oh-my-pi/pi-wire — the AES-256-GCM room key is 32 bytes. */
const COLLAB_ROOM_KEY_BYTES = 32;
/** WRITE_TOKEN_BYTES from pi-wire — 16-byte capability that grants prompt/abort rights. */
const COLLAB_WRITE_TOKEN_BYTES = 16;

/**
 * Strip terminal escape sequences from `text` so the collab link regex can
 * match plaintext even when the TUI wraps it in OSC 8 hyperlinks and SGR
 * color codes.
 *
 * Handles the two families OMP actually emits:
 *   - CSI: `\x1b[<params>@..~`  (SGR, cursor moves, erase)
 *   - OSC: `\x1b]<params><ST>`  where ST is either BEL (0x07) or ESC\ (0x1b 0x5c)
 * We don't try to preserve semantics; we just want a clean stream to grep.
 */
function stripAnsi(text: string): string {
	return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g, "");
}

export interface OmpPtyEnvelope {
	type: "chunk" | "exit" | "respawning" | "error";
	/** Raw PTY bytes (for type=chunk). */
	data?: Uint8Array;
	/** Exit code (for type=exit). */
	exitCode?: number | null;
	cancelled?: boolean;
	timedOut?: boolean;
	/** Diagnostic message (for type=error or type=respawning). */
	message?: string;
	/** Respawn attempt number (1-indexed, for type=respawning). */
	attempt?: number;
	ts: string;
	/** Monotonic per-session sequence. Lets a reconnecting WS skip frames it already saw. */
	seq: number;
}

export interface OmpPtySessionSnapshot {
	id: string;
	running: boolean;
	resolution: OmpPtyResolution;
	startedAt: string | null;
	exitedAt: string | null;
	exitCode: number | null;
	cols: number;
	rows: number;
}

type Listener = (envelope: OmpPtyEnvelope) => void;

interface SessionRecord {
	id: string;
	proc: OmpPtyProcess;
	startedAt: string | null;
	exitedAt: string | null;
	exitCode: number | null;
	listeners: Set<Listener>;
	/** Rolling byte tail; oldest dropped when total exceeds REPLAY_BUFFER_BYTES. */
	recent: OmpPtyEnvelope[];
	recentBytes: number;
	seqCounter: number;
	/** Opts from the original start(); reused on respawn (env + cwd persist). */
	spawnOpts: OmpPtySpawnOpts;
	/** Set true by stop() so the exit handler knows the death was intentional. */
	intentionalStop: boolean;
	/** Consecutive fast-crash count; reset once a child stays up past STABLE_UPTIME_MS. */
	respawnAttempt: number;
	spawnedAtMs: number;
	respawnTimer: ReturnType<typeof setTimeout> | null;
	cols: number;
	rows: number;
	// ─── /collab autostart state (Phase 0.3) ─────────────────────────────────
	/** True once the autostart command was written into PTY stdin. */
	collabIssued: boolean;
	/** Set once we found and computed the view link from PTY output. */
	collabViewLink: string | null;
	/** Handles for the fallback + post-first-chunk delays; cleared on stop/respawn. */
	collabAutostartFallbackTimer: ReturnType<typeof setTimeout> | null;
	collabAutostartFirstChunkTimer: ReturnType<typeof setTimeout> | null;
	collabFirstChunkSeen: boolean;
	/** Rolling text scan buffer, ANSI-stripped, capped at COLLAB_SCAN_BUFFER_MAX_BYTES. */
	collabScanBuffer: string;
}

export class OmpPtyManager {
	private readonly sessions = new Map<string, SessionRecord>();

	constructor(
		private readonly config: BridgeConfig,
		readonly bindings: SessionBindingStore,
	) {}

	async start(id: string, opts: OmpPtySpawnOpts = {}): Promise<OmpPtySessionSnapshot> {
		let rec = this.sessions.get(id);
		if (rec?.proc.running) return this.snapshotOf(rec);

		const cols = opts.cols ?? 120;
		const rows = opts.rows ?? 32;
		rec = {
			id,
			proc: null as unknown as OmpPtyProcess,
			startedAt: new Date().toISOString(),
			exitedAt: null,
			exitCode: null,
			listeners: new Set(),
			recent: [],
			recentBytes: 0,
			seqCounter: 0,
			spawnOpts: opts,
			intentionalStop: false,
			respawnAttempt: 0,
			spawnedAtMs: 0,
			respawnTimer: null,
			cols,
			rows,
			collabIssued: false,
			collabViewLink: null,
			collabAutostartFallbackTimer: null,
			collabAutostartFirstChunkTimer: null,
			collabFirstChunkSeen: false,
			collabScanBuffer: "",
		};
		this.sessions.set(id, rec);

		await this.spawnProc(rec, opts.extraArgs);
		return this.snapshotOf(rec);
	}

	/**
	 * Create a fresh OmpPtyProcess for `rec`, wire its listeners, start it.
	 * Reused by both start() and the crash respawn path so wiring stays in one
	 * place. A new OmpPtyProcess has empty listener sets, so there's no
	 * stale-listener leak across respawns.
	 */
	private async spawnProc(rec: SessionRecord, extraArgs?: string[]): Promise<void> {
		const opts = rec.spawnOpts;
		const proc = new OmpPtyProcess({
			cwd: opts.cwd ?? this.config.installDir,
			env: opts.env,
			repoRoot: opts.repoRoot,
			...(opts.command ? { command: opts.command } : {}),
			cols: rec.cols,
			rows: rec.rows,
		});
		rec.proc = proc;

		proc.onChunk(data => {
			this.publish(rec, { type: "chunk", data, ts: new Date().toISOString(), seq: 0 });
			this.handleChunkForCollab(rec, data);
		});
		proc.onError(err =>
			this.publish(rec, { type: "error", message: err.message, ts: new Date().toISOString(), seq: 0 }),
		);
		proc.onExit(result => this.handleExit(rec, result));

		await proc.start({
			cwd: opts.cwd ?? this.config.installDir,
			env: opts.env,
			repoRoot: opts.repoRoot,
			...(extraArgs ? { extraArgs } : {}),
			cols: rec.cols,
			rows: rec.rows,
		});
		rec.spawnedAtMs = Date.now();
		this.armCollabAutostart(rec);
	}

	// ─── /collab autostart + link scrape (Phase 0.3) ─────────────────────────

	/**
	 * Send `/collab start ws://127.0.0.1:<port>` into PTY stdin once the TUI
	 * looks ready. Two triggers race, whichever fires first wins:
	 *   - {@link COLLAB_AUTOSTART_AFTER_FIRST_CHUNK_MS} after the very first
	 *     PTY chunk arrives (best case — the TUI is drawing).
	 *   - {@link COLLAB_AUTOSTART_FALLBACK_MS} after spawn regardless. Protects
	 *     against a startup where the TUI writes nothing before the input
	 *     prompt appears.
	 *
	 * Idempotent: `collabIssued` guards against double writes if `handleExit`
	 * re-arms during a respawn window.
	 */
	private armCollabAutostart(rec: SessionRecord): void {
		if (rec.collabIssued) return;
		const relayUrl = `ws://127.0.0.1:${this.config.relayPort}`;
		const cmd = `/collab start ${relayUrl}\r`;
		const send = (): void => {
			if (rec.collabIssued) return;
			if (rec.collabAutostartFallbackTimer) clearTimeout(rec.collabAutostartFallbackTimer);
			if (rec.collabAutostartFirstChunkTimer) clearTimeout(rec.collabAutostartFirstChunkTimer);
			rec.collabAutostartFallbackTimer = null;
			rec.collabAutostartFirstChunkTimer = null;
			if (!rec.proc.running) return;
			rec.proc.write(cmd);
			rec.collabIssued = true;
		};
		rec.collabAutostartFallbackTimer = setTimeout(send, COLLAB_AUTOSTART_FALLBACK_MS);
	}

	/**
	 * Chunk hook: (a) trigger the first-chunk delayed send if we haven't yet,
	 * (b) feed the rolling scan buffer, (c) attempt to extract the view link.
	 */
	private handleChunkForCollab(rec: SessionRecord, chunk: Uint8Array): void {
		if (!rec.collabFirstChunkSeen) rec.collabFirstChunkSeen = true;
		// Reset the quiescence timer on every chunk. When the stream falls quiet
		// for {@link COLLAB_QUIESCE_MS}, we know the boot animation settled and
		// the TUI's input controller is running — safe to inject `/collab start`.
		//
		// NOTE (Windows blocker, 2026-07-01): the injected slash command is not
		// yet observed to reach the TUI's input controller on Windows/ConPTY.
		// See `memory/project-pty-collab-migration.md` for the investigation
		// and workaround plan. The autostart path stays wired because it is
		// correct on Linux/macOS PTYs and correct on Windows once the input
		// path is fixed.
		if (!rec.collabIssued) {
			if (rec.collabAutostartFirstChunkTimer) clearTimeout(rec.collabAutostartFirstChunkTimer);
			rec.collabAutostartFirstChunkTimer = setTimeout(() => {
				rec.collabAutostartFirstChunkTimer = null;
				if (rec.collabIssued || !rec.proc.running) return;
				if (rec.collabAutostartFallbackTimer) clearTimeout(rec.collabAutostartFallbackTimer);
				rec.collabAutostartFallbackTimer = null;
				const relayUrl = `ws://127.0.0.1:${this.config.relayPort}`;
				rec.proc.write(`/collab start ${relayUrl}\r`);
				rec.collabIssued = true;
			}, COLLAB_QUIESCE_MS);
		}
		if (rec.collabViewLink) return;
		if (!rec.collabIssued) return;
		this.scanForCollabLink(rec, chunk);
	}

	/**
	 * Look for the full collab link OMP prints after `/collab start` succeeds.
	 * The format (from `packages/coding-agent/src/collab/protocol.ts:188-198`)
	 * for a non-default local relay is `ws://127.0.0.1:<port>/r/<roomId>.<b64url>`
	 * where the secret decodes to 48 bytes (32-byte room key + 16-byte write
	 * token). We take the first 32 bytes as the view key and re-encode to
	 * produce the read-only link — protocol-layer single-writer enforcement,
	 * no accidental prompt injection from React.
	 */
	private scanForCollabLink(rec: SessionRecord, chunk: Uint8Array): void {
		const text = new TextDecoder("utf-8", { fatal: false }).decode(chunk);
		let buf = rec.collabScanBuffer + stripAnsi(text);
		if (buf.length > COLLAB_SCAN_BUFFER_MAX_BYTES) {
			buf = buf.slice(-COLLAB_SCAN_BUFFER_MAX_BYTES);
		}
		rec.collabScanBuffer = buf;

		const port = this.config.relayPort;
		// Also match bare-relay form (`127.0.0.1:PORT/r/…`) that OMP prints when
		// the relay scheme was `wss:` — we forced ws:// but OMP's link formatter
		// strips the scheme for non-default relays. Cover both defensively.
		const re = new RegExp(`(?:ws://)?127\\.0\\.0\\.1:${port}/r/([A-Za-z0-9_-]{10,64})\\.([A-Za-z0-9_-]+)`);
		const match = re.exec(buf);
		if (!match) return;
		const roomId = match[1] as string;
		const secretB64 = match[2] as string;
		let secret: Buffer;
		try {
			secret = Buffer.from(secretB64, "base64url");
		} catch {
			return;
		}
		if (
			secret.byteLength !== COLLAB_ROOM_KEY_BYTES + COLLAB_WRITE_TOKEN_BYTES &&
			secret.byteLength !== COLLAB_ROOM_KEY_BYTES
		) {
			// Unrecognized key length — either a partial base64 read at the buffer
			// boundary or a format change. Wait for more bytes.
			return;
		}
		const viewKey = secret.subarray(0, COLLAB_ROOM_KEY_BYTES);
		const viewKeyB64 = viewKey.toString("base64url");
		rec.collabViewLink = `ws://127.0.0.1:${port}/r/${roomId}.${viewKeyB64}`;
		// Scan buffer no longer needed — free the memory.
		rec.collabScanBuffer = "";
	}

	/** Read-only view link for a session, once the autostart output has been scraped. */
	getCollabLink(id: string): string | null {
		return this.sessions.get(id)?.collabViewLink ?? null;
	}

	/** Reset collab state for a session (called on stop and on respawn). */
	private resetCollabState(rec: SessionRecord): void {
		if (rec.collabAutostartFallbackTimer) clearTimeout(rec.collabAutostartFallbackTimer);
		if (rec.collabAutostartFirstChunkTimer) clearTimeout(rec.collabAutostartFirstChunkTimer);
		rec.collabAutostartFallbackTimer = null;
		rec.collabAutostartFirstChunkTimer = null;
		rec.collabIssued = false;
		rec.collabViewLink = null;
		rec.collabFirstChunkSeen = false;
		rec.collabScanBuffer = "";
	}

	/**
	 * Distinguish three exit cases (same shape as the rpc manager):
	 *   - intentional stop()  → publish exit, no respawn
	 *   - clean exit (code 0) → publish exit, no respawn (user typed /exit)
	 *   - crash               → respawn with --resume + exponential backoff
	 * A child that stayed up past STABLE_UPTIME_MS resets the attempt counter,
	 * so only fast repeated crashes count toward MAX_RESPAWN_ATTEMPTS.
	 */
	private handleExit(
		rec: SessionRecord,
		result: { exitCode: number | null; cancelled: boolean; timedOut: boolean },
	): void {
		rec.exitedAt = new Date().toISOString();
		rec.exitCode = result.exitCode;

		const uptime = rec.spawnedAtMs > 0 ? Date.now() - rec.spawnedAtMs : 0;
		if (uptime > STABLE_UPTIME_MS) rec.respawnAttempt = 0;

		const crashed = !rec.intentionalStop && (result.exitCode === null ? true : result.exitCode !== 0);
		if (!crashed) {
			this.publish(rec, {
				type: "exit",
				exitCode: result.exitCode,
				cancelled: result.cancelled,
				timedOut: result.timedOut,
				ts: rec.exitedAt,
				seq: 0,
			});
			return;
		}

		if (rec.respawnAttempt >= MAX_RESPAWN_ATTEMPTS) {
			this.publish(rec, {
				type: "error",
				message: `omp crashed ${rec.respawnAttempt} times — giving up. Use Reconnect to retry.`,
				ts: new Date().toISOString(),
				seq: 0,
			});
			this.publish(rec, {
				type: "exit",
				exitCode: result.exitCode,
				cancelled: result.cancelled,
				timedOut: result.timedOut,
				ts: rec.exitedAt,
				seq: 0,
			});
			return;
		}

		const attempt = rec.respawnAttempt++;
		const delay = Math.min(1000 * 2 ** attempt, 15000);
		const binding = this.bindings.get(rec.id);
		const resumeArgs = binding?.sessionFile ? ["--resume", binding.sessionFile] : undefined;
		this.publish(rec, {
			type: "respawning",
			attempt: attempt + 1,
			message: `omp exited (code=${result.exitCode ?? "killed"}) — restarting in ${delay}ms`,
			ts: new Date().toISOString(),
			seq: 0,
		});

		if (rec.respawnTimer) clearTimeout(rec.respawnTimer);
		rec.respawnTimer = setTimeout(() => {
			rec.respawnTimer = null;
			// Session may have been stopped/deleted while we waited.
			if (!this.sessions.has(rec.id) || rec.intentionalStop) return;
			// Fresh omp process = fresh collab room. Clear state so the next
			// spawnProc auto-issues /collab start with a new room + scrapes a new
			// view link; existing React clients poll the endpoint and pick up the
			// new link when their old GuestClient sees the "room closed" event.
			this.resetCollabState(rec);
			this.spawnProc(rec, resumeArgs).catch(err => {
				this.publish(rec, {
					type: "error",
					message: `respawn failed: ${err instanceof Error ? err.message : String(err)}`,
					ts: new Date().toISOString(),
					seq: 0,
				});
				// Re-enter handleExit semantics so backoff/giving-up still applies.
				this.handleExit(rec, { exitCode: null, cancelled: false, timedOut: false });
			});
		}, delay);
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
		// Clear any pending collab autostart timers so we don't leak them when
		// the session goes away between spawn and first-chunk.
		this.resetCollabState(rec);
		await rec.proc.stop();
		this.sessions.delete(id);
		return true;
	}

	write(id: string, data: string): boolean {
		const rec = this.sessions.get(id);
		if (!rec) return false;
		return rec.proc.write(data);
	}

	resize(id: string, cols: number, rows: number): boolean {
		const rec = this.sessions.get(id);
		if (!rec) return false;
		rec.cols = cols;
		rec.rows = rows;
		return rec.proc.resize(cols, rows);
	}

	get(id: string): OmpPtySessionSnapshot | null {
		const rec = this.sessions.get(id);
		return rec ? this.snapshotOf(rec) : null;
	}

	list(): OmpPtySessionSnapshot[] {
		return Array.from(this.sessions.values()).map(r => this.snapshotOf(r));
	}

	/**
	 * Subscribe to a session's byte stream. On reconnect pass the last seq the
	 * client already saw — only envelopes with `seq > sinceSeq` are replayed.
	 * Omit `sinceSeq` (first connect) to replay the whole rolling tail.
	 */
	subscribe(id: string, listener: Listener, sinceSeq?: number): () => void {
		const rec = this.sessions.get(id);
		if (!rec) return () => {};
		for (const env of rec.recent) {
			if (sinceSeq === undefined || env.seq > sinceSeq) listener(env);
		}
		rec.listeners.add(listener);
		return () => rec.listeners.delete(listener);
	}

	async shutdown(): Promise<void> {
		const ids = Array.from(this.sessions.keys());
		await Promise.all(ids.map(id => this.stop(id)));
	}

	private publish(rec: SessionRecord, envelope: OmpPtyEnvelope): void {
		envelope.seq = ++rec.seqCounter;
		rec.recent.push(envelope);
		const size = envelope.data?.byteLength ?? 0;
		rec.recentBytes += size;
		// Trim oldest entries until we are under the byte cap. Always keep at
		// least one entry so subscribers see *something* on first attach.
		while (rec.recent.length > 1 && rec.recentBytes > REPLAY_BUFFER_BYTES) {
			const oldest = rec.recent.shift();
			rec.recentBytes -= oldest?.data?.byteLength ?? 0;
		}
		for (const l of rec.listeners) {
			try {
				l(envelope);
			} catch {
				/* ignore */
			}
		}
	}

	private snapshotOf(rec: SessionRecord): OmpPtySessionSnapshot {
		return {
			id: rec.id,
			running: rec.proc?.running ?? false,
			resolution: rec.proc?.resolution ?? { exe: "", args: [], source: "not-found" },
			startedAt: rec.startedAt,
			exitedAt: rec.exitedAt,
			exitCode: rec.exitCode,
			cols: rec.cols,
			rows: rec.rows,
		};
	}
}
