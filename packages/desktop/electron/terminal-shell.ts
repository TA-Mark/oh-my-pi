import * as nodeFs from "node:fs";
import * as path from "node:path";

export interface TerminalShell {
	command: string;
	args: string[];
}

function executableOnPath(name: string, environment: NodeJS.ProcessEnv): boolean {
	const pathValue = Object.entries(environment).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
	return pathValue.split(path.delimiter).some(directory => nodeFs.existsSync(path.join(directory, name)));
}

export function resolveTerminalShell(
	environment: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): TerminalShell {
	const configured = environment.OMP_TERMINAL_SHELL?.trim();
	if (configured) return { command: configured, args: [] };

	if (platform === "win32") {
		const systemRoot = environment.SystemRoot ?? "C:\\Windows";
		const powerShell7 = environment.PWSH_PATH?.trim() || path.join(environment.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
		if (nodeFs.existsSync(powerShell7) || executableOnPath("pwsh.exe", environment)) {
			return { command: nodeFs.existsSync(powerShell7) ? powerShell7 : "pwsh.exe", args: ["-NoLogo"] };
		}
		return {
			command: path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
			args: ["-NoLogo"],
		};
	}

	return { command: environment.SHELL?.trim() || "/bin/bash", args: ["-l"] };
}
