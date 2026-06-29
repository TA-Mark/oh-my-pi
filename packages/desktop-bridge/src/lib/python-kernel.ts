/**
 * python-kernel — persistent Python subprocess per session.
 *
 * Spawns `python3 -u -i` with piped stdin/stdout/stderr. Code blocks are
 * delimited by a unique marker so we can distinguish output from the prompt
 * and know when execution finishes.
 *
 * State persists across calls within the same session — variables assigned
 * in one `$x = 42` survive into the next `$print(x)`.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

const MARKER = "__OMP_PYKERNEL_DONE__";
const TIMEOUT_MS = 30_000;

export interface PythonExecResult {
	output: string;
	error: string;
	exitCode: number | null;
}

export class PythonKernel {
	private child: ChildProcessWithoutNullStreams | null = null;
	private buffer = "";
	private errBuffer = "";
	private pending: { resolve: (r: PythonExecResult) => void; timer: ReturnType<typeof setTimeout> } | null = null;

	async start(): Promise<void> {
		if (this.child) return;
		const py = process.platform === "win32" ? "python" : "python3";
		this.child = spawn(py, ["-u", "-i"], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.child.stdout.on("data", (buf: Buffer) => this.onStdout(buf.toString("utf8")));
		this.child.stderr.on("data", (buf: Buffer) => { this.errBuffer += buf.toString("utf8"); });
		this.child.on("exit", () => { this.child = null; this.resolvePending(null); });
		this.child.on("error", () => { this.child = null; this.resolvePending(null); });
		await new Promise(r => setTimeout(r, 200));
		this.buffer = "";
		this.errBuffer = "";
	}

	async execute(code: string, onChunk?: (chunk: string) => void): Promise<PythonExecResult> {
		if (!this.child) await this.start();
		if (!this.child) return { output: "", error: "Python not available", exitCode: 1 };

		this.buffer = "";
		this.errBuffer = "";

		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.resolvePending(null);
				resolve({ output: this.buffer, error: "Execution timed out", exitCode: null });
			}, TIMEOUT_MS);

			this.pending = {
				resolve: (r) => { clearTimeout(timer); resolve(r); },
				timer,
			};

			const wrappedCode = `${code}\nprint("${MARKER}")\n`;
			this.child!.stdin.write(wrappedCode);

			if (onChunk) {
				const origOnStdout = this.onStdout.bind(this);
				this.onStdout = (text: string) => {
					const markerIdx = text.indexOf(MARKER);
					if (markerIdx >= 0) {
						const before = text.slice(0, markerIdx);
						if (before) onChunk(before);
					} else {
						onChunk(text);
					}
					origOnStdout(text);
				};
			}
		});
	}

	stop(): void {
		if (this.child) {
			try { this.child.stdin.end(); } catch { /* ok */ }
			try { this.child.kill(); } catch { /* ok */ }
			this.child = null;
		}
		this.resolvePending(null);
	}

	get alive(): boolean {
		return this.child !== null;
	}

	private onStdout(text: string): void {
		this.buffer += text;
		if (this.buffer.includes(MARKER)) {
			const output = this.buffer.split(MARKER)[0]?.replace(/\r?\n$/, "") ?? "";
			this.resolvePending({ output, error: this.errBuffer, exitCode: 0 });
		}
	}

	private resolvePending(result: PythonExecResult | null): void {
		if (!this.pending) return;
		const { resolve, timer } = this.pending;
		clearTimeout(timer);
		this.pending = null;
		resolve(result ?? { output: this.buffer, error: this.errBuffer, exitCode: null });
	}
}

const kernels = new Map<string, PythonKernel>();

export function getKernel(sessionId: string): PythonKernel {
	let k = kernels.get(sessionId);
	if (!k) {
		k = new PythonKernel();
		kernels.set(sessionId, k);
	}
	return k;
}

export function stopKernel(sessionId: string): void {
	const k = kernels.get(sessionId);
	if (k) {
		k.stop();
		kernels.delete(sessionId);
	}
}

export function stopAllKernels(): void {
	for (const k of kernels.values()) k.stop();
	kernels.clear();
}
