/**
 * shell-exec — spawn a shell command, stream output line-by-line.
 *
 * Used by the bridge's `/chat/sessions/:id/bash` endpoint to give the
 * desktop WebUI real-time shell output (the OMP RPC `bash` command blocks
 * until the command finishes and doesn't support `excludeFromContext`).
 */

import { spawn } from "node:child_process";

export interface ShellExecResult {
	output: string;
	exitCode: number | null;
	cancelled: boolean;
}

export async function execShell(
	command: string,
	opts?: {
		cwd?: string;
		onChunk?: (chunk: string) => void;
		signal?: AbortSignal;
		timeout?: number;
	},
): Promise<ShellExecResult> {
	const isWindows = process.platform === "win32";
	const shell = isWindows ? "powershell.exe" : "bash";
	const shellArgs = isWindows ? ["-NoProfile", "-Command", command] : ["-c", command];

	const child = spawn(shell, shellArgs, {
		cwd: opts?.cwd ?? process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});

	let output = "";
	let cancelled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	if (opts?.signal) {
		const onAbort = () => {
			cancelled = true;
			try { child.kill(); } catch { /* already dead */ }
		};
		opts.signal.addEventListener("abort", onAbort, { once: true });
	}

	if (opts?.timeout && opts.timeout > 0) {
		timer = setTimeout(() => {
			cancelled = true;
			try { child.kill(); } catch { /* already dead */ }
		}, opts.timeout);
	}

	child.stdout?.on("data", (buf: Buffer) => {
		const text = buf.toString("utf8");
		output += text;
		opts?.onChunk?.(text);
	});

	child.stderr?.on("data", (buf: Buffer) => {
		const text = buf.toString("utf8");
		output += text;
		opts?.onChunk?.(text);
	});

	const exitCode = await new Promise<number | null>((resolve) => {
		child.on("exit", (code) => resolve(code));
		child.on("error", () => resolve(null));
	});

	if (timer) clearTimeout(timer);

	return { output, exitCode, cancelled };
}
