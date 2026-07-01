/**
 * Bundle the desktop-bridge to a single JS file and stage it as a Tauri
 * resource for the shell to launch via `bun run`.
 *
 * We don't ship the bridge as a Tauri sidecar (compiled exe) any more —
 * `bun build --compile` produces a binary whose napi loader can't see
 * `.node` exports for pi-natives (works fine when the same file is required
 * by a normal `bun` runtime). Instead we ship the bundled JS via Tauri's
 * `resources/` and rely on the bundled Bun sidecar (`binaries/bun-<triple>.exe`)
 * to execute it. See packages/desktop-shell/src-tauri/src/bridge.rs.
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
const RESOURCES_BRIDGE_DIR = join(SHELL_DIR, "src-tauri", "resources", "bridge");
const BUNDLED_JS = join(BRIDGE_DIR, "dist", "omp-bridge.js");
const STAGED_JS = join(RESOURCES_BRIDGE_DIR, "omp-bridge.js");

async function run(cmd: string, args: string[], cwd: string): Promise<void> {
	await new Promise<void>((res, rej) => {
		const c = spawn(cmd, args, { cwd, stdio: "inherit", windowsHide: true });
		c.on("error", rej);
		c.on("exit", code => (code === 0 ? res() : rej(new Error(`${cmd} ${args.join(" ")} exit ${code}`))));
	});
}

async function main(): Promise<void> {
	mkdirSync(RESOURCES_BRIDGE_DIR, { recursive: true });
	console.log("[prep-sidecar] bundling bridge JS…");
	await run("bun", ["run", "compile"], BRIDGE_DIR);
	copyFileSync(BUNDLED_JS, STAGED_JS);
	console.log(`[prep-sidecar] ✓ staged bridge JS → ${STAGED_JS}`);
}

await main();
