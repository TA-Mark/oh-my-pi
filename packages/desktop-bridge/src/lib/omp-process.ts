/**
 * OmpProcess — wraps a single `omp --mode rpc` child process.
 *
 * Protocol (RFC: packages/coding-agent/src/modes/rpc/rpc-types.ts):
 *   stdin  ← NDJSON RpcCommand frames (one JSON object per line)
 *   stdout → NDJSON RpcResponse / RpcSession events / extension UI requests
 *
 * Consumers (the per-session manager + bridge WS proxy) plug in via:
 *   - send(frame)       to push a command line
 *   - onFrame(listener) to receive every parsed stdout frame
 *   - onLog(listener)   to receive stderr lines (and unparseable stdout)
 *
 * Resolution order for the omp binary:
 *   1. opts.command (caller override — useful for tests)
 *   2. $OMP_BIN env var
 *   3. `omp` on PATH
 *   4. `bun packages/coding-agent/src/cli.ts` from the monorepo (dev)
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { killTree } from "./process";

export interface OmpSpawnOpts {
	/** Workspace cwd for the agent. Defaults to process.cwd(). */
	cwd?: string;
	/** Override the executable + args. Skips PATH/dev resolution. */
	command?: { exe: string; args: string[] };
	/** Extra env vars merged onto process.env. */
	env?: Record<string, string>;
	/** Repo root (used to find packages/coding-agent in dev mode). */
	repoRoot?: string;
	/** Args prepended before `--mode rpc`, e.g. `["--resume", "<file>"]`. */
	extraArgs?: string[];
}

export interface OmpResolution {
	exe: string;
	args: string[];
	source: "override" | "env" | "path" | "dev" | "not-found";
}

type FrameListener = (frame: unknown) => void;
type LogListener = (line: string, stream: "stdout" | "stderr") => void;
type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;

export class OmpProcess {
	private child: ChildProcessWithoutNullStreams | null = null;
	private bufStdout = "";
	private bufStderr = "";
	private readonly frameListeners = new Set<FrameListener>();
	private readonly logListeners = new Set<LogListener>();
	private readonly exitListeners = new Set<ExitListener>();
	private exitedWith: { code: number | null; signal: NodeJS.Signals | null } | null = null;
	readonly resolution: OmpResolution;

	constructor(opts: OmpSpawnOpts = {}) {
		this.resolution = resolveOmp(opts);
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	get running(): boolean {
		return this.child !== null && this.exitedWith === null;
	}

	async start(opts: OmpSpawnOpts = {}): Promise<void> {
		if (this.running) return;
		if (this.resolution.source === "not-found") {
			throw new Error("omp not found: install it or set OMP_BIN");
		}
		const extra = opts.extraArgs ?? [];
		const child = spawn(this.resolution.exe, [...this.resolution.args, ...extra, "--mode", "rpc"], {
			cwd: opts.cwd ?? process.cwd(),
			env: { ...process.env, ...opts.env },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.child = child;
		this.exitedWith = null;

		child.stdout.on("data", (b: Buffer) => this.consumeStdout(b));
		child.stderr.on("data", (b: Buffer) => this.consumeStderr(b));
		child.on("exit", (code, signal) => {
			this.flush();
			this.exitedWith = { code, signal };
			this.child = null;
			for (const l of this.exitListeners) {
				try {
					l(code, signal);
				} catch {
					/* ignore */
				}
			}
		});
		child.on("error", (err) => {
			for (const l of this.logListeners) l(`spawn error: ${err.message}`, "stderr");
		});
	}

	send(frame: unknown): boolean {
		if (!this.child?.stdin.writable) return false;
		return this.child.stdin.write(`${JSON.stringify(frame)}\n`);
	}

	onFrame(listener: FrameListener): () => void {
		this.frameListeners.add(listener);
		return () => this.frameListeners.delete(listener);
	}

	onLog(listener: LogListener): () => void {
		this.logListeners.add(listener);
		return () => this.logListeners.delete(listener);
	}

	onExit(listener: ExitListener): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	async stop(): Promise<void> {
		if (!this.child?.pid) return;
		const pid = this.child.pid;
		try {
			this.child.stdin.end();
		} catch {
			/* already closed */
		}
		await killTree(pid);
	}

	private consumeStdout(chunk: Buffer): void {
		this.bufStdout += chunk.toString("utf8");
		let idx = this.bufStdout.indexOf("\n");
		while (idx >= 0) {
			const line = this.bufStdout.slice(0, idx).replace(/\r$/, "");
			this.bufStdout = this.bufStdout.slice(idx + 1);
			this.handleStdoutLine(line);
			idx = this.bufStdout.indexOf("\n");
		}
	}

	private consumeStderr(chunk: Buffer): void {
		this.bufStderr += chunk.toString("utf8");
		let idx = this.bufStderr.indexOf("\n");
		while (idx >= 0) {
			const line = this.bufStderr.slice(0, idx).replace(/\r$/, "");
			this.bufStderr = this.bufStderr.slice(idx + 1);
			for (const l of this.logListeners) l(line, "stderr");
			idx = this.bufStderr.indexOf("\n");
		}
	}

	private flush(): void {
		if (this.bufStdout) {
			this.handleStdoutLine(this.bufStdout);
			this.bufStdout = "";
		}
		if (this.bufStderr) {
			for (const l of this.logListeners) l(this.bufStderr, "stderr");
			this.bufStderr = "";
		}
	}

	private handleStdoutLine(line: string): void {
		if (!line.trim()) return;
		let frame: unknown;
		try {
			frame = JSON.parse(line);
		} catch {
			for (const l of this.logListeners) l(line, "stdout");
			return;
		}
		for (const l of this.frameListeners) {
			try {
				l(frame);
			} catch {
				/* ignore */
			}
		}
	}
}

// ─── Resolution ─────────────────────────────────────────────────────────────

export function resolveOmp(opts: OmpSpawnOpts): OmpResolution {
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
