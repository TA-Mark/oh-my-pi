/**
 * Snapshot / diff viewer — `git diff` + `git status` for the active session's
 * working directory.
 *
 * Simplest approach that covers the plan's requirement: shell out to git in
 * the workspace root via the bridge's existing execShell helper, cap output
 * size, return the raw text so the React side can render with monospace
 * coloring. No fancy side-by-side diff engine — the operator can pipe to
 * `git difftool` in the terminal for deeper investigation.
 *
 * Route:
 *   GET /api/v1/diff?session={id}[&staged=1]
 *     → { path, status, diff, truncated, error? }
 */

import type { BridgeContext } from "../lib/context";
import { errorResponse, jsonResponse } from "../lib/http";
import { execShell } from "../lib/shell-exec";

const DIFF_MAX_BYTES = 512 * 1024; // 512 KiB — enough for most reviews, keeps WebView snappy.
const DIFF_TIMEOUT_MS = 15_000;

async function runGit(
	cwd: string,
	args: readonly string[],
): Promise<{ output: string; exitCode: number | null; cancelled: boolean }> {
	// execShell takes a full command string. We quote each arg conservatively —
	// git arguments here are hard-coded (no user-supplied paths), so escaping
	// is largely defensive.
	const cmd = ["git", ...args].map(a => (/[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
	return execShell(cmd, { cwd, timeout: DIFF_TIMEOUT_MS });
}

function truncate(text: string): { text: string; truncated: boolean } {
	if (text.length <= DIFF_MAX_BYTES) return { text, truncated: false };
	return { text: text.slice(0, DIFF_MAX_BYTES), truncated: true };
}

export async function handleDiff(ctx: BridgeContext, req: Request, url: URL): Promise<Response> {
	if (req.method !== "GET") {
		return errorResponse("METHOD_NOT_ALLOWED", "diff endpoint only supports GET", 405);
	}
	const sessionId = url.searchParams.get("session");
	if (!sessionId) return errorResponse("BAD_REQUEST", "?session=<id> is required", 400);
	const staged = url.searchParams.get("staged") === "1";

	// Session cwd — currently we spawn every omp process in ctx.config.installDir.
	// Once per-session cwd is exposed via bridge state, prefer that.
	const cwd = ctx.config.installDir;

	// Cheap pre-flight: is this a git repo? Skip the heavier diff call if not.
	const rev = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (rev.exitCode !== 0) {
		return jsonResponse({
			path: cwd,
			status: "",
			diff: "",
			truncated: false,
			error: "not a git repository (or git not installed)",
		});
	}

	const [status, diff] = await Promise.all([
		runGit(cwd, ["status", "--short"]),
		runGit(cwd, staged ? ["diff", "--staged"] : ["diff"]),
	]);

	const truncatedDiff = truncate(diff.output);
	return jsonResponse({
		path: cwd,
		status: status.output,
		diff: truncatedDiff.text,
		truncated: truncatedDiff.truncated,
		sessionId,
		staged,
	});
}
