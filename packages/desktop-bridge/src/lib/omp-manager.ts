/**
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

export interface OmpFrameEnvelope {
	type: "frame" | "log" | "exit";
	frame?: unknown;
	line?: string;
	stream?: "stdout" | "stderr";
	code?: number | null;
	signal?: NodeJS.Signals | null;
	ts: string;
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

		const proc = new OmpProcess({
			cwd: opts.cwd ?? this.config.installDir,
			env: opts.env,
			repoRoot: opts.repoRoot,
			...(opts.command ? { command: opts.command } : {}),
		});
		rec = {
			id,
			proc,
			startedAt: new Date().toISOString(),
			exitedAt: null,
			exitCode: null,
			listeners: new Set(),
			recent: [],
		};
		this.sessions.set(id, rec);

		proc.onFrame(frame => {
			this.publish(rec!, { type: "frame", frame, ts: new Date().toISOString() });
			this.snoopSessionFile(id, frame);
		});
		proc.onLog((line, stream) => this.publish(rec!, { type: "log", line, stream, ts: new Date().toISOString() }));
		proc.onExit((code, signal) => {
			rec!.exitedAt = new Date().toISOString();
			rec!.exitCode = code;
			this.publish(rec!, { type: "exit", code, signal, ts: rec!.exitedAt });
		});

		await proc.start({
			cwd: opts.cwd ?? this.config.installDir,
			env: opts.env,
			repoRoot: opts.repoRoot,
			extraArgs: opts.extraArgs,
		});
		return this.snapshotOf(rec);
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

	subscribe(id: string, listener: Listener, replay = true): () => void {
		const rec = this.sessions.get(id);
		if (!rec) return () => {};
		if (replay) for (const env of rec.recent) listener(env);
		rec.listeners.add(listener);
		return () => rec.listeners.delete(listener);
	}

	async shutdown(): Promise<void> {
		const ids = Array.from(this.sessions.keys());
		await Promise.all(ids.map(id => this.stop(id)));
	}

	private publish(rec: SessionRecord, envelope: OmpFrameEnvelope): void {
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
