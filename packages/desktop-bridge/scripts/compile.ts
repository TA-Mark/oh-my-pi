/**
 * Bundle the bridge to a single JS file for the Tauri shell to launch via
 * `bun run`. We deliberately DO NOT use `bun build --compile` — the resulting
 * standalone exe has a napi loader bug where the pi-natives `.node` addon
 * loads but its version-sentinel export is not visible in the compiled
 * binary's require context (works fine when the same file is required by a
 * regular `bun` runtime). The Tauri shell ships a bundled Bun sidecar and
 * runs this JS file directly, sidestepping the bug.
 *
 * Output: `dist/omp-bridge.js` (single ~180 KB file, all bridge modules
 * inlined; pi-natives .node stays out-of-band and is loaded at runtime by
 * the pi-natives loader from its usual search locations).
 *
 * Historical: this script previously produced `omp-bridge-<triple>.exe` for
 * Tauri sidecar bundling. See prep-sidecar.ts + bridge.rs for the new
 * resource-based staging path.
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PACKAGE_DIR = resolve(new URL("..", import.meta.url).pathname.replace(/^\//, ""));
const ENTRY = join(PACKAGE_DIR, "src", "server.ts");
const DIST = join(PACKAGE_DIR, "dist");
const OUT_FILE = join(DIST, "omp-bridge.js");

async function main(): Promise<void> {
	mkdirSync(dirname(OUT_FILE), { recursive: true });

	console.log("[bridge] bundling (bun build, no --compile)");
	console.log(`[bridge] entry:  ${ENTRY}`);
	console.log(`[bridge] output: ${OUT_FILE}`);

	await new Promise<void>((resolveSpawn, reject) => {
		const child = spawn(
			"bun",
			["build", "--target=bun", "--outfile", OUT_FILE, "--minify", ENTRY],
			{ stdio: "inherit", windowsHide: true },
		);
		child.on("error", reject);
		child.on("exit", code => (code === 0 ? resolveSpawn() : reject(new Error(`bun build exit ${code}`))));
	});

	console.log(`[bridge] ✓ bundled → ${OUT_FILE}`);
}

await main();
