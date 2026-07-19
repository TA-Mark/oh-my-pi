import { expect, test } from "bun:test";
import { buildTerminalEnvironment } from "../electron/terminal-environment";
import { resolveTerminalShell } from "../electron/terminal-shell";

test("adds Windows user CLI locations to the embedded terminal PATH", () => {
	const environment = buildTerminalEnvironment(
		{
			Path: "C:\\Windows\\System32;C:\\Program Files\\nodejs",
			APPDATA: "C:\\Users\\mark-MJ\\AppData\\Roaming",
			LOCALAPPDATA: "C:\\Users\\mark-MJ\\AppData\\Local",
		},
		"win32",
		"C:\\Users\\mark-MJ",
	);

	expect(environment.Path).toContain("C:\\Users\\mark-MJ\\AppData\\Roaming\\npm");
	expect(environment.Path).toContain("C:\\Users\\mark-MJ\\AppData\\Local\\Microsoft\\WinGet\\Links");
	expect(environment.Path?.split(";").filter(value => value.endsWith("\\npm"))).toHaveLength(1);
});

test("adds common user CLI locations without Windows-only paths on macOS", () => {
	const base = { PATH: "/usr/bin:/bin" };
	const environment = buildTerminalEnvironment(base, "darwin", "/Users/user");

	expect(environment.PATH).toContain("/usr/local/bin");
	expect(environment.PATH).toContain("/opt/homebrew/bin");
	expect(environment.PATH).not.toContain("AppData");
});

test("selects the configured user shell in login mode on macOS", () => {
	expect(resolveTerminalShell({ SHELL: "/bin/zsh" }, "darwin")).toEqual({ command: "/bin/zsh", args: ["-l"] });
});

test("falls back to Windows PowerShell when PowerShell 7 is unavailable", () => {
	const shell = resolveTerminalShell({ SystemRoot: "C:\\Windows", Path: "C:\\Windows\\System32" }, "win32");

	expect(shell.command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
	expect(shell.args).toEqual(["-NoLogo"]);
});
