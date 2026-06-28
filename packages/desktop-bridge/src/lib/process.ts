/**
 * Process spawn + lifecycle helpers, Windows-aware.
 *
 * - spawnTracked: wraps Bun.spawn with stdout/stderr line callbacks
 * - killTree: on Windows uses `taskkill /T /F /PID`, elsewhere SIGTERM then SIGKILL
 * - probeHttp: HEAD-style health probe with timeout
 */

import { spawn } from "node:child_process";

export interface SpawnOptions {
	cwd?: string;
	env?: Record<string, string>;
	onStdout?(line: string): void;
	onStderr?(line: string): void;
	onExit?(code: number | null, signal: NodeJS.Signals | null): void;
}

export interface TrackedProcess {
	pid: number | undefined;
	kill(): Promise<void>;
	waitExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export function spawnTracked(command: string, args: string[], opts: SpawnOptions = {}): TrackedProcess {
	const child = spawn(command, args, {
		cwd: opts.cwd,
		env: { ...process.env, ...opts.env },
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});

	const buffer = { out: "", err: "" };
	const drain = (which: "out" | "err", chunk: Buffer): void => {
		buffer[which] += chunk.toString("utf8");
		let idx = buffer[which].indexOf("\n");
		while (idx >= 0) {
			const line = buffer[which].slice(0, idx).replace(/\r$/, "");
			buffer[which] = buffer[which].slice(idx + 1);
			if (which === "out") opts.onStdout?.(line);
			else opts.onStderr?.(line);
			idx = buffer[which].indexOf("\n");
		}
	};

	child.stdout?.on("data", (c: Buffer) => drain("out", c));
	child.stderr?.on("data", (c: Buffer) => drain("err", c));

	const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
		child.on("exit", (code, signal) => {
			if (buffer.out) opts.onStdout?.(buffer.out);
			if (buffer.err) opts.onStderr?.(buffer.err);
			opts.onExit?.(code, signal);
			res({ code, signal });
		});
	});

	return {
		pid: child.pid,
		async kill() {
			if (!child.pid || child.exitCode !== null) return;
			await killTree(child.pid);
		},
		waitExit: () => exitPromise,
	};
}

export async function killTree(pid: number): Promise<void> {
	if (process.platform === "win32") {
		await new Promise<void>((res) => {
			const k = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
			k.on("exit", () => res());
			k.on("error", () => res());
		});
		return;
	}
	try {
		process.kill(pid, "SIGTERM");
		await new Promise((r) => setTimeout(r, 800));
		process.kill(pid, "SIGKILL");
	} catch {
		// already gone
	}
}

export async function probeHttp(url: string, timeoutMs = 3000): Promise<boolean> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		return res.ok;
	} catch {
		return false;
	}
}

export async function probeTcp(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
	const { Socket } = await import("node:net");
	return new Promise((resolve) => {
		const sock = new Socket();
		const done = (ok: boolean): void => {
			sock.destroy();
			resolve(ok);
		};
		sock.setTimeout(timeoutMs);
		sock.once("connect", () => done(true));
		sock.once("timeout", () => done(false));
		sock.once("error", () => done(false));
		sock.connect(port, host);
	});
}

export async function isPortFree(port: number): Promise<boolean> {
	return !(await probeTcp("127.0.0.1", port));
}
