/**
 * Unified omp detection — shared by installer (post-install verification) and
 * launcher (runtime location lookup). Single source of truth so the two
 * routes can never drift apart again.
 *
 * Resolution order:
 *   1. `where omp` / `which omp` (PATH lookup, honours user PATH edits made
 *      by the official installer)
 *   2. Optional `installPath` override (set by Binary mode via PI_INSTALL_DIR)
 *   3. Per-platform known locations (Bun global, mise shim, Homebrew, …)
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface DetectOmpResult {
	found: boolean;
	path: string | null;
	version: string | null;
	source: "path" | "known-location" | null;
	candidatesTried: string[];
}

type OmpCandidate = { kind: "path"; label: string } | { kind: "file"; path: string; label: string };

/**
 * Build the candidate list for the current platform. `installPath` (when
 * supplied) is the user-chosen Binary-mode location and is tried first among
 * the file candidates.
 */
function ompCandidates(installPath?: string): OmpCandidate[] {
	const out: OmpCandidate[] = [{ kind: "path", label: "$PATH" }];
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	const local = process.env.LOCALAPPDATA ?? "";

	if (process.platform === "win32") {
		if (installPath) {
			out.push({ kind: "file", path: join(installPath, "omp.exe"), label: `${installPath}\\omp.exe` });
		}
		if (local) {
			out.push({ kind: "file", path: join(local, "omp", "omp.exe"), label: "%LOCALAPPDATA%\\omp\\omp.exe" });
			out.push({
				kind: "file",
				path: join(local, "mise", "shims", "omp.exe"),
				label: "%LOCALAPPDATA%\\mise\\shims\\omp.exe",
			});
		}
		if (home) {
			out.push({
				kind: "file",
				path: join(home, ".bun", "bin", "omp.exe"),
				label: "%USERPROFILE%\\.bun\\bin\\omp.exe",
			});
		}
	} else {
		if (installPath) {
			out.push({ kind: "file", path: join(installPath, "omp"), label: `${installPath}/omp` });
		}
		if (home) {
			out.push({ kind: "file", path: join(home, ".bun", "bin", "omp"), label: "~/.bun/bin/omp" });
			out.push({ kind: "file", path: join(home, ".omp", "bin", "omp"), label: "~/.omp/bin/omp" });
			out.push({
				kind: "file",
				path: join(home, ".local", "share", "mise", "shims", "omp"),
				label: "~/.local/share/mise/shims/omp",
			});
			out.push({ kind: "file", path: join(home, ".local", "bin", "omp"), label: "~/.local/bin/omp" });
		}
		out.push({ kind: "file", path: "/usr/local/bin/omp", label: "/usr/local/bin/omp" });
		out.push({ kind: "file", path: "/opt/homebrew/bin/omp", label: "/opt/homebrew/bin/omp" });
		out.push({
			kind: "file",
			path: "/home/linuxbrew/.linuxbrew/bin/omp",
			label: "/home/linuxbrew/.linuxbrew/bin/omp",
		});
	}
	return out;
}

async function whichOmp(): Promise<string | null> {
	const cmd = process.platform === "win32" ? "where.exe" : "which";
	try {
		const { stdout } = await execFileP(cmd, ["omp"], { timeout: 5000 });
		const first = stdout
			.split(/\r?\n/)
			.find(l => l.trim().length > 0)
			?.trim();
		return first ?? null;
	} catch {
		return null;
	}
}

async function ompVersion(path: string): Promise<string | null> {
	try {
		const { stdout } = await execFileP(path, ["--version"], { timeout: 5000 });
		return stdout.trim().split(/\r?\n/)[0] ?? null;
	} catch {
		return null;
	}
}

/**
 * Synchronous PATH scan — same logic as OmpProcess.whichSync but exposed for
 * the health checker. Avoids spawning `where.exe` which can fail when the
 * sidecar's inherited PATH differs from the user's shell.
 */
function whichOmpSync(): string | null {
	const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
	const dirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
	for (const dir of dirs) {
		if (!dir) continue;
		for (const ext of exts) {
			const candidate = join(dir, `omp${ext}`);
			if (existsSync(candidate)) return candidate;
		}
	}
	return null;
}

/**
 * Find omp on this machine. Prefers synchronous file existence checks over
 * spawning child processes (`where.exe` / `which`) because the compiled
 * sidecar's inherited PATH may differ from the user's shell and child
 * process spawns add latency to the 4-second health loop.
 */
export async function findOmp(installPath?: string): Promise<DetectOmpResult> {
	const candidates = ompCandidates(installPath);
	const tried = candidates.map(c => c.label);

	// 1. Synchronous PATH scan first (fast, no child process)
	const onPath = whichOmpSync();
	if (onPath) {
		const version = await ompVersion(onPath);
		return { found: true, path: onPath, version, source: "path", candidatesTried: tried };
	}

	// 2. Known file locations
	for (const candidate of candidates) {
		if (candidate.kind !== "file") continue;
		if (existsSync(candidate.path)) {
			const version = await ompVersion(candidate.path);
			return { found: true, path: candidate.path, version, source: "known-location", candidatesTried: tried };
		}
	}

	// 3. Fallback: async `where`/`which` (catches PATH entries the sync scan missed)
	const asyncFound = await whichOmp();
	if (asyncFound) {
		const version = await ompVersion(asyncFound);
		return { found: true, path: asyncFound, version, source: "path", candidatesTried: tried };
	}

	return { found: false, path: null, version: null, source: null, candidatesTried: tried };
}

/**
 * Cheap presence-check for Bun. Used by the installer's "recommended method"
 * logic: if Bun is already on the host, prefer `bun-global` over the heavier
 * official one-liner.
 */
export async function hasBun(): Promise<boolean> {
	try {
		await execFileP(process.platform === "win32" ? "bun.exe" : "bun", ["--version"], { timeout: 3000 });
		return true;
	} catch {
		return false;
	}
}

/**
 * Platform-correct default install path for the Binary installer mode. This
 * mirrors the default in `scripts/install.ps1` (`$env:LOCALAPPDATA\omp`) and
 * `scripts/install.sh` (`$HOME/.local/bin`), so the textbox the user sees
 * matches what would actually happen if they pasted the README one-liner.
 */
export function defaultInstallPath(): string {
	if (process.platform === "win32") {
		const local = process.env.LOCALAPPDATA;
		if (local) return join(local, "omp");
		const home = process.env.USERPROFILE;
		if (home) return join(home, "AppData", "Local", "omp");
		return "C:\\omp";
	}
	const home = process.env.HOME ?? "";
	return home ? join(home, ".local", "bin") : "/usr/local/bin";
}
