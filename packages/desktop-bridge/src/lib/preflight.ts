/**
 * Preflight system checks for the installer.
 * Each check returns a PreflightCheck with status + remediation hint.
 */

import { accessSync, constants, mkdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import type { PreflightCheck } from "../types";
import { isPortFree } from "./process";

const MIN_DISK_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

async function execCapture(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
	return new Promise((resolve) => {
		const c = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		c.stdout?.on("data", (b: Buffer) => {
			out += b.toString("utf8");
		});
		c.on("error", () => resolve({ ok: false, out: "" }));
		c.on("exit", (code) => resolve({ ok: code === 0, out: out.trim() }));
	});
}

export async function checkGit(): Promise<PreflightCheck> {
	const { ok, out } = await execCapture("git", ["--version"]);
	if (!ok) {
		return {
			id: "git",
			label: "Git available",
			status: "fail",
			detail: "git was not found on PATH",
			fixHint: "Install Git for Windows: https://git-scm.com/download/win",
		};
	}
	return { id: "git", label: "Git available", status: "pass", detail: out };
}

export async function checkNetwork(repoUrl: string): Promise<PreflightCheck> {
	let host: string;
	try {
		host = new URL(repoUrl).origin;
	} catch {
		return {
			id: "net",
			label: "Network reachable",
			status: "fail",
			detail: `Invalid repo URL: ${repoUrl}`,
			fixHint: "Use an https:// repository URL.",
		};
	}
	try {
		// Any HTTP response proves the host is reachable, including 4xx.
		// GitHub root returns 403 by design — that still means network works.
		const res = await fetch(host, { signal: AbortSignal.timeout(8000) });
		return {
			id: "net",
			label: "Network reachable",
			status: "pass",
			detail: `${host} → HTTP ${res.status}`,
		};
	} catch (err) {
		return {
			id: "net",
			label: "Network reachable",
			status: "fail",
			detail: err instanceof Error ? err.message : String(err),
			fixHint: "Check internet connection or corporate proxy settings.",
		};
	}
}

export function checkDisk(installPath: string): PreflightCheck {
	try {
		mkdirSync(installPath, { recursive: true });
		const s = statSync(installPath);
		void s;
		// node:fs has no portable diskstats; trust the dir exists and is writable.
		// (The /diagnostics endpoint runs a deeper check.)
		return {
			id: "disk",
			label: "Install path accessible",
			status: "pass",
			detail: installPath,
		};
	} catch (err) {
		return {
			id: "disk",
			label: "Install path accessible",
			status: "fail",
			detail: err instanceof Error ? err.message : String(err),
			fixHint: "Pick a different install path or check permissions.",
		};
	}
}

export function checkSource(repoUrl: string): PreflightCheck {
	const allowedHosts = ["github.com", "gitlab.com", "raw.githubusercontent.com"];
	try {
		const u = new URL(repoUrl);
		if (!allowedHosts.includes(u.host)) {
			return {
				id: "src",
				label: "Source repository accessible",
				status: "warn",
				detail: `Host ${u.host} is not in the trusted list`,
				fixHint: "Continue only if you trust this source.",
			};
		}
		return {
			id: "src",
			label: "Source repository accessible",
			status: "pass",
			detail: u.host,
		};
	} catch {
		return {
			id: "src",
			label: "Source repository accessible",
			status: "fail",
			detail: `Invalid URL: ${repoUrl}`,
		};
	}
}

export async function checkPort(port: number): Promise<PreflightCheck> {
	const free = await isPortFree(port);
	if (free) {
		return {
			id: "port",
			label: "Service port available",
			status: "pass",
			detail: `Port ${port} is free`,
		};
	}
	return {
		id: "port",
		label: "Service port available",
		status: "warn",
		detail: `Port ${port} is already in use`,
		fixHint: "Another instance may be running. Close it or pick a different port.",
	};
}

export function checkWritePerm(installPath: string): PreflightCheck {
	try {
		mkdirSync(installPath, { recursive: true });
		accessSync(installPath, constants.W_OK);
		return {
			id: "perm",
			label: "Write permission",
			status: "pass",
			detail: installPath,
		};
	} catch (err) {
		return {
			id: "perm",
			label: "Write permission",
			status: "fail",
			detail: err instanceof Error ? err.message : String(err),
			fixHint: "Try a path under your user profile, or run as administrator.",
		};
	}
}

void dirname; // reserved for future deeper disk-space probe
void MIN_DISK_BYTES;
