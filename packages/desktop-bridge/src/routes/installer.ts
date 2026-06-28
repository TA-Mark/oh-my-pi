/**
 * Installer routes — preflight + spawn the existing PS1 / sh install script
 * as a tracked JobManager job, streaming stdout/stderr over WebSocket.
 *
 * Windows: scripts/desktop-webui-install.ps1
 * POSIX:   not yet shipped — returns 501 with a clear message.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
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
	{ id: "clone", label: "Clone or update repo" },
	{ id: "install", label: "Install dependencies" },
	{ id: "build", label: "Build WebUI bundle" },
	{ id: "register", label: "Register launcher" },
];

export async function handleInstaller(ctx: BridgeContext, req: Request, url: URL): Promise<Response> {
	const p = url.pathname;

	if (p === "/api/v1/installer/preflight" && req.method === "POST") {
		const body = (await req.json().catch(() => null)) as Partial<{
			repoUrl: string;
			branch: string;
			installPath: string;
		}> | null;
		if (!body?.repoUrl || !body.installPath) {
			return errorResponse("BAD_REQUEST", "repoUrl and installPath are required", 400);
		}
		const checks = await Promise.all([
			checkGit(),
			checkNetwork(body.repoUrl),
			Promise.resolve(checkDisk(body.installPath)),
			Promise.resolve(checkSource(body.repoUrl)),
			// Check the relay port the Launcher will use later — NOT the bridge
			// port we are listening on (which is trivially "in use" because we
			// are answering this very request from it).
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
		if (!body?.repoUrl || !body.installPath) {
			return errorResponse("BAD_REQUEST", "repoUrl and installPath are required", 400);
		}
		const job = ctx.jobs.create(INSTALL_STEPS);
		ctx.jobs.emitLog(job.id, "info", `Starting install: ${body.repoUrl} (${body.branch ?? "main"}) → ${body.installPath}`);

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
		// Repair = re-run install with same params; for the skeleton we just ack.
		return jsonResponse({ jobId: repairMatch[1], ok: true, message: "repair queued" });
	}

	return errorResponse("NOT_FOUND", `No installer route for ${req.method} ${p}`, 404);
}

// ─── Job runner ─────────────────────────────────────────────────────────────

async function runInstall(ctx: BridgeContext, jobId: string, req: InstallRequest): Promise<void> {
	const installPath = req.windowsInstallPath ?? req.installPath;

	// Step 1: preflight (a quick re-check inside the job)
	ctx.jobs.setPhase(jobId, "installing", 5, "preflight");
	const pre = await Promise.all([checkGit(), checkNetwork(req.repoUrl), checkSource(req.repoUrl)]);
	const preFail = pre.find((c) => c.status === "fail");
	if (preFail) {
		ctx.jobs.emitLog(jobId, "error", `preflight ${preFail.id}: ${preFail.detail ?? preFail.label}`);
		ctx.jobs.fail(jobId, { code: "PREFLIGHT_FAILED", message: preFail.detail ?? preFail.label });
		return;
	}
	ctx.jobs.completeStep(jobId, "preflight", "pass");
	ctx.jobs.setPhase(jobId, "installing", 15, "clone");

	// Step 2–5: delegate to the platform install script
	const scriptInfo = locateInstallScript(ctx);
	if (!scriptInfo) {
		ctx.jobs.fail(jobId, {
			code: "SCRIPT_NOT_FOUND",
			message: "Install script not found in repo (scripts/desktop-webui-install.*)",
		});
		return;
	}

	ctx.jobs.emitLog(jobId, "info", `running ${scriptInfo.command} ${scriptInfo.args.join(" ")}`);

	// Build a PATH that prefers the Tauri-bundled Bun + MinGit so the install
	// script Just Works without user-installed Bun/Git on PATH.
	const bundledDirs: string[] = [];
	if (process.env.OMP_BUNDLED_BUN) bundledDirs.push(dirname(process.env.OMP_BUNDLED_BUN));
	if (process.env.OMP_BUNDLED_GIT_DIR) bundledDirs.push(process.env.OMP_BUNDLED_GIT_DIR);
	const pathSep = process.platform === "win32" ? ";" : ":";
	const augmentedPath = bundledDirs.length
		? `${bundledDirs.join(pathSep)}${pathSep}${process.env.PATH ?? ""}`
		: process.env.PATH ?? "";

	if (bundledDirs.length) {
		ctx.jobs.emitLog(jobId, "info", `using bundled deps: ${bundledDirs.join(", ")}`);
	}

	const child = spawnTracked(scriptInfo.command, scriptInfo.args, {
		cwd: scriptInfo.cwd,
		env: {
			OMP_DESKTOP_DIR: installPath,
			OMP_BRIDGE_PORT: String(ctx.config.port),
			PATH: augmentedPath,
		},
		onStdout(line) {
			ctx.jobs.emitLog(jobId, parseLevel(line), line, line);
			advanceFromLogLine(ctx, jobId, line);
		},
		onStderr(line) {
			ctx.jobs.emitLog(jobId, "warn", line, line);
		},
	});

	const job = ctx.jobs.get(jobId);
	if (job) job.cancel = () => void child.kill();

	const { code } = await child.waitExit();
	if (code === 0) {
		// Drop the bundled native addon next to packages/natives/native/ so the
		// freshly-cloned repo's omp loader finds it without needing a Rust build.
		await stageBundledNative(ctx, jobId, installPath);
		ctx.jobs.completeStep(jobId, "register", "pass");
		ctx.jobs.setPhase(jobId, "success", 100);
		ctx.jobs.emitLog(jobId, "info", "install complete");
	} else if (code === null) {
		ctx.jobs.emitLog(jobId, "warn", "install cancelled");
	} else {
		ctx.jobs.fail(jobId, { code: "EXIT_NON_ZERO", message: `installer exited with code ${code}` });
	}
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
		ctx.jobs.emitLog(jobId, "warn", `failed to stage native: ${err instanceof Error ? err.message : String(err)}`);
	}
}

interface ScriptInfo {
	command: string;
	args: string[];
	cwd: string;
}

function locateInstallScript(ctx: BridgeContext): ScriptInfo | null {
	// Repo checkout is expected to be installDir itself (the PS1 clones-in-place).
	// For first-run when nothing is cloned yet, walk up from this script to find
	// the monorepo we live in.
	const scriptDir = new URL(".", import.meta.url).pathname.replace(/^\//, "");
	const candidates = [
		ctx.config.installDir,
		join(scriptDir, "..", "..", "..", ".."), // packages/desktop-bridge/src/routes → repo root
	];

	for (const repo of candidates) {
		const ps1 = join(repo, "scripts", "desktop-webui-install.ps1");
		const sh = join(repo, "scripts", "desktop-webui-install.sh");
		if (process.platform === "win32" && existsSync(ps1)) {
			return {
				command: "powershell.exe",
				args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-Silent"],
				cwd: repo,
			};
		}
		if (process.platform !== "win32" && existsSync(sh)) {
			return { command: "bash", args: [sh], cwd: repo };
		}
	}
	return null;
}

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

const STEP_MARKERS: Array<{ re: RegExp; step: string; progress: number }> = [
	{ re: /Preflight checks/i, step: "preflight", progress: 10 },
	{ re: /Fetching source|Cloning|Updating/i, step: "clone", progress: 30 },
	{ re: /Installing.*dependencies|bun install/i, step: "install", progress: 55 },
	{ re: /Building.*WebUI|bun build/i, step: "build", progress: 80 },
	{ re: /Registering|Creating launchers/i, step: "register", progress: 95 },
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
