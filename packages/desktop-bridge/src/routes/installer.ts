/**
 * Installer routes — dispatches to one of the README-documented install
 * methods (curl | brew | bun -g | irm | mise) as a tracked JobManager job
 * and streams its stdout/stderr to the UI over WebSocket.
 *
 * GET  /api/v1/installer/methods   → list methods + recommended for this OS
 * POST /api/v1/installer/preflight → reach upstream + write-perm check
 * POST /api/v1/installer/jobs      → run one method
 * GET  /api/v1/installer/jobs/:id  → status/logs/cancel
 *
 * No wrapper script in between: the user's machine ends up in the exact
 * same state as if they had pasted the README one-liner into a terminal.
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BridgeContext } from "../lib/context";
import { errorResponse, jsonResponse } from "../lib/http";
import { defaultInstallPath, findOmp, hasBun } from "../lib/omp-detect";
import { checkBrew, checkBun, checkMise, checkNetwork, checkWritePerm } from "../lib/preflight";
import { spawnTracked } from "../lib/process";
import type {
	InstallMethod,
	InstallMethodId,
	InstallMethodsResponse,
	InstallRequest,
	PreflightCheck,
	PreflightResponse,
} from "../types";

const INSTALL_STEPS = [
	{ id: "preflight", label: "Preflight checks" },
	{ id: "install", label: "Install dependencies" },
	{ id: "register", label: "Register launcher" },
];

const METHODS: InstallMethod[] = [
	{
		id: "windows-irm",
		label: "Windows (PowerShell)",
		command: "irm https://omp.sh/install.ps1 | iex",
		platforms: ["win32"],
		requires: ["PowerShell"],
		notes: "Official Windows installer. Defaults to binary download; no Bun needed.",
	},
	{
		id: "macos-curl",
		label: "macOS · Linux",
		command: "curl -fsSL https://omp.sh/install | sh",
		platforms: ["darwin", "linux"],
		requires: ["curl", "sh"],
		notes: "Official POSIX installer.",
	},
	{
		id: "homebrew",
		label: "Homebrew",
		command: "brew install can1357/tap/omp",
		platforms: ["darwin", "linux"],
		requires: ["brew"],
	},
	{
		id: "bun-global",
		label: "Bun (recommended)",
		command: "bun install -g @oh-my-pi/pi-coding-agent",
		platforms: ["win32", "darwin", "linux"],
		requires: ["bun >= 1.3.14"],
	},
	{
		id: "mise",
		label: "Pinned versions (mise)",
		command: "mise use -g github:can1357/oh-my-pi",
		platforms: ["win32", "darwin", "linux"],
		requires: ["mise"],
	},
];

/**
 * Pick a recommended install method for the current host. When Bun is already
 * present (the desktop-bridge itself runs on Bun, so this is almost always
 * true on dev machines), prefer `bun-global` — it is the lightest path and
 * the one most developers will recognise. Otherwise fall back to the
 * platform's official one-liner from the README.
 */
async function recommendedMethod(platform: NodeJS.Platform): Promise<InstallMethodId> {
	if (await hasBun()) return "bun-global";
	if (platform === "win32") return "windows-irm";
	return "macos-curl";
}

/** Static fallback used only when the async detect somehow fails. */
const STATIC_RECOMMENDED: Record<NodeJS.Platform, InstallMethodId> = {
	win32: "windows-irm",
	darwin: "macos-curl",
	linux: "macos-curl",
} as Record<NodeJS.Platform, InstallMethodId>;

/**
 * Compose a one-line description of where omp will end up when this method
 * runs on the current host. Mirrors the upstream installer's own decision
 * tree (Bun-mode vs Binary-mode for the README one-liners) and the known
 * destinations of `bun install -g` / Homebrew / mise.
 */
function targetHintFor(
	id: InstallMethodId,
	platform: NodeJS.Platform,
	binaryDefault: string,
	bunPresent: boolean,
	installPath?: string,
): string {
	const winBun = "%USERPROFILE%\\.bun\\bin\\omp.exe";
	const posixBun = "~/.bun/bin/omp";
	switch (id) {
		case "windows-irm": {
			if (bunPresent) return `${winBun} (installer auto-selects Bun mode because Bun is present)`;
			const target = installPath ? `${installPath}\\omp.exe` : `${binaryDefault}\\omp.exe`;
			return `${target} (Binary mode)`;
		}
		case "macos-curl": {
			if (bunPresent) return `${posixBun} (installer auto-selects Bun mode because Bun is present)`;
			return `${binaryDefault}/omp (Binary mode)`;
		}
		case "bun-global":
			return platform === "win32" ? `${winBun} (Bun global)` : `${posixBun} (Bun global)`;
		case "homebrew":
			return platform === "darwin"
				? "/opt/homebrew/bin/omp (Apple Silicon) or /usr/local/bin/omp (Intel)"
				: "$HOMEBREW_PREFIX/bin/omp (Linuxbrew)";
		case "mise":
			return platform === "win32" ? "%LOCALAPPDATA%\\mise\\shims\\omp.exe" : "~/.local/share/mise/shims/omp";
	}
}

/**
 * Build the preflight checklist for the chosen method. We do NOT run
 * `checkWritePerm` for methods that ignore `installPath` (bun-global,
 * homebrew, mise, macos-curl) — those install into a system-managed
 * location (~/.bun/bin, $HOMEBREW_PREFIX, mise shims, $HOME/.local/bin)
 * and the user-typed path is irrelevant. Failing them on a non-writable
 * path would block install for no reason.
 */
async function checksForMethod(method: InstallMethodId, installPath?: string): Promise<PreflightCheck[]> {
	const out: PreflightCheck[] = [];
	out.push(await checkNetwork("https://omp.sh"));
	switch (method) {
		case "windows-irm":
			if (installPath) out.push(checkWritePerm(installPath));
			break;
		case "macos-curl":
			// curl/sh are part of the base system on every POSIX host.
			break;
		case "bun-global":
			out.push(await checkBun());
			break;
		case "homebrew":
			out.push(await checkBrew());
			break;
		case "mise":
			out.push(await checkMise());
			break;
	}
	return out;
}

export async function handleInstaller(ctx: BridgeContext, req: Request, url: URL): Promise<Response> {
	const p = url.pathname;

	if (p === "/api/v1/installer/methods" && req.method === "GET") {
		const platform = process.platform;
		const filtered = METHODS.filter(m => m.platforms.includes(platform as "win32" | "darwin" | "linux"));
		const bunPresent = await hasBun();
		const recommended = bunPresent ? "bun-global" : (STATIC_RECOMMENDED[platform] ?? "bun-global");
		const binaryDefault = defaultInstallPath();
		const methodsWithHints = filtered.map(m => ({
			...m,
			targetHint: targetHintFor(m.id, platform, binaryDefault, bunPresent),
		}));
		const response: InstallMethodsResponse = {
			methods: methodsWithHints,
			recommended,
			platform,
			defaultInstallPath: binaryDefault,
		};
		return jsonResponse(response);
	}

	if (p === "/api/v1/installer/preflight" && req.method === "POST") {
		const body = (await req.json().catch(() => null)) as Partial<{
			installPath: string;
			method: InstallMethodId;
		}> | null;
		const method = body?.method ?? (await recommendedMethod(process.platform));
		if (method === "windows-irm" && !body?.installPath) {
			return errorResponse("BAD_REQUEST", "installPath is required for windows-irm", 400);
		}
		const checks = await checksForMethod(method, body?.installPath);
		const response: PreflightResponse = {
			checks,
			allPassed: checks.every(c => c.status === "pass"),
			hasWarnings: checks.some(c => c.status === "warn"),
		};
		return jsonResponse(response);
	}

	if (p === "/api/v1/installer/jobs" && req.method === "POST") {
		const body = (await req.json().catch(() => null)) as InstallRequest | null;
		const method = body?.method ?? STATIC_RECOMMENDED[process.platform] ?? "bun-global";
		const methodDef = METHODS.find(m => m.id === method);
		if (!methodDef) {
			return errorResponse("BAD_REQUEST", `unknown install method: ${method}`, 400);
		}
		if (!methodDef.platforms.includes(process.platform as "win32" | "darwin" | "linux")) {
			return errorResponse("PLATFORM_MISMATCH", `method ${method} is not supported on ${process.platform}`, 400);
		}
		// Only the Binary path of the Windows installer reads PI_INSTALL_DIR;
		// every other method is a global installer and ignores the textbox.
		if (method === "windows-irm" && !body?.installPath) {
			return errorResponse("BAD_REQUEST", "installPath is required for windows-irm", 400);
		}

		const job = ctx.jobs.create(INSTALL_STEPS);
		job.params = { method, installPath: body?.installPath };
		const target = method === "windows-irm" ? (body?.installPath ?? "") : `via ${methodDef.label}`;
		ctx.jobs.emitLog(job.id, "info", `Starting install: ${methodDef.label}${target ? ` → ${target}` : ""}`);

		runInstall(ctx, job.id, body ?? {}, methodDef, false).catch((err: unknown) => {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.jobs.emitLog(job.id, "error", `install task crashed: ${msg}`);
			ctx.jobs.fail(job.id, { code: "INSTALL_CRASH", message: msg });
		});
		return jsonResponse(
			{ jobId: job.id, startedAt: job.startedAt, method, logFile: ctx.jobs.logFile(job.id) ?? null },
			201,
		);
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
		const lines = since ? job.logs.filter(l => l.ts > since) : job.logs;
		return jsonResponse({ jobId: job.id, lines, logFile: ctx.jobs.logFile(job.id) ?? null });
	}

	const cancelMatch = /^\/api\/v1\/installer\/jobs\/([^/]+)\/cancel$/.exec(p);
	if (cancelMatch && req.method === "POST") {
		const id = cancelMatch[1]!;
		const ok = ctx.jobs.cancel(id);
		return jsonResponse({ jobId: id, ok, message: ok ? "cancelled" : "no such job" });
	}

	const repairMatch = /^\/api\/v1\/installer\/jobs\/([^/]+)\/repair$/.exec(p);
	if (repairMatch && req.method === "POST") {
		const prev = ctx.jobs.get(repairMatch[1]!);
		if (!prev) return errorResponse("JOB_NOT_FOUND", "no such job", 404);
		if (!prev.params) {
			return errorResponse(
				"NO_PARAMS",
				"job has no recorded install params — submit a fresh /jobs request instead",
				409,
			);
		}
		const methodDef = METHODS.find(m => m.id === prev.params!.method);
		if (!methodDef) {
			return errorResponse("BAD_REQUEST", `unknown install method on prior job: ${prev.params.method}`, 400);
		}
		const job = ctx.jobs.create(INSTALL_STEPS);
		const installPath = prev.params.installPath;
		job.params = { method: methodDef.id, installPath, force: true };
		ctx.jobs.emitLog(
			job.id,
			"info",
			`Repair: re-running ${methodDef.label} with --force${installPath ? ` → ${installPath}` : ""}`,
		);
		const body: InstallRequest = { method: methodDef.id, ...(installPath ? { installPath } : {}) };
		runInstall(ctx, job.id, body, methodDef, true).catch((err: unknown) => {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.jobs.emitLog(job.id, "error", `repair task crashed: ${msg}`);
			ctx.jobs.fail(job.id, { code: "REPAIR_CRASH", message: msg });
		});
		return jsonResponse(
			{
				jobId: job.id,
				startedAt: job.startedAt,
				method: methodDef.id,
				logFile: ctx.jobs.logFile(job.id) ?? null,
				ok: true,
				message: "repair started",
			},
			201,
		);
	}

	return errorResponse("NOT_FOUND", `No installer route for ${req.method} ${p}`, 404);
}

// ─── Job runner ─────────────────────────────────────────────────────────────

interface SpawnSpec {
	command: string;
	args: string[];
}

/**
 * Convert a method's friendly command to a force / reinstall variant. Only
 * methods whose upstream tool documents a force flag get a real upgrade; the
 * rest just rerun the original command (still useful — `bun install -g`
 * already overwrites existing global packages idempotently).
 */
function forceCommandFor(method: InstallMethod): string {
	switch (method.id) {
		case "bun-global":
			return method.command.replace(/^bun install -g/, "bun install -g --force");
		case "homebrew":
			return method.command.replace(/^brew install/, "brew reinstall");
		default:
			return method.command;
	}
}

function buildSpawnSpec(method: InstallMethod, force: boolean): SpawnSpec {
	const command = force ? forceCommandFor(method) : method.command;
	switch (method.id) {
		case "windows-irm":
			return {
				command: "powershell.exe",
				args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
			};
		case "macos-curl":
			return { command: "sh", args: ["-c", command] };
		case "homebrew":
		case "bun-global":
		case "mise":
			if (process.platform === "win32") {
				return {
					command: "powershell.exe",
					args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
				};
			}
			return { command: "sh", args: ["-c", command] };
	}
}

async function runInstall(
	ctx: BridgeContext,
	jobId: string,
	req: InstallRequest,
	method: InstallMethod,
	force: boolean,
): Promise<void> {
	// `installPath` is only meaningful for the Windows Binary path. For every
	// other method the official installer picks its own destination — leave
	// it undefined so we don't pretend otherwise.
	const installPath =
		method.id === "windows-irm" ? (req.windowsInstallPath ?? req.installPath ?? undefined) : undefined;

	// Step 1: method-aware preflight. We do NOT require write access to
	// `installPath` for bun-global / homebrew / mise — those install into a
	// system-managed location that the user-typed path has no bearing on.
	ctx.jobs.setPhase(jobId, "installing", 5, "preflight");
	const checks = await checksForMethod(method.id, installPath);
	const preFail = checks.find(c => c.status === "fail");
	if (preFail) {
		ctx.jobs.emitLog(jobId, "error", `preflight ${preFail.id}: ${preFail.detail ?? preFail.label}`);
		ctx.jobs.fail(jobId, { code: "PREFLIGHT_FAILED", message: preFail.detail ?? preFail.label });
		return;
	}
	ctx.jobs.completeStep(jobId, "preflight", "pass");
	ctx.jobs.setPhase(jobId, "installing", 15, "install");

	// Step 2: run the chosen one-liner. We deliberately spawn without a
	// project-specific cwd — the upstream installer ignores cwd, and pinning
	// it to a user-typed folder would fail if that folder does not exist.
	// `env` inherits the bridge's environment via `spawnTracked` so PATH,
	// PATHEXT, SystemRoot, etc. are all present. We only override what the
	// official installers themselves document.
	const spec = buildSpawnSpec(method, force);
	const displayCommand = force ? forceCommandFor(method) : method.command;
	ctx.jobs.emitLog(jobId, "info", `> ${displayCommand}`);
	ctx.jobs.emitLog(jobId, "debug", `[spawn] ${spec.command} ${spec.args.join(" ")}`);

	const envOverride: Record<string, string> = {};
	if (method.id === "windows-irm" && installPath) {
		envOverride.PI_INSTALL_DIR = installPath;
	}

	const child = spawnTracked(spec.command, spec.args, {
		env: envOverride,
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
	if (code === null) {
		ctx.jobs.emitLog(jobId, "warn", "install cancelled");
		return;
	}
	if (code !== 0) {
		ctx.jobs.fail(jobId, {
			code: "EXIT_NON_ZERO",
			message: `Install command exited with code ${code}. See log panel for the failing line.`,
		});
		return;
	}

	// Step 3: locate omp the same way the user would (`where omp` first).
	ctx.jobs.setPhase(jobId, "installing", 90, "register");
	const detect = await findOmp(installPath);
	if (!detect.found || !detect.path) {
		ctx.jobs.fail(jobId, {
			code: "OMP_NOT_FOUND",
			message:
				"Installer reported success but omp was not found in any known location. " +
				"Open a fresh terminal and run `omp --version` to confirm. " +
				"If it works there but not here, the PATH update has not propagated to this process yet — restart the app.",
			detail: `Tried: ${detect.candidatesTried.join(", ")}`,
		});
		return;
	}
	const ompExe = detect.path;
	ctx.jobs.emitLog(jobId, "info", `omp resolved at ${ompExe} (via ${detect.source})`);

	// Stage the dev-only bundled native addon into the user-supplied folder
	// when present (only meaningful for Binary-mode installs). Skipped for
	// every other method.
	if (installPath) await stageBundledNative(ctx, jobId, installPath);

	// Persist the bridge's own bookkeeping — always to the bridge's
	// installDir (`%LOCALAPPDATA%\omp-desktop`), never into the folder the
	// official installer manages.
	writeDesktopConfig(ctx, jobId, ompExe, method.id);

	ctx.jobs.completeStep(jobId, "register", "pass");
	ctx.jobs.setPhase(jobId, "success", 100);
	ctx.jobs.emitLog(jobId, "info", "install complete");
}

// ─── Post-install helpers ──────────────────────────────────────────────────

async function stageBundledNative(ctx: BridgeContext, jobId: string, installPath: string): Promise<void> {
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

/**
 * Persist the bridge's view of the install — purely bookkeeping for the
 * desktop shell, separate from anything the official installer wrote.
 * Always writes to `ctx.config.installDir` (`%LOCALAPPDATA%\omp-desktop`),
 * never to the folder the upstream installer owns.
 */
function writeDesktopConfig(ctx: BridgeContext, jobId: string, ompExe: string, method: InstallMethodId): void {
	try {
		const dir = ctx.config.installDir;
		mkdirSync(dir, { recursive: true });
		const configPath = join(dir, "desktop-config.json");
		const config = {
			installDir: dir,
			ompPath: ompExe,
			port: ctx.config.port,
			method,
			schema: "method-v1",
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

const STEP_MARKERS: Array<{ re: RegExp; step: string; progress: number }> = [
	{ re: /Installing bun/i, step: "install", progress: 25 },
	{
		re: /Fetching (?:latest )?release|Using version|Downloading.*\.tar|Downloading.*tap/i,
		step: "install",
		progress: 40,
	},
	{ re: /Downloading omp|Installing via bun|bun install|brew install|mise.+install/i, step: "install", progress: 65 },
	// Last marker: only the genuine success messages from the README installers.
	// Bare `installed` would match noise like `bun is already installed`.
	{ re: /Installed omp (?:to|via)|Pouring|installed @oh-my-pi|omp installed/i, step: "install", progress: 85 },
];

function advanceFromLogLine(ctx: BridgeContext, jobId: string, line: string): void {
	for (const m of STEP_MARKERS) {
		if (m.re.test(line)) {
			const job = ctx.jobs.get(jobId);
			if (job && job.progress < m.progress) {
				const prev = job.steps.find(s => s.id === job.currentStep);
				if (prev && prev.id !== m.step) ctx.jobs.completeStep(jobId, prev.id, "pass");
				ctx.jobs.setPhase(jobId, "installing", m.progress, m.step);
			}
			break;
		}
	}
}
