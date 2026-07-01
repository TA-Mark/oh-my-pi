/**
 * OmpPtyProcess — wraps a single `omp` TUI child running inside a PTY.
 *
 * Why a second process class beside {@link OmpProcess}:
 *   `omp --mode rpc-ui` (the rpc class) is a structured NDJSON pipe; TUI is
 *   raw bytes. We keep both for now so the rpc-backed React UI stays alive
 *   while the PTY+collab path is rolled out panel-by-panel.
 *
 * Forwarding model:
 *   - stdin chunks come from a single owner (`write(data)`); the bridge's
 *     PTY WebSocket and the input-synthesis REST route both push through
 *     this method, never directly into the PtySession.
 *   - stdout bytes arrive as UTF-8 strings from the native PtySession's
 *     `onChunk` callback (pi-natives replaces invalid bytes with U+FFFD).
 *     We re-encode to bytes for the consumer so ANSI escapes survive
 *     binary-WS forwarding intact.
 *
 * Lifecycle:
 *   `PtySession.start()` returns a promise that resolves only when the PTY
 *   command exits. We keep a reference to that promise and convert its
 *   settlement into a single `onExit` notification. `stop()` calls
 *   `PtySession.kill()` and then awaits the run promise so we never leak the
 *   reader thread.
 *
 * Resolution order for the omp binary mirrors {@link OmpProcess}: opts.command
 * override → $OMP_BIN → PATH → monorepo dev (`bun run packages/coding-agent/src/cli.ts`).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { type PtyRunResult, PtySession } from "@oh-my-pi/pi-natives";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

export interface OmpPtySpawnOpts {
	/** Workspace cwd for the agent. Defaults to process.cwd(). */
	cwd?: string;
	/** Override the executable + args. Skips PATH/dev resolution. */
	command?: { exe: string; args: string[] };
	/** Extra env vars merged onto process.env. */
	env?: Record<string, string>;
	/** Repo root (used to find packages/coding-agent in dev mode). */
	repoRoot?: string;
	/** Args appended after the resolved omp argv, e.g. `["--resume", "<file>"]`. */
	extraArgs?: string[];
	/** Initial PTY size; default 120×32. The consumer can `resize()` later. */
	cols?: number;
	rows?: number;
}

export interface OmpPtyResolution {
	exe: string;
	args: string[];
	source: "override" | "env" | "path" | "dev" | "not-found";
}

type ChunkListener = (chunk: Uint8Array) => void;
type ErrorListener = (err: Error) => void;
type ExitListener = (result: { exitCode: number | null; cancelled: boolean; timedOut: boolean }) => void;

export class OmpPtyProcess {
	private session: PtySession | null = null;
	private runPromise: Promise<PtyRunResult> | null = null;
	private exitedWith: PtyRunResult | null = null;
	private readonly chunkListeners = new Set<ChunkListener>();
	private readonly errorListeners = new Set<ErrorListener>();
	private readonly exitListeners = new Set<ExitListener>();
	readonly resolution: OmpPtyResolution;

	constructor(opts: OmpPtySpawnOpts = {}) {
		this.resolution = resolveOmp(opts);
	}

	get running(): boolean {
		return this.session !== null && this.exitedWith === null;
	}

	async start(opts: OmpPtySpawnOpts = {}): Promise<void> {
		if (this.running) return;
		if (this.resolution.source === "not-found") {
			throw new Error("omp not found: install it or set OMP_BIN");
		}
		const extra = opts.extraArgs ?? [];
		const argv = [this.resolution.exe, ...this.resolution.args, ...extra];
		const isWindows = process.platform === "win32";
		const command = argv.map(a => quoteForShell(a, isWindows)).join(" ");
		// On Windows, `cmd.exe /c` uses the "console legacy" input pipe which
		// ConPTY doesn't always forward keystrokes through cleanly (typed chars
		// disappear before reaching the child's stdin). PowerShell's
		// `-Command` runs the child under a proper console handle inheritance
		// path and keeps interactive stdin working.
		const shell = isWindows ? "powershell.exe" : "sh";

		const session = new PtySession();
		this.session = session;
		this.exitedWith = null;

		const cols = opts.cols ?? DEFAULT_COLS;
		const rows = opts.rows ?? DEFAULT_ROWS;
		const env: Record<string, string> = {};
		// Merge process.env (string-typed only) so the child inherits PATH etc.
		for (const [k, v] of Object.entries(process.env)) {
			if (typeof v === "string") env[k] = v;
		}
		if (opts.env) Object.assign(env, opts.env);
		// TERM hint: the TUI checks this for color depth. xterm-256color is the
		// safe baseline both ghostty-web and @xterm/xterm decode the same way.
		if (!env.TERM) env.TERM = "xterm-256color";
		// Force OMP into non-interactive-friendly boot: skip the startup splash
		// (which redraws for ~6s and blocks input processing), disable the
		// changelog prompt, and skip update checks. These are all valid CLI
		// hints — no upstream change needed.
		if (!env.PI_QUIET) env.PI_QUIET = "1";

		const runPromise = session.start(
			{
				command,
				cwd: opts.cwd ?? process.cwd(),
				env,
				cols,
				rows,
				shell,
			},
			(err, chunk) => {
				if (err) {
					for (const l of this.errorListeners) {
						try {
							l(err);
						} catch {
							/* ignore listener errors */
						}
					}
					return;
				}
				if (!chunk) return;
				// pi-natives delivers a UTF-8 string with U+FFFD replacement for
				// invalid bytes. Re-encode so consumers see real bytes.
				const bytes = Buffer.from(chunk, "utf-8");
				for (const l of this.chunkListeners) {
					try {
						l(bytes);
					} catch {
						/* ignore listener errors */
					}
				}
			},
		);
		this.runPromise = runPromise;

		runPromise.then(
			result => this.notifyExit(result),
			err => {
				// PtySession.start rejects on setup failure (binary not found, PTY
				// open failure, etc.). Surface as both error and synthetic exit so
				// the manager's respawn logic engages.
				for (const l of this.errorListeners) {
					try {
						l(err instanceof Error ? err : new Error(String(err)));
					} catch {
						/* ignore */
					}
				}
				// PtyRunResult.exitCode is `number | undefined`; omit it on synthetic
				// "spawn failed" exits so we don't lie about a real process exit code.
				this.notifyExit({ cancelled: false, timedOut: false });
			},
		);
	}

	private notifyExit(result: PtyRunResult): void {
		if (this.exitedWith !== null) return;
		this.exitedWith = result;
		this.session = null;
		for (const l of this.exitListeners) {
			try {
				l({
					exitCode: result.exitCode ?? null,
					cancelled: result.cancelled,
					timedOut: result.timedOut,
				});
			} catch {
				/* ignore */
			}
		}
	}

	write(data: string): boolean {
		if (!this.session) return false;
		try {
			this.session.write(data);
			return true;
		} catch {
			return false;
		}
	}

	resize(cols: number, rows: number): boolean {
		if (!this.session) return false;
		try {
			this.session.resize(cols, rows);
			return true;
		} catch {
			return false;
		}
	}

	onChunk(listener: ChunkListener): () => void {
		this.chunkListeners.add(listener);
		return () => this.chunkListeners.delete(listener);
	}

	onError(listener: ErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	onExit(listener: ExitListener): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	async stop(): Promise<void> {
		const session = this.session;
		if (!session) return;
		try {
			session.kill();
		} catch {
			/* already gone */
		}
		const promise = this.runPromise;
		if (promise) {
			try {
				await promise;
			} catch {
				/* surfaced through onError */
			}
		}
	}
}

// ─── Resolution (shared shape with OmpProcess.resolveOmp) ───────────────────

export function resolveOmp(opts: OmpPtySpawnOpts): OmpPtyResolution {
	if (opts.command) {
		return { exe: opts.command.exe, args: opts.command.args, source: "override" };
	}
	if (process.env.OMP_BIN) {
		return { exe: process.env.OMP_BIN, args: [], source: "env" };
	}
	const onPath = whichSync("omp");
	if (onPath) {
		return { exe: onPath, args: [], source: "path" };
	}
	const repoRoot = opts.repoRoot ?? findRepoRoot();
	if (repoRoot) {
		const cli = join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
		if (existsSync(cli)) {
			const bun = process.env.OMP_BUNDLED_BUN ?? "bun";
			return { exe: bun, args: ["run", cli], source: "dev" };
		}
	}
	return { exe: "", args: [], source: "not-found" };
}

function findRepoRoot(): string | null {
	// This file lives in packages/desktop-bridge/src/lib → repo root is ../../../..
	const here = new URL(".", import.meta.url).pathname.replace(/^\//, "");
	const candidate = join(here, "..", "..", "..", "..");
	if (existsSync(join(candidate, "package.json"))) return candidate;
	return null;
}

function whichSync(cmd: string): string | null {
	const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
	const dirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
	for (const dir of dirs) {
		if (!dir) continue;
		for (const ext of exts) {
			const candidate = join(dir, `${cmd}${ext}`);
			if (existsSync(candidate)) return candidate;
		}
	}
	return null;
}

// ─── Shell quoting ──────────────────────────────────────────────────────────

/**
 * Quote a single argv element for the target shell.
 *
 * sh (`-lc`): always wrap in single quotes (`'`), escaping `'` as `'\''`.
 * Safe for every printable byte and metacharacter.
 *
 * cmd.exe (`/c`): only quote when the arg contains whitespace or a shell
 * metacharacter (`^&|<>()"`). Quoting a bare unquoted path is actively
 * harmful under cmd.exe's `/c` parser — its "if the whole command starts and
 * ends with quotes" rule (see `cmd /?`) trips into stripping/keeping quotes
 * in surprising ways when the payload has no spaces. Bare tokens with no
 * meta bypass those rules entirely and execute cleanly.
 */
function quoteForShell(arg: string, windows: boolean): string {
	if (windows) {
		if (arg.length === 0) return '""';
		if (!/[\s"&|<>()^]/.test(arg)) return arg;
		// Escape embedded `"` as `""` and wrap. cmd.exe recognizes doubled quotes
		// as a literal quote inside a quoted string.
		return `"${arg.replace(/"/g, '""')}"`;
	}
	return `'${arg.replace(/'/g, "'\\''")}'`;
}
