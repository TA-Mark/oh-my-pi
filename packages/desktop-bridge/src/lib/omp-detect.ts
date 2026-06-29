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
		const { stdout } = await execFileP(cmd, ["omp"]);
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
 * Find omp on this machine. Returns the first candidate that resolves to an
 * existing binary, preferring whatever `which`/`where` reports because that
 * is exactly what the user gets when they type `omp` in their shell.
 */
export async function findOmp(installPath?: string): Promise<DetectOmpResult> {
	const candidates = ompCandidates(installPath);
	for (const candidate of candidates) {
		if (candidate.kind === "path") {
			const found = await whichOmp();
			if (found) {
				const version = await ompVersion(found);
				return {
					found: true,
					path: found,
					version,
					source: "path",
					candidatesTried: candidates.map(c => c.label),
				};
			}
		} else if (existsSync(candidate.path)) {
			const version = await ompVersion(candidate.path);
			return {
				found: true,
				path: candidate.path,
				version,
				source: "known-location",
				candidatesTried: candidates.map(c => c.label),
			};
		}
	}
	return {
		found: false,
		path: null,
		version: null,
		source: null,
		candidatesTried: candidates.map(c => c.label),
	};
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
