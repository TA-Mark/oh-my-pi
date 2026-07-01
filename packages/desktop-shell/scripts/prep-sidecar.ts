/**
 * Compile the desktop-bridge and stage it as a Tauri sidecar binary.
 *
 * Tauri 2 resolves sidecars by `<configured-path>-<rust-target-triple>{.exe}`
 * inside `src-tauri/binaries/`. We:
 *   1. Detect the Rust host triple via `rustc -vV` (or derive from the host
 *      as a fallback).
 *   2. Invoke `bun run compile` in packages/desktop-bridge with that triple.
 *   3. Copy the compiled binary into src-tauri/binaries/ with the expected name.
 *
 * Runs in two contexts:
 *   - `tauri dev` / `tauri build` via beforeDevCommand / beforeBuildCommand
 *   - manual `bun run prep-sidecar`
 */

import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const SHELL_DIR = resolve(new URL("..", import.meta.url).pathname.replace(/^\//, ""));
const BRIDGE_DIR = resolve(SHELL_DIR, "..", "desktop-bridge");
const BINARIES_DIR = join(SHELL_DIR, "src-tauri", "binaries");

function deriveTripleFromHost(): string {
	const a = process.arch;
	const p = process.platform;
	if (p === "win32") return a === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
	if (p === "darwin") return a === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
	if (p === "linux") return a === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
	throw new Error(`unsupported host: ${p}/${a}`);
}

async function detectTripleViaRustc(): Promise<string | null> {
	return new Promise((res) => {
		const c = spawn("rustc", ["-vV"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
		let out = "";
		c.stdout.on("data", (b: Buffer) => {
			out += b.toString("utf8");
		});
		c.on("error", () => res(null));
		c.on("exit", () => {
			const match = /^host:\s*(.+)$/m.exec(out);
			res(match?.[1]?.trim() ?? null);
		});
	});
}

async function run(cmd: string, args: string[], cwd: string): Promise<void> {
	await new Promise<void>((res, rej) => {
		const c = spawn(cmd, args, { cwd, stdio: "inherit", windowsHide: true });
		c.on("error", rej);
		c.on("exit", (code) => (code === 0 ? res() : rej(new Error(`${cmd} ${args.join(" ")} exit ${code}`))));
	});
}

async function main(): Promise<void> {
	const triple = (await detectTripleViaRustc()) ?? deriveTripleFromHost();
	const ext = triple.includes("windows") ? ".exe" : "";
	const compiled = join(BRIDGE_DIR, "dist", `omp-bridge-${triple}${ext}`);
	const staged = join(BINARIES_DIR, `omp-bridge-${triple}${ext}`);

	console.log(`[prep-sidecar] target triple: ${triple}`);
	mkdirSync(BINARIES_DIR, { recursive: true });

	await run("bun", ["run", "compile", "--target", triple], BRIDGE_DIR);
	copyFileSync(compiled, staged);
	console.log(`[prep-sidecar] ✓ staged → ${staged}`);
}

await main();
