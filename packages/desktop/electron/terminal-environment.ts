import * as os from "node:os";
import * as path from "node:path";

/**
 * Build the environment inherited by an embedded terminal.
 *
 * GUI apps keep the environment captured at launch, so a CLI installed later
 * (notably npm's `%APPDATA%\\npm\\claude.cmd`) can be visible in an external
 * PowerShell but missing from terminals opened inside the app. Add the Windows
 * user CLI locations at terminal creation time while preserving the inherited
 * environment and its original PATH key casing.
 */
export function buildTerminalEnvironment(
	base: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	homeDirectory = os.homedir(),
): Record<string, string> {
	const environment = Object.fromEntries(
		Object.entries(base).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
	const pathKey = Object.keys(environment).find(key => key.toLowerCase() === "path") ?? (platform === "win32" ? "Path" : "PATH");
	const delimiter = platform === "win32" ? ";" : ":";
	const appData = environment.APPDATA || path.join(homeDirectory, "AppData", "Roaming");
	const localAppData = environment.LOCALAPPDATA || path.join(homeDirectory, "AppData", "Local");
	const additions =
		platform === "win32"
			? [
					path.join(appData, "npm"),
					path.join(localAppData, "Microsoft", "WinGet", "Links"),
				]
			: [
					"/usr/local/bin",
					...(platform === "darwin" ? ["/opt/homebrew/bin"] : []),
					path.join(homeDirectory, ".local", "bin"),
					path.join(homeDirectory, ".npm-global", "bin"),
					path.join(homeDirectory, ".cargo", "bin"),
				];
	const existing = environment[pathKey] ?? "";
	const seen = new Set(existing.split(delimiter).filter(Boolean).map(entry => entry.toLowerCase()));
	const next = [...existing.split(delimiter).filter(Boolean)];
	for (const entry of additions) {
		if (seen.has(entry.toLowerCase())) continue;
		seen.add(entry.toLowerCase());
		next.push(entry);
	}
	environment[pathKey] = next.join(delimiter);
	return environment;
}
