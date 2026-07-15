/**
 * Interactive PTY registry for RPC mode.
 *
 * Unlike the one-shot `bash` command (a non-interactive command runner that
 * returns captured output once), this drives persistent pseudo-terminals with a
 * real controlling TTY — so REPLs and full-screen TUIs (claude, codex, python,
 * vim, …) behave exactly as in a normal terminal.
 *
 * Each session is created by a client `pty_start` and keyed by the
 * client-supplied `ptyId`. Output and exit are pushed asynchronously as
 * `pty_data`/`pty_exit` frames (never as the command response, which is a bare
 * ack) via the same untyped `output()` writer used for session events. Input,
 * resize, and kill look the session up by `ptyId`.
 */
import { PtySession } from "@oh-my-pi/pi-natives";
import type { RpcPtyDataFrame, RpcPtyExitFrame } from "./rpc-types";

type RpcPtyOutput = (frame: RpcPtyDataFrame | RpcPtyExitFrame) => void;

export interface RpcPtyStartOptions {
	command: string;
	cwd?: string;
	env?: Record<string, string>;
	cols: number;
	rows: number;
	shell?: string;
}

export class RpcPtyRegistry {
	#sessions = new Map<string, PtySession>();
	#output: RpcPtyOutput;

	constructor(output: RpcPtyOutput) {
		this.#output = output;
	}

	/**
	 * Spawn a PTY session. Returns immediately; output streams via `pty_data`
	 * frames and the terminal's end arrives as a single `pty_exit` frame. A spawn
	 * failure is reported through `pty_exit` with `error` set rather than thrown,
	 * so the client always sees a terminal lifecycle for every `ptyId` it starts.
	 */
	start(ptyId: string, options: RpcPtyStartOptions): void {
		if (this.#sessions.has(ptyId)) {
			throw new Error(`pty session already exists: ${ptyId}`);
		}
		const session = new PtySession();
		this.#sessions.set(ptyId, session);
		void session
			.start(
				{
					command: options.command,
					cwd: options.cwd,
					// Inherit the engine process environment (the native side applies
					// these as overrides) with a real TERM so editors/pagers/TUIs render
					// correctly. Deliberately NOT the non-interactive shell env (no
					// CI=1/TERM=dumb) — that is what makes claude & friends refuse the REPL.
					env: {
						TERM: "xterm-256color",
						...options.env,
					},
					cols: options.cols,
					rows: options.rows,
					shell: options.shell,
				},
				(err, chunk) => {
					// Per-chunk errors are surfaced through the exit frame; a live chunk
					// error just means this read yielded nothing to forward.
					if (err) return;
					this.#output({ type: "pty_data", ptyId, chunk });
				},
			)
			.then(run => {
				this.#output({
					type: "pty_exit",
					ptyId,
					exitCode: run.exitCode,
					cancelled: run.cancelled,
					timedOut: run.timedOut,
				});
			})
			.catch((err: unknown) => {
				this.#output({
					type: "pty_exit",
					ptyId,
					cancelled: false,
					timedOut: false,
					error: err instanceof Error ? err.message : String(err),
				});
			})
			.finally(() => {
				this.#sessions.delete(ptyId);
			});
	}

	/** Forward raw input bytes to the session's stdin (no-op if it ended). */
	write(ptyId: string, data: string): void {
		const session = this.#sessions.get(ptyId);
		if (!session) return;
		try {
			session.write(data);
		} catch {
			// Session may have exited between the client's keystroke and delivery.
		}
	}

	/** Resize the PTY (no-op if the session ended). */
	resize(ptyId: string, cols: number, rows: number): void {
		const session = this.#sessions.get(ptyId);
		if (!session) return;
		try {
			session.resize(cols, rows);
		} catch {
			// Ignore resizes after the command exits.
		}
	}

	/** Force-kill a session; its `pty_exit` frame fires from the start() promise. */
	kill(ptyId: string): void {
		const session = this.#sessions.get(ptyId);
		if (!session) return;
		try {
			session.kill();
		} catch {
			// Already gone.
		}
	}

	/** Kill every live session (engine shutdown / workspace switch). */
	killAll(): void {
		for (const session of this.#sessions.values()) {
			try {
				session.kill();
			} catch {
				// Already gone.
			}
		}
		this.#sessions.clear();
	}
}
