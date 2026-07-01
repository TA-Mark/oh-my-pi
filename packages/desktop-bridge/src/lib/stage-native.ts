/**
 * Stage the bundled pi-natives `.node` addon before any downstream module
 * imports `@oh-my-pi/pi-natives`.
 *
 * When the Tauri shell launches the bridge sidecar (a `bun build --compile`
 * standalone exe), it sets `OMP_BUNDLED_NATIVE` to the absolute path of the
 * napi addon it staged under `resources/native/`. The pi-natives loader,
 * however, only searches a fixed list of well-known locations (per-user OMP
 * dirs, %LOCALAPPDATA%\omp\, and `<execDir>/pi_natives.<triple>.node`) — it
 * does NOT consult that env var. Without a copy in one of those paths the
 * bridge exits during module init with "Failed to load pi_natives native
 * addon".
 *
 * We copy the bundled file to `<execDir>/pi_natives.<basename>` — the
 * loader's `<execDir>` fallback picks it up, no per-user install required.
 *
 * Import this module BEFORE any other module that transitively imports
 * `@oh-my-pi/pi-natives` (side-effect at import time). See server.ts:1.
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** pi-natives version — MUST match the workspace catalog. Loader looks for a
 *  `.node` under `~/.omp/natives/<version>/`. */
const PI_NATIVES_VERSION = "16.1.20";

function stageTo(src: string, dest: string): void {
	if (existsSync(dest)) {
		try {
			if (statSync(dest).size === statSync(src).size) return;
		} catch {
			/* fall through and copy */
		}
	}
	try {
		mkdirSync(dirname(dest), { recursive: true });
		copyFileSync(src, dest);
		console.log(`[desktop-bridge] staged native addon: ${src} → ${dest}`);
	} catch (err) {
		console.error(
			`[desktop-bridge] failed to stage native addon from ${src} to ${dest}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function stage(): void {
	const src = process.env.OMP_BUNDLED_NATIVE;
	if (!src) return;
	if (!existsSync(src)) {
		console.error(`[desktop-bridge] OMP_BUNDLED_NATIVE=${src} — file does not exist, skipping stage`);
		return;
	}
	const filename = basename(src);
	// Pi-natives search order (per packages/natives/native/loader-state.js):
	//   1. ~/.omp/natives/<version>/pi_natives.<triple>.node   ← versionedDir
	//   2. %LOCALAPPDATA%\omp\pi_natives.<triple>.node          ← userDataDir
	//   3. <execDir>/pi_natives.<triple>.node                    ← fallback
	// The bun-compiled bridge exe has a known issue loading napi exports via
	// the execDir fallback path — the require() succeeds but the sentinel
	// export appears missing. Staging to the versionedDir (path 1) uses the
	// primary loader branch and works around it.
	const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
	if (home) {
		stageTo(src, join(home, ".omp", "natives", PI_NATIVES_VERSION, filename));
	}
	// Belt-and-braces: also stage next to the exe for older loaders / offline
	// installs that don't have write access to the user profile dir.
	const execDir = dirname(process.execPath);
	stageTo(src, join(execDir, filename));
}

stage();
