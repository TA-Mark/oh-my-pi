/**
 * Resolves the bridge's install / data / state directories.
 *
 * Priority for installDir:
 *   1. $OMP_DESKTOP_DIR
 *   2. desktop-config.json (next to the script)
 *   3. %LOCALAPPDATA%/omp-desktop (Win) | ~/.local/share/omp-desktop (Linux/macOS)
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface BridgeConfig {
	installDir: string;
	stateDir: string;
	logsDir: string;
	port: number;
	/** The collab relay port (separate process, default 8765). */
	relayPort: number;
	/** True on Windows. Selects PS1 vs sh installer / kill semantics. */
	isWindows: boolean;
}

function defaultInstallDir(): string {
	if (process.platform === "win32") {
		const local = process.env.LOCALAPPDATA;
		if (local) return join(local, "omp-desktop");
	}
	return join(homedir(), ".local", "share", "omp-desktop");
}

function readConfigFile(scriptDir: string): Partial<BridgeConfig> {
	// look in scriptDir/.. (typical layout: <installDir>/packages/desktop-bridge/src)
	const candidates = [
		join(scriptDir, "desktop-config.json"),
		join(scriptDir, "..", "desktop-config.json"),
		join(scriptDir, "..", "..", "desktop-config.json"),
		join(scriptDir, "..", "..", "..", "desktop-config.json"),
		join(scriptDir, "..", "..", "..", "..", "desktop-config.json"),
	];
	for (const path of candidates) {
		if (!existsSync(path)) continue;
		try {
			const raw = readFileSync(path, "utf8");
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			const out: Partial<BridgeConfig> = {};
			if (typeof parsed.installDir === "string") out.installDir = parsed.installDir;
			if (typeof parsed.port === "string") out.port = Number(parsed.port);
			else if (typeof parsed.port === "number") out.port = parsed.port;
			if (typeof parsed.relayPort === "string") out.relayPort = Number(parsed.relayPort);
			else if (typeof parsed.relayPort === "number") out.relayPort = parsed.relayPort;
			return out;
		} catch {
			// malformed — keep looking
		}
	}
	return {};
}

export function loadConfig(opts: { port?: number; scriptDir?: string } = {}): BridgeConfig {
	const scriptDir = opts.scriptDir ?? dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
	const file = readConfigFile(scriptDir);

	const installDir = resolve(
		process.env.OMP_DESKTOP_DIR ?? file.installDir ?? defaultInstallDir(),
	);
	const stateDir = join(installDir, "state");
	const logsDir = join(installDir, "logs");
	const port = opts.port ?? file.port ?? Number(process.env.OMP_BRIDGE_PORT ?? 8787);
	const relayPort = file.relayPort ?? Number(process.env.OMP_RELAY_PORT ?? 8765);

	mkdirSync(installDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(logsDir, { recursive: true });

	return {
		installDir,
		stateDir,
		logsDir,
		port,
		relayPort,
		isWindows: process.platform === "win32",
	};
}
