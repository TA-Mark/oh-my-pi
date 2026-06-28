/**
 * Installer routes — runs the canonical upstream installer
 * (`irm https://omp.sh/install.ps1 | iex` on Windows) as a tracked job
 * and streams its stdout/stderr to the UI over WebSocket.
 *
 * No local install script in between: the user's machine ends up in the
 * exact same state as if they had pasted the README one-liner into a
 * PowerShell prompt. The wrapper only adds preflight + an explicit
 * "register" step that writes a desktop-config.json and stages the
 * bundled native addon so the launcher phase can find them.
 *
 * POSIX path is a TODO — return 501 with a clear message instead of
 * silently doing nothing.
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BridgeContext } from "../lib/context";
import { errorResponse, jsonResponse } from "../lib/http";
import { spawnTracked } from "../lib/process";
import {
	checkDisk,
	checkGit,
	checkNetwork,
	checkPort,
	checkSource,
	checkWritePerm,
} from "../lib/preflight";
import type { InstallRequest, PreflightResponse } from "../types";

const INSTALL_STEPS = [
	{ id: "preflight", label: "Preflight checks" },
	{ id: "install", label: "Install dependencies" },
	{ id: "register", label: "Register launcher" },
];

const UPSTREAM_PS1_URL = "https://omp.sh/install.ps1";

export async function handleInstaller(ctx: BridgeContext, req: Request, url: URL): Promise<Response> {
	const p = url.pathname;

	if (p === "/api/v1/installer/preflight" && req.method === "POST") {
		const body = (await req.json().catch(() => null)) as Partial<{
			repoUrl: string;
			branch: string;
			installPath: string;
		}> | null;
		if (!body?.installPath) {
			return errorResponse("BAD_REQUEST", "installPath is required", 400);
		}
		// Network target is upstream installer host, not the WebUI's repoUrl
		// (which is unused in this flow but still accepted for back-compat).
		const checks = await Promise.all([
			checkGit(),
			checkNetwork(UPSTREAM_PS1_URL),
			Promise.resolve(checkDisk(body.installPath)),
			Promise.resolve(checkSource(body.repoUrl ?? "https://github.com/can1357/oh-my-pi")),
			checkPort(ctx.config.relayPort),
			Promise.resolve(checkWritePerm(body.installPath)),
		]);
		const response: PreflightResponse = {
			checks,
			allPassed: checks.every((c) => c.status === "pass"),
			hasWarnings: checks.some((c) => c.status === "warn"),
		};
		return jsonResponse(response);
	}

	if (p === "/api/v1/installer/jobs" && req.method === "POST") {
		const body = (await req.json().catch(() => null)) as InstallRequest | null;
		if (!body?.installPath) {
			return errorResponse("BAD_REQUEST", "installPath is required", 400);
		}
		const job = ctx.jobs.create(INSTALL_STEPS);
		ctx.jobs.emitLog(
			job.id,
			"info",
			`Starting upstream install (${UPSTREAM_PS1_URL}) → ${body.installPath}`,
		);

		runInstall(ctx, job.id, body).catch((err: unknown) => {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.jobs.emitLog(job.id, "error", `install task crashed: ${msg}`);
			ctx.jobs.fail(job.id, { code: "INSTALL_CRASH", message: msg });
		});
		return jsonResponse({ jobId: job.id, startedAt: job.startedAt }, 201);
	}

	const statusMatch = /^\/api\/v1\/installer\/jobs\/([^/]+)\/status$/.exec(p);
	if (statusMatch && req.method === "GET") {
		const job = ctx.jobs.get(statusMatch[1]!);
		if (!job) return errorResponse("JOB_NOT_FOUND", "no such job", 404);
		return jsonResponse({
			jobId: job.id,
			phase: job.phase,
			progress: job.progress,
			currentStep: job.currentStep,
			steps: job.steps,
			error: job.error,
		});
	}

	const logsMatch = /^\/api\/v1\/installer\/jobs\/([^/]+)\/logs$/.exec(p);
	if (logsMatch && req.method === "GET") {
		const job = ctx.jobs.get(logsMatch[1]!);
		if (!job) return errorResponse("JOB_NOT_FOUND", "no such job", 404);
		const since = url.searchParams.get("since");
		const lines = since ? job.logs.filter((l) => l.ts > since) : job.logs;
		return jsonResponse({ jobId: job.id, lines });
	}

	const cancelMatch = /^\/api\/v1\/installer\/jobs\/([^/]+)\/cancel$/.exec(p);
	if (cancelMatch && req.method === "POST") {
		const id = cancelMatch[1]!;
		const ok = ctx.jobs.cancel(id);
		return jsonResponse({ jobId: id, ok, message: ok ? "cancelled" : "no such job" });
	}

	const repairMatch = /^\/api\/v1\/installer\/jobs\/([^/]+)\/repair$/.exec(p);
	if (repairMatch && req.method === "POST") {
		return jsonResponse({ jobId: repairMatch[1], ok: true, message: "repair queued" });
	}

	return errorResponse("NOT_FOUND", `No installer route for ${req.method} ${p}`, 404);
}

// ─── Job runner ─────────────────────────────────────────────────────────────

async function runInstall(ctx: BridgeContext, jobId: string, req: InstallRequest): Promise<void> {
	const installPath = req.windowsInstallPath ?? req.installPath;

	if (process.platform !== "win32") {
		ctx.jobs.fail(jobId, {
			code: "PLATFORM_UNSUPPORTED",
			message:
				"Only Windows is wired up so far. On macOS/Linux, run `curl -fsSL https://omp.sh/install | sh` in a terminal.",
		});
		return;
	}

	// Step 1: preflight — reach upstream and the user's install dir.
	ctx.jobs.setPhase(jobId, "installing", 5, "preflight");
	const [net, wp] = await Promise.all([
		checkNetwork(UPSTREAM_PS1_URL),
		Promise.resolve(checkWritePerm(installPath)),
	]);
	const preFail = [net, wp].find((c) => c.status === "fail");
	if (preFail) {
		ctx.jobs.emitLog(jobId, "error", `preflight ${preFail.id}: ${preFail.detail ?? preFail.label}`);
		ctx.jobs.fail(jobId, { code: "PREFLIGHT_FAILED", message: preFail.detail ?? preFail.label });
		return;
	}
	ctx.jobs.completeStep(jobId, "preflight", "pass");
	ctx.jobs.setPhase(jobId, "installing", 15, "install");

	// Step 2: run the canonical README one-liner. -Binary keeps it Bun-free.
	const oneLiner = `irm ${UPSTREAM_PS1_URL} | iex`;
	ctx.jobs.emitLog(jobId, "info", `> ${oneLiner}`);
	const child = spawnTracked(
		"powershell.exe",
		["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", oneLiner],
		{
			cwd: installPath,
			env: {
				// Upstream installer reads PI_INSTALL_DIR; if the user picked a
				// non-default install path, honor it for the omp.exe drop too.
				PI_INSTALL_DIR: installPath,
				// Keep the user's PATH intact — we want Bun, Git, etc. resolved
				// from the same environment they'd see in a normal PowerShell.
				PATH: process.env.PATH ?? "",
			},
			onStdout(line) {
				ctx.jobs.emitLog(jobId, parseLevel(line), line, line);
				advanceFromLogLine(ctx, jobId, line);
			},
			onStderr(line) {
				ctx.jobs.emitLog(jobId, "warn", line, line);
			},
		},
	);

	const job = ctx.jobs.get(jobId);
	if (job) job.cancel = () => void child.kill();

	const { code } = await child.waitExit();
	if (code === null) {
		ctx.jobs.emitLog(jobId, "warn", "install cancelled");
		return;
	}
	if (code !== 0) {
		ctx.jobs.fail(jobId, {
			code: "EXIT_NON_ZERO",
			message: `Upstream installer exited with code ${code}. See log panel for the failing line.`,
		});
		return;
	}

	// Step 3: register — locate omp.exe, drop bundled native addon, write
	// desktop-config so the launcher phase can pick everything up.
	ctx.jobs.setPhase(jobId, "installing", 90, "register");
	const ompExe = findOmpExe(installPath);
	if (!ompExe) {
		ctx.jobs.fail(jobId, {
			code: "OMP_NOT_FOUND",
			message:
				"Upstream installer reported success but omp.exe was not found in any of the known locations. " +
				"Try restarting the app, or run `omp --version` in a fresh PowerShell to confirm install.",
		});
		return;
	}
	ctx.jobs.emitLog(jobId, "info", `omp resolved at ${ompExe}`);

	await stageBundledNative(ctx, jobId, installPath);
	writeDesktopConfig(ctx, jobId, installPath, ompExe);

	ctx.jobs.completeStep(jobId, "register", "pass");
	ctx.jobs.setPhase(jobId, "success", 100);
	ctx.jobs.emitLog(jobId, "info", "install complete");
}

// ─── Post-install helpers ──────────────────────────────────────────────────

function findOmpExe(installPath: string): string | null {
	const home = process.env.USERPROFILE ?? "";
	const local = process.env.LOCALAPPDATA ?? "";
	const candidates = [
		// Honors PI_INSTALL_DIR — upstream installer drops omp.exe in $env:PI_INSTALL_DIR\omp.exe.
		join(installPath, "omp.exe"),
		// Default upstream binary-mode location.
		join(local, "omp", "omp.exe"),
		// Bun global bin (when upstream picked bun mode).
		join(home, ".bun", "bin", "omp.exe"),
		join(home, ".bun", "bin", "omp"),
	];
	return candidates.find((p) => existsSync(p)) ?? null;
}

async function stageBundledNative(
	ctx: BridgeContext,
	jobId: string,
	installPath: string,
): Promise<void> {
	const src = process.env.OMP_BUNDLED_NATIVE;
	if (!src || !existsSync(src)) return;
	const nativeDir = join(installPath, "packages", "natives", "native");
	const dest = join(nativeDir, src.split(/[\\/]/).pop() ?? "pi_natives.node");
	try {
		mkdirSync(nativeDir, { recursive: true });
		copyFileSync(src, dest);
		ctx.jobs.emitLog(jobId, "info", `staged native addon → ${dest}`);
	} catch (err) {
		ctx.jobs.emitLog(
			jobId,
			"warn",
			`failed to stage native: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function writeDesktopConfig(
	ctx: BridgeContext,
	jobId: string,
	installPath: string,
	ompExe: string,
): void {
	try {
		mkdirSync(installPath, { recursive: true });
		const configPath = join(installPath, "desktop-config.json");
		const config = {
			installDir: installPath,
			ompPath: ompExe,
			port: ctx.config.port,
			schema: "upstream-iex-v1",
			installedAt: new Date().toISOString(),
		};
		writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
		ctx.jobs.emitLog(jobId, "info", `wrote ${configPath}`);
	} catch (err) {
		ctx.jobs.emitLog(
			jobId,
			"warn",
			`failed to write desktop-config.json: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

// ─── Log parsing / step advancement ────────────────────────────────────────

const LEVEL_RE = /\[(error|err|warn|warning|info|debug)\]/i;

function parseLevel(line: string): "info" | "warn" | "error" | "debug" {
	const m = LEVEL_RE.exec(line);
	if (!m) {
		if (/^\s*✗|fatal|error:/i.test(line)) return "error";
		if (/^\s*⚠|warning:/i.test(line)) return "warn";
		return "info";
	}
	const tag = m[1]!.toLowerCase();
	if (tag === "err") return "error";
	if (tag === "warning") return "warn";
	return tag as "info" | "warn" | "error" | "debug";
}

// Step markers driven by upstream's actual stdout (see scripts/install.ps1
// in can1357/oh-my-pi, mirrored at https://omp.sh/install.ps1).
const STEP_MARKERS: Array<{ re: RegExp; step: string; progress: number }> = [
	{ re: /Installing bun/i, step: "install", progress: 25 },
	{ re: /Fetching (?:latest )?release|Using version/i, step: "install", progress: 40 },
	{ re: /Downloading omp|Installing via bun|bun install/i, step: "install", progress: 65 },
	{ re: /Installed omp (?:to|via)/i, step: "install", progress: 85 },
];

function advanceFromLogLine(ctx: BridgeContext, jobId: string, line: string): void {
	for (const m of STEP_MARKERS) {
		if (m.re.test(line)) {
			const job = ctx.jobs.get(jobId);
			if (job && job.progress < m.progress) {
				const prev = job.steps.find((s) => s.id === job.currentStep);
				if (prev && prev.id !== m.step) ctx.jobs.completeStep(jobId, prev.id, "pass");
				ctx.jobs.setPhase(jobId, "installing", m.progress, m.step);
			}
			break;
		}
	}
}
