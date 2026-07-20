/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with 	ype` field, optional `id` for correlation
 * - Responses: JSON objects with 	ype: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import type * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { PROVIDER_REGISTRY } from "@oh-my-pi/pi-ai/registry";
import { isZodSchema, zodToWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import {
	$env,
	getAgentDir,
	getMCPConfigPath,
	isEnoent,
	isRecord,
	readJsonl,
	Snowflake,
	setProjectDir,
} from "@oh-my-pi/pi-utils";
import { reset as resetCapabilities } from "../../capability";
import { applyProviderGlobalsFromSettings } from "../../config/provider-globals";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import {
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	type ExtensionUISelectItem,
	type ExtensionWidgetOptions,
	getExtensionUISelectOptionLabel,
} from "../../extensibility/extensions";
import { PluginManager } from "../../extensibility/plugins/manager";
import { buildSkillPromptMessage, parseSkillInvocation } from "../../extensibility/skills";
import { loadSlashCommands } from "../../extensibility/slash-commands";
import { resolveLocalUrlToPath } from "../../internal-urls";
import { connectToServer, disconnectServer } from "../../mcp/client";
import { addMCPServer, removeMCPServer, setMcpServerEnabled, updateMCPServer } from "../../mcp/config-writer";
import type { MCPManager } from "../../mcp/manager";
import {
	mcpOAuthCredentialIdsForServerUrl,
	removeManagedMcpOAuthCredential,
	removeManagedMcpOAuthCredentials,
} from "../../mcp/oauth-credentials";
import { reauthorizeRpcMcpServer } from "../../mcp/rpc-oauth";
import type { MCPAuthConfig, MCPServerConfig } from "../../mcp/types";
import { createSessionMemoryRuntimeContext, runMemoryBackendAction } from "../../memory-backend/runtime";
import { type Theme, theme } from "../../modes/theme/theme";
import { type PlanApprovalDetails, resolveApprovedPlan } from "../../plan-mode/approved-plan";
import type { AgentSession } from "../../session/agent-session";
import { SKILL_PROMPT_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../../session/messages";
import { SessionManager } from "../../session/session-manager";
import { executeAcpBuiltinSlashCommand } from "../../slash-commands/acp-builtins";
import { buildAvailableSlashCommands } from "../../slash-commands/available-commands";
import { type BrowserParams, BrowserTool } from "../../tools/browser";
import { listTabs } from "../../tools/browser/tab-supervisor";
import { normalizeLocalScheme } from "../../tools/path-utils";
import { ToolError } from "../../tools/tool-errors";
import type { EventBus } from "../../utils/event-bus";
import * as git from "../../utils/git";
import { initializeExtensions } from "../runtime-init";
import { isRpcHostToolResult, isRpcHostToolUpdate, RpcHostToolBridge } from "./host-tools";
import { isRpcHostUriResult, RpcHostUriBridge } from "./host-uris";
import { buildRpcMarketplaceSnapshot, createRpcMarketplaceManager } from "./rpc-marketplace";
import {
	buildRpcSettingsSnapshot,
	deleteRpcPluginSetting,
	getRpcPluginDescriptor,
	setRpcPluginEnabled,
	setRpcPluginFeatures,
	setRpcPluginSetting,
	setRpcSetting,
} from "./rpc-settings";
import { RpcSubagentRegistry, readRpcSubagentTranscript } from "./rpc-subagents";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcHostUriCancelRequest,
	RpcHostUriRequest,
	RpcHostUriResult,
	RpcPlanModeState,
	RpcResponse,
	RpcReviewScope,
	RpcSessionState,
	RpcSessionSummary,
	RpcSubagentSubscriptionLevel,
	RpcWorkspaceEntry,
	RpcWorkspaceFileChange,
} from "./rpc-types";

// Re-export types for consumers
export type * from "./rpc-types";

export type PendingExtensionRequest = {
	resolve: (response: RpcExtensionUIResponse) => void;
	reject: (error: Error) => void;
};

/** Pending extension UI request map that can fail closed when the RPC client disconnects. */
export class RpcPendingExtensionRequests extends Map<string, PendingExtensionRequest> {
	#closedError: Error | undefined;

	override set(id: string, request: PendingExtensionRequest): this {
		if (this.#closedError) {
			request.reject(this.#closedError);
			return this;
		}
		return super.set(id, request);
	}

	/** Reject every active and future extension UI request. */
	rejectAll(message: string): void {
		if (!this.#closedError) this.#closedError = new Error(message);
		const requests = Array.from(this.values());
		this.clear();
		for (const request of requests) {
			request.reject(this.#closedError);
		}
	}
}

type RpcOutput = (
	obj:
		| RpcResponse
		| RpcExtensionUIRequest
		| RpcHostToolCallRequest
		| RpcHostToolCancelRequest
		| RpcHostUriRequest
		| RpcHostUriCancelRequest
		| object,
) => void;

export type RpcSessionChangeCommand = Extract<
	RpcCommand,
	{ type: "new_session" } | { type: "switch_session" } | { type: "branch" }
>;

export type RpcSessionChangeResult =
	| { type: "new_session"; data: { cancelled: boolean } }
	| { type: "switch_session"; data: { cancelled: boolean } }
	| { type: "branch"; data: { text: string; cancelled: boolean } };

/** Skip inlining untracked-file content past this size (still listed as a change). */
const MAX_UNTRACKED_DIFF_BYTES = 256 * 1024;

/**
 * Bound the workspace-diff scan. When a project folder lives inside a repository
 * whose root is huge (e.g. the user's home directory is itself a git repo), the
 * untracked enumeration + per-file reads can otherwise run for minutes and stall
 * the sequential RPC loop. These caps make the scan return promptly with a
 * best-effort (possibly partial) result instead of hanging.
 */
const WORKSPACE_DIFF_TIMEOUT_MS = 10_000;
const MAX_UNTRACKED_FILES = 1000;

/** Count `+`/`-` body lines in a unified diff (ignoring `+++`/`---` headers). */
function countDiffLines(diff: string): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions++;
		else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
	}
	return { additions, deletions };
}

/** Synthesize a "new file" unified diff for an untracked file's text. */
function untrackedDiff(relPath: string, content: string): string {
	const lines = content.split("\n");
	// A trailing newline yields a final empty element; drop it so we don't emit a phantom line.
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const body = lines.map(line => `+${line}`).join("\n");
	return `--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${lines.length} @@\n${body}`;
}

/**
 * Build the workspace git diff for the Changes panel: every tracked file changed
 * vs HEAD (staged + unstaged), plus untracked files rendered as new-file diffs.
 * Returns `[]` when `cwd` is not inside a git repository.
 */
async function buildWorkspaceDiff(
	cwd: string,
	scope: RpcReviewScope = "all",
	selectedRef?: string,
): Promise<RpcWorkspaceFileChange[]> {
	// Bound every git subprocess so a repo rooted at a huge directory (e.g. the
	// home dir) can't stall the sequential RPC loop for minutes.
	const signal = AbortSignal.timeout(WORKSPACE_DIFF_TIMEOUT_MS);
	const root = await git.repo.root(cwd, signal).catch(() => null);
	if (!root) return [];

	const out: RpcWorkspaceFileChange[] = [];
	const ref = selectedRef?.trim();
	const includeUntracked = scope === "all" || scope === "unstaged" || scope === "last_turn";

	// Tracked changes vs HEAD (falls back to the index diff when there is no HEAD yet).
	try {
		let raw: string;
		switch (scope) {
			case "unstaged":
				raw = await git.diff(root, { allowFailure: true, signal });
				break;
			case "staged":
				raw = await git.diff(root, { cached: true, allowFailure: true, signal });
				break;
			case "commit":
				if (!ref) throw new Error("A commit is required for commit review");
				raw = await git.show(root, ref, { format: "", signal });
				break;
			case "branch":
				if (!ref) throw new Error("A base branch is required for branch review");
				raw = await git.diff(root, { base: ref, head: "HEAD", allowFailure: true, signal });
				break;
			case "last_turn":
			case "all":
				raw = await git.diff(root, { base: "HEAD", allowFailure: true, signal });
				if (!raw.trim()) {
					const [unstaged, staged] = await Promise.all([
						git.diff(root, { allowFailure: true, signal }),
						git.diff(root, { cached: true, allowFailure: true, signal }),
					]);
					raw = [staged, unstaged].filter(part => part.trim()).join("\n");
				}
				break;
		}
		for (const file of git.diff.parseFiles(raw)) {
			const isDelete = /^--- a\/.+\n\+\+\+ \/dev\/null/m.test(file.content);
			const isAdd = /^--- \/dev\/null/m.test(file.content);
			out.push({
				path: file.filename,
				status: isDelete ? "deleted" : isAdd ? "added" : "modified",
				diff: file.isBinary ? "" : file.content,
				additions: file.additions,
				deletions: file.deletions,
				truncated: file.isBinary,
			});
		}
	} catch (err) {
		if (scope === "commit" || scope === "branch") throw err;
		// Diff failed unexpectedly (or timed out) — fall through with whatever tracked entries we have.
	}

	// Untracked files: git diff omits them, so synthesize new-file diffs.
	if (includeUntracked)
		try {
			const untracked = await git.ls.untracked(root, signal);
			const known = new Set(out.map(entry => entry.path));
			// Cap the count: an accidentally huge root (home dir) can list tens of
			// thousands of files, and inlining each one's content is prohibitive.
			let scanned = 0;
			for (const relPath of untracked) {
				if (known.has(relPath)) continue;
				if (scanned >= MAX_UNTRACKED_FILES || signal.aborted) break;
				scanned += 1;
				let diff = "";
				let additions = 0;
				let truncated = false;
				try {
					const file = Bun.file(`${root}/${relPath}`);
					if (file.size > MAX_UNTRACKED_DIFF_BYTES) {
						truncated = true;
					} else {
						const content = await file.text();
						diff = untrackedDiff(relPath, content);
						additions = countDiffLines(diff).additions;
					}
				} catch {
					truncated = true; // binary or unreadable
				}
				out.push({ path: relPath, status: "untracked", diff, additions, deletions: 0, truncated });
			}
		} catch {
			// ls-files failed (or timed out) — skip untracked enumeration.
		}

	out.sort((a, b) => a.path.localeCompare(b.path));
	return out;
}

const MAX_WORKSPACE_ENTRIES = 25_000;
const DEFAULT_FILE_PREVIEW_BYTES = 256 * 1024;
const MAX_ARTIFACT_PREVIEW_BYTES = 1024 * 1024;
const DEFAULT_ARTIFACT_PREVIEW_BYTES = 256 * 1024;
const MAX_FILE_PREVIEW_BYTES = 1024 * 1024;
const IGNORED_WORKSPACE_DIRECTORIES = new Set([".git", "node_modules", ".cache", "dist"]);

function isContainedPath(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateBrowserUrl(raw: string): string {
	const url = new URL(raw.trim());
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Browser URL must use http or https");
	if (url.username || url.password) throw new Error("Browser URLs cannot contain credentials");
	return url.href;
}

function desktopBrowserNavigationCode(url: string): string {
	return `if (typeof page.createCDPSession === "function") { const cdp = await page.createCDPSession(); try { await cdp.send("Page.setDownloadBehavior", { behavior: "deny" }); } finally { await cdp.detach(); } } await page.goto(${JSON.stringify(url)}); return page.url();`;
}

function desktopBrowserHistoryCode(direction: "back" | "forward" | "reload"): string {
	const navigation =
		direction === "back"
			? "await page.goBack();"
			: direction === "forward"
				? "await page.goForward();"
				: "await page.reload();";
	return `if (typeof page.createCDPSession === "function") { const cdp = await page.createCDPSession(); try { await cdp.send("Page.setDownloadBehavior", { behavior: "deny" }); } finally { await cdp.detach(); } } ${navigation} return page.url();`;
}

async function executeBrowserRpc(session: AgentSession, params: BrowserParams) {
	const tool = session.getToolByName("browser");
	if (!(tool instanceof BrowserTool)) throw new Error("Browser tool is unavailable or disabled");
	return tool.execute(`rpc-browser-${Date.now()}`, params, undefined);
}

function browserResultText(result: { content: readonly { type: string; text?: string }[] }): string {
	return result.content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
		)
		.map(block => block.text)
		.join("\n")
		.slice(0, 128 * 1024);
}

async function resolveWorkspaceFile(cwd: string, requestedPath: string): Promise<string> {
	const root = await fs.realpath(cwd);
	const lexical = path.resolve(root, requestedPath);
	if (!isContainedPath(root, lexical)) throw new Error("Path is outside the workspace");
	const resolved = await fs.realpath(lexical);
	if (!isContainedPath(root, resolved)) throw new Error("Path resolves outside the workspace");
	return resolved;
}

async function listWorkspaceEntries(
	cwd: string,
	query: string,
	requestedLimit: number | undefined,
): Promise<{ entries: RpcWorkspaceEntry[]; truncated: boolean }> {
	const root = await fs.realpath(cwd);
	const limit = Math.max(1, Math.min(MAX_WORKSPACE_ENTRIES, requestedLimit ?? MAX_WORKSPACE_ENTRIES));
	const normalizedQuery = query.trim().toLowerCase();
	try {
		const [tracked, untracked] = await Promise.all([git.ls.files(root), git.ls.untracked(root)]);
		const files = new Set<string>();
		const directories = new Set<string>();
		for (const candidate of [...tracked, ...untracked]) {
			const normalized = candidate
				.split(path.sep)
				.join("/")
				.replace(/^\.\/+/, "");
			if (!normalized || normalized.startsWith("../") || path.isAbsolute(normalized)) continue;
			files.add(normalized);
			const parts = normalized.split("/");
			parts.pop();
			let parent = "";
			for (const part of parts) {
				parent = parent ? `${parent}/${part}` : part;
				directories.add(parent);
			}
		}
		const gitEntries: RpcWorkspaceEntry[] = [
			...Array.from(directories, directory => ({
				path: directory,
				name: directory.slice(directory.lastIndexOf("/") + 1),
				type: "directory" as const,
				size: null,
				mtimeMs: null,
			})),
			...Array.from(files, file => ({
				path: file,
				name: file.slice(file.lastIndexOf("/") + 1),
				type: "file" as const,
				size: null,
				mtimeMs: null,
			})),
		]
			.filter(entry => !normalizedQuery || entry.path.toLowerCase().includes(normalizedQuery))
			.sort((a, b) => a.path.localeCompare(b.path));
		return { entries: gitEntries.slice(0, limit), truncated: gitEntries.length > limit };
	} catch {
		// Non-git workspaces still use the guarded filesystem traversal below.
	}
	const entries: RpcWorkspaceEntry[] = [];
	const pending = [root];
	let truncated = false;
	while (pending.length > 0 && entries.length < limit) {
		const current = pending.pop();
		if (!current) break;
		let children: nodeFs.Dirent[];
		try {
			children = await fs.readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}
		children.sort((a, b) => a.name.localeCompare(b.name));
		for (const child of children) {
			if (entries.length >= limit) {
				truncated = true;
				break;
			}
			if (child.isSymbolicLink()) continue;
			if (child.isDirectory() && IGNORED_WORKSPACE_DIRECTORIES.has(child.name)) continue;
			const absolute = path.join(current, child.name);
			const relative = path.relative(root, absolute).split(path.sep).join("/");
			if (!child.isDirectory() && !child.isFile()) continue;
			if (child.isDirectory()) pending.push(absolute);
			if (normalizedQuery && !relative.toLowerCase().includes(normalizedQuery)) continue;
			entries.push({
				path: relative,
				name: child.name,
				type: child.isDirectory() ? "directory" : "file",
				size: null,
				mtimeMs: null,
			});
		}
	}
	if (pending.length > 0) truncated = true;
	entries.sort((a, b) => a.path.localeCompare(b.path));
	return { entries, truncated };
}

export type RpcSessionChangeSession = Pick<AgentSession, "newSession" | "switchSession" | "branch">;

export type RpcSkillCommandSession = Pick<AgentSession, "promptCustomMessage" | "skills" | "skillsSettings">;
export type RpcSkillCommandResult = { agentInvoked: true };

export async function tryRunRpcSkillCommand(
	session: RpcSkillCommandSession,
	text: string,
	streamingBehavior: "steer" | "followUp" = "steer",
): Promise<RpcSkillCommandResult | false> {
	if (!session.skillsSettings?.enableSkillCommands) return false;
	const parsed = parseSkillInvocation(text);
	if (!parsed) return false;
	const skill = session.skills.find(candidate => candidate.name === parsed.name);
	if (!skill) return false;
	const built = await buildSkillPromptMessage(skill, parsed.args, "user");
	await session.promptCustomMessage(
		{
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: built.message,
			display: true,
			details: built.details,
			attribution: "user",
		},
		{ streamingBehavior },
	);
	return { agentInvoked: true };
}

export function reportLocalOnlyPromptResult(input: {
	id: string | undefined;
	prompt: Promise<boolean>;
	output: (obj: object) => void;
	onError: (error: Error) => void;
	hasExtensionAgentMessageTask?: () => boolean;
	waitForExtensionAgentMessageTasks?: () => Promise<void>;
}): void {
	void input.prompt
		.then(async agentInvoked => {
			if (agentInvoked) return;
			await input.waitForExtensionAgentMessageTasks?.();
			if (!input.hasExtensionAgentMessageTask?.()) {
				input.output({ type: "prompt_result", id: input.id, agentInvoked: false });
			}
		})
		.catch(error => {
			input.onError(error instanceof Error ? error : new Error(String(error)));
		});
}

type RpcExtensionUserMessageScope = {
	hasAgentMessageTask: boolean;
	pendingAgentMessageTasks: Set<Promise<void>>;
};

/**
 * Tracks extension-originated messages while an RPC prompt is executing.
 * A slash command can resolve the outer prompt as local-only while also
 * scheduling agent work through pi.sendUserMessage() or pi.sendMessage()
 * with triggerTurn; that prompt must not report agentInvoked:false to the host.
 */
export class RpcExtensionUserMessageTracker {
	#activePromptScopes = new Set<RpcExtensionUserMessageScope>();

	markAgentMessageTask(): void {
		for (const scope of this.#activePromptScopes) {
			scope.hasAgentMessageTask = true;
		}
	}

	trackAgentMessageTask(task: Promise<unknown>): void {
		for (const scope of this.#activePromptScopes) {
			this.#trackAgentMessageTaskForScope(scope, task);
		}
	}

	#trackAgentMessageTaskForScope(scope: RpcExtensionUserMessageScope, task: Promise<unknown>): void {
		const scopedTask = task.then(
			() => {
				scope.hasAgentMessageTask = true;
			},
			() => {},
		);
		scope.pendingAgentMessageTasks.add(scopedTask);
		void scopedTask.finally(() => {
			scope.pendingAgentMessageTasks.delete(scopedTask);
		});
	}

	async #waitForAgentMessageTasks(scope: RpcExtensionUserMessageScope): Promise<void> {
		while (scope.pendingAgentMessageTasks.size > 0) {
			await Promise.allSettled(Array.from(scope.pendingAgentMessageTasks));
		}
	}

	watchPrompt<T>(startPrompt: () => Promise<T>): {
		prompt: Promise<T>;
		hasAgentMessageTask: () => boolean;
		waitForAgentMessageTasks: () => Promise<void>;
	} {
		const scope: RpcExtensionUserMessageScope = {
			hasAgentMessageTask: false,
			pendingAgentMessageTasks: new Set(),
		};
		this.#activePromptScopes.add(scope);
		let prompt: Promise<T>;
		try {
			prompt = startPrompt();
		} catch (error) {
			this.#activePromptScopes.delete(scope);
			throw error;
		}
		return {
			prompt: prompt.finally(() => {
				this.#activePromptScopes.delete(scope);
			}),
			hasAgentMessageTask: () => scope.hasAgentMessageTask,
			waitForAgentMessageTasks: () => this.#waitForAgentMessageTasks(scope),
		};
	}
}

export function watchAndReportLocalOnlyPromptResult(input: {
	id: string | undefined;
	startPrompt: () => Promise<boolean>;
	output: (obj: object) => void;
	onError: (error: Error) => void;
	extensionUserMessageTracker: RpcExtensionUserMessageTracker;
}): void {
	const trackedPrompt = input.extensionUserMessageTracker.watchPrompt(input.startPrompt);
	reportLocalOnlyPromptResult({
		id: input.id,
		prompt: trackedPrompt.prompt,
		output: input.output,
		onError: input.onError,
		hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		waitForExtensionAgentMessageTasks: trackedPrompt.waitForAgentMessageTasks,
	});
}

/**
 * Dependencies for {@link dispatchRpcInputFrame}. Provided by the RPC mode
 * entrypoint; broken out so tests can drive the input loop with stubs.
 */
export interface RpcInputFrameDeps {
	handleCommand: (command: RpcCommand) => Promise<RpcResponse>;
	output: RpcOutput;
	errorResponse: (id: string | undefined, command: string, message: string) => RpcResponse;
	trackBackgroundTask?: (task: Promise<void>) => void;
	pendingExtensionRequests: Map<string, PendingExtensionRequest>;
	onHostToolResult: (frame: RpcHostToolResult) => void;
	onHostToolUpdate: (frame: RpcHostToolUpdate) => void;
	onHostUriResult: (frame: RpcHostUriResult) => void;
}

/**
 * Structural guard for a well-formed extension UI response frame. Mirrors the
 * shape declared in {@link RpcExtensionUIResponse} — a truthy record with
 * 	ype === "extension_ui_response"` and a string `id`. Payload variants (value,
 * confirmed, cancelled) are validated at the read site.
 */
function isRpcExtensionUIResponse(value: unknown): value is RpcExtensionUIResponse {
	if (!isRecord(value)) return false;
	return value.type === "extension_ui_response" && typeof value.id === "string";
}

/** Dispatch side-channel frames that must overtake the serialized command queue. */
export function dispatchRpcControlFrame(parsed: unknown, deps: RpcInputFrameDeps): boolean {
	if (isRpcExtensionUIResponse(parsed)) {
		const pending = deps.pendingExtensionRequests.get(parsed.id);
		if (pending) pending.resolve(parsed);
		return true;
	}

	if (isRpcHostToolResult(parsed)) {
		deps.onHostToolResult(parsed);
		return true;
	}

	if (isRpcHostToolUpdate(parsed)) {
		deps.onHostToolUpdate(parsed);
		return true;
	}

	if (isRpcHostUriResult(parsed)) {
		deps.onHostUriResult(parsed);
		return true;
	}

	return false;
}

/**
 * Dispatch a single parsed frame from the RPC input stream.
 *
 * Bash commands are dispatched in the background so the caller can keep reading
 * subsequent frames while a shell command is still running. This lets a client
 * send `abort_bash` while a long-running `bash` is in flight. Response
 * correlation is preserved via each command's `id`; ordering across concurrent
 * commands is not guaranteed and clients MUST match on `id`.
 *
 * @returns `undefined` when the frame was routed to a side-channel handler
 *   (extension UI response, host tool/URI frames) or dispatched in the
 *   background (`bash`). Otherwise a promise that resolves once the response
 *   for the command has been emitted via `output`. Errors from `handleCommand`
 *   on non-`bash` commands propagate; the caller is expected to wrap them.
 */
export function dispatchRpcInputFrame(parsed: unknown, deps: RpcInputFrameDeps): Promise<void> | undefined {
	if (dispatchRpcControlFrame(parsed, deps)) return undefined;
	// Regular RPC command. The transport contract states each remaining frame
	// is an {@link RpcCommand}; `handleCommand`'s `default` arm surfaces
	// unknown discriminants as an error response, so we do not shape-check
	// the union here.
	const command = parsed as RpcCommand;

	// Commands dispatched in the background so the stdin loop can keep reading
	// subsequent frames instead of blocking on `await handleCommand`. Two cases:
	//
	//   1. `bash` can run for a long time; backgrounding lets a follow-up
	//      `abort_bash` frame be read and handled while the shell runs.
	//
	//   2. Read-only refreshers that neither read the live turn/session state nor
	//      mutate anything. `new_session`/`switch_session` `await abort()` (which
	//      `await`s `waitForIdle()` — the in-flight LLM turn tearing down), and the
	//      serial loop would otherwise wedge these behind that teardown, freezing
	//      the sidebar for seconds. They query the session-file listing, the git
	//      diff, model/command catalogs, and login providers — none of which depend
	//      on which session is active — so answering them concurrently is safe.
	//      NB: `get_messages`/`get_state` are deliberately NOT here: they read the
	//      *current* session's messages/state and must stay serialized behind a
	//      switch so they never observe a half-swapped session.
	//
	// The response is emitted when `handleCommand` resolves; clients correlate via
	// `command.id` (not stream order), so out-of-order completion is fine.
	const backgroundable =
		command.type === "bash" ||
		command.type === "list_sessions" ||
		command.type === "get_workspace_diff" ||
		command.type === "list_review_commits" ||
		command.type === "get_available_models" ||
		command.type === "get_available_commands" ||
		command.type === "get_login_providers" ||
		command.type === "get_session_stats";
	if (backgroundable) {
		const commandType = command.type;
		const task = (async () => {
			try {
				deps.output(await deps.handleCommand(command));
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				deps.output(deps.errorResponse(command.id, commandType, message));
			}
		})();
		deps.trackBackgroundTask?.(task);
		return undefined;
	}

	return (async () => {
		deps.output(await deps.handleCommand(command));
	})();
}

/** Serializes ordinary RPC commands while allowing control frames to dispatch immediately. */
export class RpcInputDispatcher {
	#tail: Promise<void> = Promise.resolve();
	#tasks = new Set<Promise<void>>();
	readonly #deps: RpcInputFrameDeps;
	readonly #afterSerialCommand: (() => Promise<void>) | undefined;

	constructor(options: { deps: RpcInputFrameDeps; afterSerialCommand?: () => Promise<void> }) {
		this.#deps = options.deps;
		this.#afterSerialCommand = options.afterSerialCommand;
	}

	/** Accept a parsed input frame without blocking the stdin reader. */
	dispatch(parsed: unknown): void {
		try {
			if (dispatchRpcControlFrame(parsed, this.#deps)) return;

			const command = parsed as RpcCommand;
			if (command.type === "bash") {
				dispatchRpcInputFrame(command, this.#deps);
				return;
			}

			const task = this.#tail.then(
				() => this.#dispatchSerialCommand(command),
				() => this.#dispatchSerialCommand(command),
			);
			this.#tail = task.catch(() => {});
			this.#tasks.add(task);
			void task.finally(() => {
				this.#tasks.delete(task);
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.#deps.output(this.#deps.errorResponse(undefined, "parse", `Failed to parse command: ${message}`));
		}
	}

	/** Await every accepted serial command, including commands queued before EOF. */
	async drain(): Promise<void> {
		while (this.#tasks.size > 0) {
			await Promise.allSettled(Array.from(this.#tasks));
		}
	}

	async #dispatchSerialCommand(command: RpcCommand): Promise<void> {
		try {
			const awaited = dispatchRpcInputFrame(command, this.#deps);
			if (awaited) await awaited;
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.#deps.output(this.#deps.errorResponse(command.id, command.type, message));
		} finally {
			await this.#afterSerialCommand?.();
		}
	}
}

/**
 * Coordinates deferred shutdown with in-flight background input tasks.
 *
 * `pi.shutdown()` from an extension only *requests* shutdown; the process must
 * not exit while a background-dispatched command (`bash`, see
 * {@link dispatchRpcInputFrame}) still owes the client a response frame. The
 * coordinator tracks those tasks, re-checks the shutdown request whenever one
 * settles (covering a shutdown requested mid-bash with no follow-up client
 * frame), and drains every tracked task before invoking `performShutdown`.
 * The shutdown sequence is latched so concurrent triggers (input loop and
 * settling tasks) run it exactly once.
 */
export class RpcShutdownCoordinator {
	#tasks = new Set<Promise<void>>();
	#shutdown: Promise<void> | undefined;
	readonly #isShutdownRequested: () => boolean;
	readonly #performShutdown: () => Promise<void>;

	constructor(options: { isShutdownRequested: () => boolean; performShutdown: () => Promise<void> }) {
		this.#isShutdownRequested = options.isShutdownRequested;
		this.#performShutdown = options.performShutdown;
	}

	/**
	 * Track a background input task. When it settles it is untracked and the
	 * shutdown request is re-checked, so a deferred shutdown fires even when
	 * no further client frames arrive.
	 */
	track(task: Promise<void>): void {
		this.#tasks.add(task);
		void task.finally(() => {
			this.#tasks.delete(task);
			// Fire-and-forget: performShutdown ends the process. Rejections are
			// not expected — hook errors are caught inside extensionRunner.emit,
			// and background tasks catch their own dispatch errors.
			void this.checkShutdownRequested();
		});
	}

	/** Await every tracked task, including tasks tracked while draining. */
	async drain(): Promise<void> {
		while (this.#tasks.size > 0) {
			await Promise.allSettled(Array.from(this.#tasks));
		}
	}

	/**
	 * If shutdown was requested, drain background tasks (so every owed
	 * response frame is written) before running the shutdown sequence.
	 */
	checkShutdownRequested(): Promise<void> {
		if (!this.#shutdown) {
			if (!this.#isShutdownRequested()) return Promise.resolve();
			this.#shutdown = this.drain().then(() => this.#performShutdown());
		}
		return this.#shutdown;
	}
}

export type RpcSubagentResetRegistry = Pick<RpcSubagentRegistry, "clear">;

export async function handleRpcSessionChange(
	session: RpcSessionChangeSession,
	command: RpcSessionChangeCommand,
	subagentRegistry?: RpcSubagentResetRegistry,
): Promise<RpcSessionChangeResult> {
	switch (command.type) {
		case "new_session": {
			const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
			const cancelled = !(await session.newSession(options));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "new_session", data: { cancelled } };
		}

		case "switch_session": {
			const cancelled = !(await session.switchSession(command.sessionPath));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "switch_session", data: { cancelled } };
		}

		case "branch": {
			const result = await session.branch(command.entryId);
			if (!result.cancelled) subagentRegistry?.clear();
			return { type: "branch", data: { text: result.selectedText, cancelled: result.cancelled } };
		}
	}
	throw new Error("Unsupported RPC session change command");
}

function normalizeHostToolDefinitions(tools: RpcHostToolDefinition[]): RpcHostToolDefinition[] {
	return tools.map((tool, index) => {
		const name = typeof tool.name === "string" ? tool.name.trim() : "";
		if (!name) {
			throw new Error(`Host tool at index ${index} must provide a non-empty name`);
		}
		const description = typeof tool.description === "string" ? tool.description.trim() : "";
		if (!description) {
			throw new Error(`Host tool "${name}" must provide a non-empty description`);
		}
		if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
			throw new Error(`Host tool "${name}" must provide a JSON Schema object`);
		}
		const label = typeof tool.label === "string" && tool.label.trim() ? tool.label.trim() : name;
		return {
			name,
			label,
			description,
			parameters: tool.parameters,
			hidden: tool.hidden === true,
			loadMode: tool.loadMode ?? "discoverable",
		};
	});
}

function parseValueDialogResponse(
	response: RpcExtensionUIResponse,
	dialogOptions: ExtensionUIDialogOptions | undefined,
): string | undefined {
	if ("cancelled" in response && response.cancelled) {
		if (response.timedOut) dialogOptions?.onTimeout?.();
		return undefined;
	}
	if ("value" in response) return response.value;
	return undefined;
}

function shouldEmitRpcTitles(): boolean {
	const raw = $env.PI_RPC_EMIT_TITLE;
	if (!raw) return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isSubagentSubscriptionLevel(value: unknown): value is RpcSubagentSubscriptionLevel {
	return value === "off" || value === "progress" || value === "events";
}

export function requestRpcEditor(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	title: string,
	prefill?: string,
	dialogOptions?: ExtensionUIDialogOptions,
	editorOptions?: { promptStyle?: boolean },
): Promise<string | undefined> {
	if (dialogOptions?.signal?.aborted) return Promise.resolve(undefined);

	const id = Snowflake.next() as string;
	const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
	let settled = false;

	const cleanup = () => {
		dialogOptions?.signal?.removeEventListener("abort", onAbort);
		pendingRequests.delete(id);
	};
	const finish = (value: string | undefined) => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(value);
	};
	const fail = (error: Error) => {
		if (settled) return;
		settled = true;
		cleanup();
		reject(error);
	};
	const onAbort = () => {
		output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "cancel",
			targetId: id,
		} as RpcExtensionUIRequest);
		finish(undefined);
	};

	dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });
	pendingRequests.set(id, {
		resolve: response => {
			if ("cancelled" in response && response.cancelled) {
				finish(undefined);
			} else if ("value" in response) {
				finish(response.value);
			} else {
				finish(undefined);
			}
		},
		reject: fail,
	});
	output({
		type: "extension_ui_request",
		id,
		method: "editor",
		title,
		prefill,
		promptStyle: editorOptions?.promptStyle,
	} as RpcExtensionUIRequest);
	return promise;
}
/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(
	session: AgentSession,
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
	eventBus?: EventBus,
	mcpManager?: MCPManager,
): Promise<never> {
	// Signal to RPC clients that the server is ready to accept commands
	// Suppress terminal notifications: they write \x07 (BEL) or OSC sequences directly to
	// process.stdout with no newline, which the reader merges with the next JSON line and
	// breaks JSON.parse. In RPC mode stdout is the JSON protocol channel — nothing else
	// may write there.
	process.env.PI_NOTIFICATIONS = "off";

	process.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);
	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		process.stdout.write(`${JSON.stringify(obj)}\n`);
	};
	const emitRpcTitles = shouldEmitRpcTitles();

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};

	const extensionUserMessageTracker = new RpcExtensionUserMessageTracker();

	const pendingExtensionRequests = new RpcPendingExtensionRequests();
	const hostToolBridge = new RpcHostToolBridge(output);
	const hostUriBridge = new RpcHostUriBridge(output);
	const subagentRegistry = eventBus ? new RpcSubagentRegistry(eventBus, output) : undefined;

	// Shutdown request flag (wrapped in object to allow mutation with const)
	const shutdownState = { requested: false };

	/**
	 * Extension UI context that uses the RPC protocol.
	 */
	class RpcExtensionUIContext implements ExtensionUIContext {
		constructor(
			private pendingRequests: Map<string, PendingExtensionRequest>,
			private output: (obj: RpcResponse | RpcExtensionUIRequest | object) => void,
		) {}

		/** Helper for dialog methods with signal/timeout support */
		#createDialogPromise<T>(
			opts: ExtensionUIDialogOptions | undefined,
			defaultValue: T,
			request: Record<string, unknown>,
			parseResponse: (response: RpcExtensionUIResponse) => T,
		): Promise<T> {
			if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

			const id = Snowflake.next() as string;
			const { promise, resolve, reject } = Promise.withResolvers<T>();
			let timeoutId: NodeJS.Timeout | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				this.pendingRequests.delete(id);
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout !== undefined) {
				timeoutId = setTimeout(() => {
					opts.onTimeout?.();
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			this.pendingRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			this.output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
			return promise;
		}

		select(
			title: string,
			options: ExtensionUISelectItem[],
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			return this.#createDialogPromise(
				dialogOptions,
				undefined,
				{
					method: "select",
					title,
					options: options.map(getExtensionUISelectOptionLabel),
					timeout: dialogOptions?.timeout,
				},
				response => parseValueDialogResponse(response, dialogOptions),
			);
		}

		confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
			return this.#createDialogPromise(
				dialogOptions,
				false,
				{ method: "confirm", title, message, timeout: dialogOptions?.timeout },
				response => {
					if ("cancelled" in response && response.cancelled) {
						if (response.timedOut) dialogOptions?.onTimeout?.();
						return false;
					}
					if ("confirmed" in response) return response.confirmed;
					return false;
				},
			);
		}

		input(
			title: string,
			placeholder?: string,
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			return this.#createDialogPromise(
				dialogOptions,
				undefined,
				{ method: "input", title, placeholder, timeout: dialogOptions?.timeout },
				response => parseValueDialogResponse(response, dialogOptions),
			);
		}

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		}

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		}

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		}

		setWorkingMessage(_message?: string): void {
			// Not supported in RPC mode
		}

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				this.output({
					type: "extension_ui_request",
					id: Snowflake.next() as string,
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		}

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		}

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		}

		setTitle(title: string): void {
			// Title updates are low-value noise for most RPC hosts; opt in via PI_RPC_EMIT_TITLE=1.
			if (!emitRpcTitles) return;
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		}

		async custom(): Promise<never> {
			// Custom UI not supported in RPC mode
			return undefined as never;
		}

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		}

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		}

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		}

		async editor(
			title: string,
			prefill?: string,
			dialogOptions?: ExtensionUIDialogOptions,
			editorOptions?: { promptStyle?: boolean },
		): Promise<string | undefined> {
			return requestRpcEditor(this.pendingRequests, this.output, title, prefill, dialogOptions, editorOptions);
		}

		addAutocompleteProvider(): void {
			// Autocomplete provider composition is not supported in RPC mode
		}

		get theme(): Theme {
			return theme;
		}

		getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
			return Promise.resolve([]);
		}

		getTheme(_name: string): Promise<Theme | undefined> {
			return Promise.resolve(undefined);
		}

		setTheme(_theme: string | Theme): Promise<{ success: boolean; error?: string }> {
			// Theme switching not supported in RPC mode
			return Promise.resolve({ success: false, error: "Theme switching not supported in RPC mode" });
		}

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		}

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		}

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		}
	}

	// Wire up UI context for tool execution (ask tool, etc.) and extensions.
	// A single shared instance routes all responses received on stdin to the
	// correct waiting promise regardless of which code path created the request.
	const rpcUiContext = new RpcExtensionUIContext(pendingExtensionRequests, output);
	setToolUIContext?.(rpcUiContext, true);

	// Set up extensions with RPC-based UI context
	await initializeExtensions(session, {
		reportSendError: (action, err) => {
			output(error(undefined, action, err.message));
		},
		reportRuntimeError: err => {
			output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
		},
		onShutdown: () => {
			shutdownState.requested = true;
		},
		trackAgentInvokingMessage: task => {
			extensionUserMessageTracker.trackAgentMessageTask(task);
		},
		uiContext: rpcUiContext,
	});

	// Output all agent events as JSON
	session.subscribe(event => {
		output(event);
	});

	// ── Plan mode ────────────────────────────────────────────────────────────
	// Mirrors AcpAgent's headless plan-mode wiring (acp-agent.ts). The engine
	// primitives (setPlanModeState/setPlanProposalHandler/setPlanReferencePath)
	// are shared; only the approval surface differs — here it routes to the host's
	// confirm dialog via rpcUiContext instead of ACP elicitation.
	const DEFAULT_PLAN_FILE_URL = "local://PLAN.md";

	const toRpcPlanMode = (): RpcPlanModeState | undefined => {
		const state = session.getPlanModeState();
		if (!state?.enabled) return undefined;
		return { enabled: true, planFilePath: state.planFilePath, workflow: state.workflow };
	};

	const emitPlanModeChanged = (): void => {
		output({ type: "plan_mode_changed", planMode: toRpcPlanMode() });
	};

	const resolvePlanFilePath = (planFilePath: string): string => {
		if (planFilePath.startsWith("local:")) {
			const normalized = normalizeLocalScheme(planFilePath);
			return resolveLocalUrlToPath(normalized, {
				getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
				getSessionId: () => session.sessionManager.getSessionId(),
			});
		}
		return path.resolve(session.sessionManager.getCwd(), planFilePath);
	};

	const readPlanFile = async (planFilePath: string): Promise<string | null> => {
		try {
			return await Bun.file(resolvePlanFilePath(planFilePath)).text();
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	};

	/** `local://` URLs of plan files in the session-local root, newest first —
	 *  the `resolveApprovedPlan` fallback for a dropped `extra.title`. */
	const listLocalPlanFiles = async (): Promise<string[]> => {
		const localRoot = resolvePlanFilePath("local://");
		try {
			const entries = await fs.readdir(localRoot, { withFileTypes: true });
			const plans = await Promise.all(
				entries
					.filter(entry => entry.isFile() && /plan\.md$/i.test(entry.name))
					.map(async entry => {
						const stat = await fs.stat(path.join(localRoot, entry.name)).catch(() => null);
						return { url: `local://${entry.name}`, mtime: stat?.mtimeMs ?? 0 };
					}),
			);
			return plans.sort((a, b) => b.mtime - a.mtime).map(plan => plan.url);
		} catch {
			return [];
		}
	};

	/** Ask the host to approve the finalized plan. Returns true only on explicit
	 *  confirmation; dismissal/cancel/timeout falls through to refine semantics so
	 *  closing the dialog can never grant write access. */
	const requestPlanApprovalChoice = async (title: string, planContent: string): Promise<boolean> => {
		const previewLines = planContent.split("\n").slice(0, 12).join("\n");
		const ellipsis = planContent.split("\n").length > 12 ? "\n…" : "";
		const message = `Approve plan "${title}" and start implementation?\n\n${previewLines}${ellipsis}`;
		return rpcUiContext.confirm(`Plan ready: ${title}`, message);
	};

	/** Plan-proposal handler installed while plan mode is active. The agent
	 *  submits the finalized plan by writing its title to `xd://propose`;
	 *  this validates the plan file, asks the host to confirm, and on approval sets
	 *  the plan reference and exits plan mode so the agent regains full tools. On
	 *  refine, plan mode stays active so the agent keeps iterating. */
	const handlePlanProposal = async (suppliedTitle: string): Promise<AgentToolResult<unknown>> => {
		const state = session.getPlanModeState();
		if (!state?.enabled) {
			throw new ToolError("Plan mode is not active.");
		}
		const { planFilePath, planContent, title } = await resolveApprovedPlan({
			suppliedTitle,
			statePlanFilePath: state.planFilePath,
			readPlan: url => readPlanFile(url),
			listPlanFiles: () => listLocalPlanFiles(),
		});
		const details: PlanApprovalDetails = { planFilePath, title, planExists: true };
		const approved = await requestPlanApprovalChoice(title, planContent);
		if (!approved) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Plan refinement requested. Update the plan file, then write ${title} to xd://propose again when ready.`,
					},
				],
				details,
			};
		}

		session.setPlanReferencePath(planFilePath);
		session.setPlanProposalHandler(null);
		session.setPlanModeState(undefined);
		emitPlanModeChanged();
		return {
			content: [
				{
					type: "text" as const,
					text: `Plan approved at ${planFilePath}. Plan mode exited; proceed with the implementation.`,
				},
			],
			details,
		};
	};

	const getAvailableCommands = async () => buildAvailableSlashCommands(session);
	const reloadPluginState = async () => {
		const cwd = session.sessionManager.getCwd();
		const projectPath = await resolveActiveProjectRegistryPath(cwd);
		clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
		resetCapabilities();
		await session.refreshSkills();
		session.setSlashCommands(await loadSlashCommands({ cwd }));
		await emitAvailableCommandsUpdate();
	};
	const emitAvailableCommandsUpdate = async () => {
		output({ type: "available_commands_update", commands: await getAvailableCommands() });
	};
	session.subscribeCommandMetadataChanged(() => {
		void emitAvailableCommandsUpdate();
	});
	await emitAvailableCommandsUpdate();
	const reloadMcpRuntime = async () => {
		if (!mcpManager) throw new Error("MCP is not enabled for this session");
		await mcpManager.disconnectAll();
		const result = await mcpManager.discoverAndConnect({
			enableProjectConfig: session.settings.get("mcp.enableProjectConfig") ?? true,
			filterExa: true,
			filterBrowser: session.settings.get("browser.enabled") ?? false,
		});
		await session.refreshMCPTools(mcpManager.getTools());
		return {
			servers: mcpManager.getAllServerNames().length,
			connected: mcpManager.getConnectedServers().length,
			toolCount: mcpManager.getTools().length,
			errors: Array.from(result.errors, ([serverName, message]) => ({ serverName, message })),
		};
	};

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
		const id = command.id;

		switch (command.type) {
			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				const skillResult = await tryRunRpcSkillCommand(session, command.message, command.streamingBehavior);
				if (skillResult) {
					return success(id, "prompt", skillResult);
				}
				const builtinResult = await executeAcpBuiltinSlashCommand(command.message, {
					session,
					sessionManager: session.sessionManager,
					settings: session.settings,
					cwd: session.sessionManager.getCwd(),
					output: text => output({ type: "command_output", text }),
					refreshCommands: emitAvailableCommandsUpdate,
					reloadPlugins: reloadPluginState,
					notifyTitleChanged: async () => {
						output({ type: "session_info_update", title: session.sessionName, sessionId: session.sessionId });
					},
					notifyConfigChanged: async () => {
						output({ type: "config_update", model: session.model, thinkingLevel: session.thinkingLevel });
					},
				});
				if (builtinResult !== false) {
					if ("prompt" in builtinResult) {
						watchAndReportLocalOnlyPromptResult({
							id,
							startPrompt: () => session.prompt(builtinResult.prompt, { images: command.images }),
							output,
							onError: promptError => output(error(id, "prompt", promptError.message)),
							extensionUserMessageTracker,
						});
						return success(id, "prompt");
					}
					return success(id, "prompt", { agentInvoked: false });
				}

				// Don't await - events will stream
				// Extension commands are executed immediately, file prompt templates are expanded
				// If streaming and streamingBehavior specified, queues via steer/followUp
				watchAndReportLocalOnlyPromptResult({
					id,
					startPrompt: () =>
						session.prompt(command.message, {
							images: command.images,
							streamingBehavior: command.streamingBehavior,
						}),
					output,
					onError: promptError => output(error(id, "prompt", promptError.message)),
					extensionUserMessageTracker,
				});
				return success(id, "prompt");
			}

			case "steer": {
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "abort": {
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				return success(id, "abort");
			}

			case "abort_and_prompt": {
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				session
					.prompt(command.message, { images: command.images })
					.catch(e => output(error(id, "abort_and_prompt", e.message)));
				return success(id, "abort_and_prompt");
			}

			case "new_session":
			case "switch_session":
			case "branch": {
				const result = await handleRpcSessionChange(session, command, subagentRegistry);
				if (!result.data.cancelled) await emitAvailableCommandsUpdate();
				return success(id, result.type, result.data);
			}

			case "set_workspace": {
				// Re-root the live engine at a new project directory WITHOUT respawning
				// (mirrors the TUI `/move` + `applyCwdChange` path). The desktop app
				// calls this when the user switches projects so a fresh task opens in
				// the new directory while the process, credentials, and RPC stream all
				// stay alive.
				if (session.isStreaming) {
					return error(id, "set_workspace", "Cannot switch workspace while a response is in progress");
				}
				const newCwd = path.resolve(command.cwd);
				try {
					const stat = await fs.stat(newCwd);
					if (!stat.isDirectory()) {
						return error(id, "set_workspace", `Not a directory: ${newCwd}`);
					}
				} catch {
					return error(id, "set_workspace", `Directory does not exist: ${newCwd}`);
				}
				// Open a fresh task first, then anchor it to the new project directory.
				// The new (empty) session file has not been written to disk yet, so
				// moveTo just re-points cwd/sessionDir — the previous session stays put
				// in its own project.
				await session.newSession();
				await session.sessionManager.moveTo(newCwd);
				subagentRegistry?.clear();
				setProjectDir(newCwd);
				await session.settings.reloadForCwd(newCwd);
				applyProviderGlobalsFromSettings(session.settings);
				await reloadPluginState();
				output({ type: "session_info_update", title: session.sessionName, sessionId: session.sessionId });
				output({ type: "config_update", model: session.model, thinkingLevel: session.thinkingLevel });
				return success(id, "set_workspace", { cwd: session.sessionManager.getCwd() });
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					configuredThinkingLevel: session.configuredThinkingLevel(),
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					interruptMode: session.interruptMode,
					approvalMode: session.settings.get("tools.approvalMode"),
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					autoRetryEnabled: session.autoRetryEnabled,
					messageCount: session.messages.length,
					queuedMessageCount: session.queuedMessageCount,
					todoPhases: session.getTodoPhases(),
					systemPrompt: session.systemPrompt,
					dumpTools: session.agent.state.tools.map(tool => ({
						name: tool.name,
						description: tool.description,
						parameters: isZodSchema(tool.parameters) ? zodToWireSchema(tool.parameters) : tool.parameters,
						examples: tool.examples,
					})),
					contextUsage: session.getContextUsage(),
					contextBreakdown: session.getContextBreakdown(),
					planMode: toRpcPlanMode(),
					goalMode: session.getGoalModeState(),
				};
				return success(id, "get_state", state);
			}

			case "get_goal": {
				const state = session.getGoalModeState() ?? null;
				return success(id, "get_goal", { goal: state?.goal ?? null, state });
			}

			case "create_goal": {
				if (!session.settings.get("goal.enabled")) {
					return error(id, "create_goal", "Goal mode is disabled (goal.enabled = false).");
				}
				if (session.isStreaming) {
					return error(id, "create_goal", "Cannot create a goal while a response is in progress");
				}
				if (session.getPlanModeState()?.enabled) {
					return error(id, "create_goal", "Exit plan mode before creating a goal");
				}
				try {
					const state = await session.goalRuntime.createGoal({
						objective: command.objective,
						tokenBudget: command.tokenBudget,
					});
					const tools = session.getEnabledToolNames().filter(name => name !== "goal");
					await session.setActiveToolsByName([...tools, "goal"]);
					return success(id, "create_goal", { goal: state.goal, state });
				} catch (err: unknown) {
					return error(id, "create_goal", err instanceof Error ? err.message : String(err));
				}
			}

			case "pause_goal": {
				if (session.isStreaming) {
					return error(id, "pause_goal", "Cannot pause a goal while a response is in progress");
				}
				try {
					const state = (await session.goalRuntime.pauseGoal()) ?? null;
					await session.setActiveToolsByName(session.getEnabledToolNames().filter(name => name !== "goal"));
					return success(id, "pause_goal", { goal: state?.goal ?? null, state });
				} catch (err: unknown) {
					return error(id, "pause_goal", err instanceof Error ? err.message : String(err));
				}
			}

			case "resume_goal": {
				if (!session.settings.get("goal.enabled")) {
					return error(id, "resume_goal", "Goal mode is disabled (goal.enabled = false).");
				}
				if (session.isStreaming) {
					return error(id, "resume_goal", "Cannot resume a goal while a response is in progress");
				}
				if (session.getPlanModeState()?.enabled) {
					return error(id, "resume_goal", "Exit plan mode before resuming a goal");
				}
				try {
					const state = await session.goalRuntime.resumeGoal();
					const tools = session.getEnabledToolNames().filter(name => name !== "goal");
					await session.setActiveToolsByName([...tools, "goal"]);
					return success(id, "resume_goal", { goal: state.goal, state });
				} catch (err: unknown) {
					return error(id, "resume_goal", err instanceof Error ? err.message : String(err));
				}
			}

			case "drop_goal": {
				if (session.isStreaming) {
					return error(id, "drop_goal", "Cannot drop a goal while a response is in progress");
				}
				try {
					const goal = (await session.goalRuntime.dropGoal()) ?? null;
					await session.setActiveToolsByName(session.getEnabledToolNames().filter(name => name !== "goal"));
					return success(id, "drop_goal", { goal, state: null });
				} catch (err: unknown) {
					return error(id, "drop_goal", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_settings": {
				try {
					return success(
						id,
						"get_settings",
						await buildRpcSettingsSnapshot(session.settings, session.sessionManager.getCwd()),
					);
				} catch (err) {
					return error(id, "get_settings", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_setting": {
				if (session.isStreaming)
					return error(id, "set_setting", "Cannot change settings while a response is in progress");
				try {
					const setting = await setRpcSetting(session.settings, command.path, command.value);
					if (setting.path === "retry.enabled") session.setAutoRetryEnabled(setting.value === true);
					if (setting.path === "compaction.enabled") session.setAutoCompactionEnabled(setting.value === true);
					if (setting.path === "mcp.notifications") mcpManager?.setNotificationsEnabled(setting.value === true);
					if (setting.category === "providers") {
						applyProviderGlobalsFromSettings(session.settings);
						await session.modelRegistry.refresh();
					}
					if (setting.category === "skills") await session.refreshSkills();
					else if (["tools", "memory"].includes(setting.category)) await session.refreshBaseSystemPrompt();
					return success(id, "set_setting", setting);
				} catch (err) {
					return error(id, "set_setting", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_plugin_enabled": {
				if (session.isStreaming)
					return error(id, "set_plugin_enabled", "Cannot change plugins while a response is in progress");
				try {
					const plugin = await setRpcPluginEnabled(session.sessionManager.getCwd(), command.name, command.enabled);
					await reloadPluginState();
					return success(id, "set_plugin_enabled", plugin);
				} catch (err) {
					return error(id, "set_plugin_enabled", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_plugin_features": {
				if (session.isStreaming)
					return error(id, "set_plugin_features", "Cannot change plugins while a response is in progress");
				try {
					const plugin = await setRpcPluginFeatures(
						session.sessionManager.getCwd(),
						command.name,
						command.features,
					);
					await reloadPluginState();
					return success(id, "set_plugin_features", plugin);
				} catch (err) {
					return error(id, "set_plugin_features", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_plugin_setting":
			case "delete_plugin_setting": {
				if (session.isStreaming)
					return error(id, command.type, "Cannot change plugin settings while a response is in progress");
				try {
					const plugin =
						command.type === "set_plugin_setting"
							? await setRpcPluginSetting(
									session.sessionManager.getCwd(),
									command.name,
									command.key,
									command.value,
								)
							: await deleteRpcPluginSetting(session.sessionManager.getCwd(), command.name, command.key);
					await reloadPluginState();
					return success(id, command.type, plugin);
				} catch (err) {
					return error(id, command.type, err instanceof Error ? err.message : String(err));
				}
			}

			case "install_plugin":
			case "update_plugin": {
				if (session.isStreaming)
					return error(id, command.type, "Cannot change plugins while a response is in progress");
				try {
					const manager = new PluginManager(session.sessionManager.getCwd());
					const installed = await manager.install(command.type === "install_plugin" ? command.spec : command.name);
					await reloadPluginState();
					return success(
						id,
						command.type,
						await getRpcPluginDescriptor(session.sessionManager.getCwd(), installed.name),
					);
				} catch (err) {
					return error(id, command.type, err instanceof Error ? err.message : String(err));
				}
			}

			case "uninstall_plugin": {
				if (session.isStreaming)
					return error(id, "uninstall_plugin", "Cannot change plugins while a response is in progress");
				try {
					await new PluginManager(session.sessionManager.getCwd()).uninstall(command.name);
					await reloadPluginState();
					return success(id, "uninstall_plugin", { name: command.name });
				} catch (err) {
					return error(id, "uninstall_plugin", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_marketplace": {
				try {
					return success(
						id,
						"get_marketplace",
						await buildRpcMarketplaceSnapshot(session.sessionManager.getCwd()),
					);
				} catch (err) {
					return error(id, "get_marketplace", err instanceof Error ? err.message : String(err));
				}
			}

			case "add_marketplace":
			case "update_marketplace":
			case "remove_marketplace": {
				if (session.isStreaming)
					return error(id, command.type, "Cannot change marketplaces while a response is in progress");
				try {
					const cwd = session.sessionManager.getCwd();
					const manager = await createRpcMarketplaceManager(cwd);
					if (command.type === "add_marketplace") {
						await manager.addMarketplace(command.source);
					} else if (command.type === "update_marketplace") {
						await manager.updateMarketplace(command.name);
					} else {
						await manager.removeMarketplace(command.name);
					}
					return success(id, command.type, await buildRpcMarketplaceSnapshot(cwd));
				} catch (err) {
					return error(id, command.type, err instanceof Error ? err.message : String(err));
				}
			}

			case "install_marketplace_plugin":
			case "upgrade_marketplace_plugin":
			case "uninstall_marketplace_plugin":
			case "set_marketplace_plugin_enabled": {
				if (session.isStreaming)
					return error(id, command.type, "Cannot change marketplace plugins while a response is in progress");
				try {
					const cwd = session.sessionManager.getCwd();
					const manager = await createRpcMarketplaceManager(cwd);
					if (command.type === "install_marketplace_plugin") {
						await manager.installPlugin(command.name, command.marketplace, { scope: command.scope });
					} else if (command.type === "upgrade_marketplace_plugin") {
						await manager.upgradePlugin(command.pluginId, command.scope);
					} else if (command.type === "uninstall_marketplace_plugin") {
						await manager.uninstallPlugin(command.pluginId, command.scope);
					} else {
						await manager.setPluginEnabled(command.pluginId, command.enabled, command.scope);
					}
					await reloadPluginState();
					return success(id, command.type, await buildRpcMarketplaceSnapshot(cwd));
				} catch (err) {
					return error(id, command.type, err instanceof Error ? err.message : String(err));
				}
			}

			case "get_available_commands": {
				return success(id, "get_available_commands", { commands: await getAvailableCommands() });
			}

			case "set_todos": {
				session.setTodoPhases(command.phases);
				return success(id, "set_todos", { todoPhases: session.getTodoPhases() });
			}

			case "set_host_tools": {
				const tools = normalizeHostToolDefinitions(command.tools);
				const rpcTools = hostToolBridge.setTools(tools);
				await session.refreshRpcHostTools(rpcTools);
				return success(id, "set_host_tools", { toolNames: tools.map(tool => tool.name) });
			}

			case "set_host_uri_schemes": {
				try {
					const schemes = hostUriBridge.setSchemes(command.schemes);
					return success(id, "set_host_uri_schemes", { schemes });
				} catch (err) {
					return error(id, "set_host_uri_schemes", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_subagent_subscription": {
				if (!subagentRegistry) {
					return error(id, "set_subagent_subscription", "Subagent event bus is unavailable");
				}
				if (!isSubagentSubscriptionLevel(command.level)) {
					return error(
						id,
						"set_subagent_subscription",
						`Invalid subagent subscription level: ${String(command.level)}`,
					);
				}
				subagentRegistry.setSubscriptionLevel(command.level);
				return success(id, "set_subagent_subscription", { level: subagentRegistry.getSubscriptionLevel() });
			}

			case "get_subagents": {
				if (!subagentRegistry) {
					return error(id, "get_subagents", "Subagent event bus is unavailable");
				}
				return success(id, "get_subagents", { subagents: subagentRegistry.getSubagents() });
			}

			case "get_subagent_messages": {
				if (!subagentRegistry) {
					return error(id, "get_subagent_messages", "Subagent event bus is unavailable");
				}
				try {
					if (command.fromByte !== undefined && !Number.isFinite(command.fromByte)) {
						return error(id, "get_subagent_messages", "fromByte must be a finite number");
					}
					const sessionFile = subagentRegistry.resolveSessionFile(command);
					const transcript = await readRpcSubagentTranscript(sessionFile, command.fromByte);
					return success(id, "get_subagent_messages", transcript);
				} catch (err) {
					return error(id, "get_subagent_messages", err instanceof Error ? err.message : String(err));
				}
			}

			case "read_artifact": {
				try {
					const requestedBytes = command.maxBytes ?? DEFAULT_ARTIFACT_PREVIEW_BYTES;
					if (!Number.isFinite(requestedBytes) || requestedBytes < 1) {
						return error(id, "read_artifact", "maxBytes must be a positive finite number");
					}
					const artifact = await session.sessionManager.readArtifact(
						command.artifactId,
						Math.min(Math.trunc(requestedBytes), MAX_ARTIFACT_PREVIEW_BYTES),
					);
					if (!artifact) return error(id, "read_artifact", `Artifact not found: ${command.artifactId}`);
					return success(id, "read_artifact", artifact);
				} catch (err) {
					return error(id, "read_artifact", err instanceof Error ? err.message : String(err));
				}
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const models = session.getAvailableModels();
				const model = models.find(m => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				const models = session.getAvailableModels();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			case "set_interrupt_mode": {
				session.setInterruptMode(command.mode);
				return success(id, "set_interrupt_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			case "set_approval_mode": {
				session.settings.override("tools.approvalMode", command.mode);
				return success(id, "set_approval_mode", { mode: session.settings.get("tools.approvalMode") });
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const result = await session.executeBash(command.command);
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "list_sessions": {
				const activePath = session.sessionFile;
				const infos = await SessionManager.list(session.sessionManager.getCwd());
				const sessions: RpcSessionSummary[] = infos.map(info => ({
					path: info.path,
					id: info.id,
					title: info.title,
					messageCount: info.messageCount,
					created: info.created.toISOString(),
					modified: info.modified.toISOString(),
					active: activePath !== undefined && info.path === activePath,
				}));
				return success(id, "list_sessions", { sessions });
			}

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "get_workspace_diff": {
				try {
					const files = await buildWorkspaceDiff(
						session.sessionManager.getCwd(),
						command.scope ?? "all",
						command.ref,
					);
					return success(id, "get_workspace_diff", { files });
				} catch (err) {
					return error(id, "get_workspace_diff", err instanceof Error ? err.message : String(err));
				}
			}

			case "list_review_commits": {
				try {
					const limit = Math.max(1, Math.min(command.limit ?? 12, 30));
					const commits = await git.log.recent(session.sessionManager.getCwd(), limit);
					return success(id, "list_review_commits", { commits });
				} catch (err) {
					return error(id, "list_review_commits", err instanceof Error ? err.message : String(err));
				}
			}

			case "list_workspace_files": {
				try {
					return success(
						id,
						"list_workspace_files",
						await listWorkspaceEntries(session.sessionManager.getCwd(), command.query ?? "", command.limit),
					);
				} catch (err) {
					return error(id, "list_workspace_files", err instanceof Error ? err.message : String(err));
				}
			}

			case "read_workspace_file": {
				try {
					const cwd = session.sessionManager.getCwd();
					const resolved = await resolveWorkspaceFile(cwd, command.path.trim());
					const stat = await fs.stat(resolved);
					if (!stat.isFile()) return error(id, "read_workspace_file", "Path is not a file");
					const maxBytes = Math.max(
						1,
						Math.min(MAX_FILE_PREVIEW_BYTES, command.maxBytes ?? DEFAULT_FILE_PREVIEW_BYTES),
					);
					const bytes = await Bun.file(resolved)
						.slice(0, maxBytes + 1)
						.bytes();
					const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
					if (sample.includes(0)) return error(id, "read_workspace_file", "Binary files cannot be previewed");
					const truncated = bytes.length > maxBytes;
					const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, maxBytes));
					return success(id, "read_workspace_file", {
						path: path.relative(cwd, resolved).split(path.sep).join("/"),
						content,
						size: stat.size,
						truncated,
					});
				} catch (err) {
					const message =
						err instanceof TypeError
							? "File is not valid UTF-8 text"
							: err instanceof Error
								? err.message
								: String(err);
					return error(id, "read_workspace_file", message);
				}
			}

			case "get_context_snapshot": {
				return success(id, "get_context_snapshot", {
					skills: session.skills.map(skill => skill.name),
					memoryBackend: session.settings.get("memory.backend") || null,
					skillDetails: session.skills.map(skill => ({
						name: skill.name,
						description: skill.description,
						filePath: skill.filePath,
						source: skill.source,
						provider: skill._source?.provider ?? skill.source.split(":", 1)[0] ?? "unknown",
						providerName: skill._source?.providerName ?? skill.source.split(":", 1)[0] ?? "Unknown",
						level: skill._source?.level ?? "user",
						hidden: skill.hide,
					})),
					skillWarnings: session.skillWarnings,
				});
			}

			case "reload_skills": {
				try {
					await session.refreshSkills();
					return success(id, "reload_skills", { skills: session.skills.map(skill => skill.name) });
				} catch (err) {
					return error(id, "reload_skills", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_skill_enabled": {
				const name = command.name.trim();
				if (!name) return error(id, "set_skill_enabled", "Skill name cannot be empty");
				const ignored = session.settings.get("skills.ignoredSkills") ?? [];
				if (!ignored.includes(name) && !session.skills.some(skill => skill.name === name))
					return error(id, "set_skill_enabled", `Skill not found: ${name}`);
				try {
					const nextIgnored = command.enabled
						? ignored.filter(skillName => skillName !== name)
						: [...new Set([...ignored, name])];
					session.settings.set("skills.ignoredSkills", nextIgnored);
					await session.settings.flush();
					await session.refreshSkills();
					return success(id, "set_skill_enabled", {
						name,
						enabled: command.enabled,
						skills: session.skills.map(skill => skill.name),
					});
				} catch (err) {
					return error(id, "set_skill_enabled", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_mcp_status": {
				return success(id, "get_mcp_status", { servers: mcpManager?.getStatusSnapshot() ?? [] });
			}

			case "add_mcp_server": {
				if (!mcpManager) return error(id, "add_mcp_server", "MCP is not enabled for this session");
				try {
					const cwd = session.sessionManager.getCwd();
					await addMCPServer(getMCPConfigPath(command.scope, cwd), command.name, command.config);
					await reloadMcpRuntime();
					return success(id, "add_mcp_server", {
						serverName: command.name,
						scope: command.scope,
						status: mcpManager.getConnectionStatus(command.name),
						toolCount: mcpManager.getTools().filter(tool => tool.mcpServerName === command.name).length,
					});
				} catch (err) {
					return error(id, "add_mcp_server", err instanceof Error ? err.message : String(err));
				}
			}

			case "remove_mcp_server": {
				if (!mcpManager) return error(id, "remove_mcp_server", "MCP is not enabled for this session");
				try {
					const cwd = session.sessionManager.getCwd();
					await removeMCPServer(getMCPConfigPath(command.scope, cwd), command.serverName);
					await reloadMcpRuntime();
					return success(id, "remove_mcp_server", {
						serverName: command.serverName,
						scope: command.scope,
						removed: true,
					});
				} catch (err) {
					return error(id, "remove_mcp_server", err instanceof Error ? err.message : String(err));
				}
			}

			case "test_mcp_server": {
				if (!mcpManager) return error(id, "test_mcp_server", "MCP is not enabled for this session");
				try {
					const config = mcpManager.getServerConfig(command.serverName);
					if (!config) return error(id, "test_mcp_server", `MCP server not found: ${command.serverName}`);
					const resolved = await mcpManager.prepareConfig(config);
					const connection = await connectToServer(`rpc-test-${command.serverName}`, resolved);
					const serverInfo = connection.serverInfo;
					await disconnectServer(connection);
					return success(id, "test_mcp_server", {
						serverName: command.serverName,
						connected: true,
						serverInfo,
					});
				} catch (err) {
					return error(id, "test_mcp_server", err instanceof Error ? err.message : String(err));
				}
			}

			case "reload_mcp": {
				try {
					return success(id, "reload_mcp", await reloadMcpRuntime());
				} catch (err) {
					return error(id, "reload_mcp", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_mcp_capabilities": {
				if (!mcpManager) return error(id, "get_mcp_capabilities", "MCP is not enabled for this session");
				try {
					const connected = mcpManager.getConnectedServers();
					await Promise.all(
						connected.flatMap(serverName => [
							mcpManager.refreshServerResources(serverName),
							mcpManager.refreshServerPrompts(serverName),
						]),
					);
					const notificationState = mcpManager.getNotificationState();
					return success(id, "get_mcp_capabilities", {
						resources: connected.map(serverName => ({
							serverName,
							...(mcpManager.getServerResources(serverName) ?? { resources: [], templates: [] }),
						})),
						prompts: connected.map(serverName => ({
							serverName,
							prompts: mcpManager.getServerPrompts(serverName) ?? [],
						})),
						notifications: {
							enabled: notificationState.enabled,
							servers: connected.map(serverName => {
								const capabilities = mcpManager.getConnection(serverName)?.capabilities;
								return {
									serverName,
									toolsChanged: capabilities?.tools?.listChanged === true,
									resourcesChanged: capabilities?.resources?.listChanged === true,
									promptsChanged: capabilities?.prompts?.listChanged === true,
									resourceSubscriptions: Array.from(notificationState.subscriptions.get(serverName) ?? []),
								};
							}),
						},
					});
				} catch (err) {
					return error(id, "get_mcp_capabilities", err instanceof Error ? err.message : String(err));
				}
			}

			case "reconnect_mcp": {
				if (!mcpManager) return error(id, "reconnect_mcp", "MCP is not enabled for this session");
				try {
					if (mcpManager.getServerConfig(command.serverName)?.enabled === false)
						return error(id, "reconnect_mcp", `MCP server is disabled: ${command.serverName}`);
					const connection = await mcpManager.reconnectServer(command.serverName, { manual: true });
					if (!connection) return error(id, "reconnect_mcp", `MCP server not found: ${command.serverName}`);
					await session.refreshMCPTools(mcpManager.getTools());
					return success(id, "reconnect_mcp", {
						serverName: command.serverName,
						status: mcpManager.getConnectionStatus(command.serverName),
						toolCount: mcpManager.getTools().filter(tool => tool.mcpServerName === command.serverName).length,
					});
				} catch (err) {
					return error(id, "reconnect_mcp", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_mcp_enabled": {
				if (!mcpManager) return error(id, "set_mcp_enabled", "MCP is not enabled for this session");
				const source = mcpManager.getSource(command.serverName);
				const sourcePath =
					source && /(?:^|[\\/])(?:\.mcp\.json|mcp\.json)$/.test(source.path) ? source.path : undefined;
				try {
					await setMcpServerEnabled({
						userPath: path.join(getAgentDir(), "mcp.json"),
						projectPath: path.join(session.sessionManager.getCwd(), ".omp", "mcp.json"),
						sourcePath,
						name: command.serverName,
						enabled: command.enabled,
					});
					const currentConfig = mcpManager.getServerConfig(command.serverName);
					if (!currentConfig) return error(id, "set_mcp_enabled", `MCP server not found: ${command.serverName}`);
					mcpManager.setServerConfig(command.serverName, { ...currentConfig, enabled: command.enabled });
					if (command.enabled) {
						const connection = await mcpManager.reconnectServer(command.serverName, { manual: true });
						if (!connection)
							return error(id, "set_mcp_enabled", `MCP server could not be enabled: ${command.serverName}`);
					} else {
						await mcpManager.disconnectServer(command.serverName, { preserveRegistration: true });
					}
					await session.refreshMCPTools(mcpManager.getTools());
					return success(id, "set_mcp_enabled", { serverName: command.serverName, enabled: command.enabled });
				} catch (err) {
					return error(id, "set_mcp_enabled", err instanceof Error ? err.message : String(err));
				}
			}

			case "unauth_mcp": {
				if (!mcpManager) return error(id, "unauth_mcp", "MCP is not enabled for this session");
				try {
					const config = mcpManager.getServerConfig(command.serverName);
					if (!config) return error(id, "unauth_mcp", `MCP server not found: ${command.serverName}`);
					const authStorage = session.modelRegistry.authStorage;
					const currentAuth = (config as MCPServerConfig & { auth?: MCPAuthConfig }).auth;
					let removed = false;
					if (currentAuth?.type === "oauth") {
						removed = await removeManagedMcpOAuthCredential(authStorage, currentAuth.credentialId);
					}
					if ((config.type === "http" || config.type === "sse") && config.url) {
						removed =
							(await removeManagedMcpOAuthCredentials(
								authStorage,
								mcpOAuthCredentialIdsForServerUrl(config.url),
							)) || removed;
					}

					const updated = { ...config } as MCPServerConfig & { auth?: MCPAuthConfig };
					if (currentAuth?.type === "oauth") {
						delete updated.auth;
						const source = mcpManager.getSource(command.serverName);
						const sourcePath =
							source && /(?:^|[\\/])(?:\.mcp\.json|mcp\.json)$/.test(source.path)
								? source.path
								: path.join(getAgentDir(), "mcp.json");
						await updateMCPServer(sourcePath, command.serverName, updated);
					}

					mcpManager.setServerConfig(command.serverName, updated);
					await mcpManager.disconnectServer(command.serverName, { preserveRegistration: true });
					await session.refreshMCPTools(mcpManager.getTools());
					return success(id, "unauth_mcp", {
						serverName: command.serverName,
						removed,
						status: "disconnected",
					});
				} catch (err) {
					return error(id, "unauth_mcp", err instanceof Error ? err.message : String(err));
				}
			}

			case "reauth_mcp": {
				if (!mcpManager) return error(id, "reauth_mcp", "MCP is not enabled for this session");
				try {
					const config = mcpManager.getServerConfig(command.serverName);
					if (!config) return error(id, "reauth_mcp", `MCP server not found: ${command.serverName}`);
					if (config.enabled === false)
						return error(id, "reauth_mcp", `MCP server is disabled: ${command.serverName}`);
					const result = await reauthorizeRpcMcpServer(config, mcpManager, session.modelRegistry.authStorage, {
						onAuth: info => {
							output({
								type: "extension_ui_request",
								id: Snowflake.next() as string,
								method: "open_url",
								url: info.url,
								launchUrl: info.launchUrl,
								instructions: info.instructions,
							} as RpcExtensionUIRequest);
						},
						onProgress: message => rpcUiContext.notify(message, "info"),
						onManualCodeInput: async () =>
							(await rpcUiContext.input("Paste the MCP OAuth redirect URL or authorization code", undefined, {
								timeout: 600_000,
							})) ?? "",
					});
					if (result.persistConfig) {
						const source = mcpManager.getSource(command.serverName);
						const sourcePath =
							source && /(?:^|[\\/])(?:\.mcp\.json|mcp\.json)$/.test(source.path)
								? source.path
								: path.join(getAgentDir(), "mcp.json");
						await updateMCPServer(sourcePath, command.serverName, result.config);
					}
					mcpManager.setServerConfig(command.serverName, result.config);
					const connection = await mcpManager.reconnectServer(command.serverName, { manual: true });
					if (!connection)
						return error(
							id,
							"reauth_mcp",
							`MCP authorization succeeded but reconnect failed: ${command.serverName}`,
						);
					await session.refreshMCPTools(mcpManager.getTools());
					return success(id, "reauth_mcp", {
						serverName: command.serverName,
						status: mcpManager.getConnectionStatus(command.serverName),
						toolCount: mcpManager.getTools().filter(tool => tool.mcpServerName === command.serverName).length,
					});
				} catch (err) {
					return error(id, "reauth_mcp", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_memory_status": {
				const runtime = createSessionMemoryRuntimeContext(session, getAgentDir(), session.sessionManager.getCwd());
				try {
					return success(id, "get_memory_status", await runtime.status());
				} catch (err) {
					return error(id, "get_memory_status", err instanceof Error ? err.message : String(err));
				}
			}

			case "search_memory": {
				const runtime = createSessionMemoryRuntimeContext(session, getAgentDir(), session.sessionManager.getCwd());
				try {
					return success(id, "search_memory", await runtime.search(command.query, { limit: command.limit }));
				} catch (err) {
					return error(id, "search_memory", err instanceof Error ? err.message : String(err));
				}
			}

			case "save_memory": {
				const runtime = createSessionMemoryRuntimeContext(session, getAgentDir(), session.sessionManager.getCwd());
				try {
					return success(
						id,
						"save_memory",
						await runtime.save({
							content: command.content,
							...(command.context !== undefined ? { context: command.context } : {}),
							...(command.source !== undefined ? { source: command.source } : {}),
							...(command.importance !== undefined ? { importance: command.importance } : {}),
						}),
					);
				} catch (err) {
					return error(id, "save_memory", err instanceof Error ? err.message : String(err));
				}
			}

			case "enqueue_memory":
			case "clear_memory": {
				try {
					const result = await runMemoryBackendAction(
						{ session, agentDir: getAgentDir(), cwd: session.sessionManager.getCwd() },
						command.type === "clear_memory" ? "clear" : "enqueue",
					);
					if (command.type === "clear_memory") await session.refreshBaseSystemPrompt();
					return success(id, command.type, result);
				} catch (err) {
					return error(id, command.type, err instanceof Error ? err.message : String(err));
				}
			}

			case "browser_open": {
				try {
					const url = validateBrowserUrl(command.url);
					const name = command.name?.trim() || "main";
					await executeBrowserRpc(session, { action: "open", name });
					const result = await executeBrowserRpc(session, {
						action: "run",
						name,
						code: desktopBrowserNavigationCode(url),
					});
					return success(id, "browser_open", {
						name,
						url: result.details?.url ?? url,
						text: browserResultText(result),
					});
				} catch (err) {
					return error(id, "browser_open", err instanceof Error ? err.message : String(err));
				}
			}

			case "browser_list_tabs":
				return success(id, "browser_list_tabs", { tabs: listTabs(), downloadPolicy: "deny" });

			case "browser_close": {
				try {
					const text = browserResultText(
						await executeBrowserRpc(session, {
							action: "close",
							name: command.name?.trim() || "main",
							all: command.all,
						}),
					);
					return success(id, "browser_close", { text });
				} catch (err) {
					return error(id, "browser_close", err instanceof Error ? err.message : String(err));
				}
			}

			case "browser_snapshot": {
				try {
					const name = command.name?.trim() || "main";
					const result = await executeBrowserRpc(session, {
						action: "run",
						name,
						code: "const observation = await tab.observe(); return observation;",
					});
					return success(id, "browser_snapshot", {
						name,
						url: result.details?.url ?? "",
						snapshot: browserResultText(result),
					});
				} catch (err) {
					return error(id, "browser_snapshot", err instanceof Error ? err.message : String(err));
				}
			}

			case "browser_navigate": {
				try {
					const url = validateBrowserUrl(command.url);
					const name = command.name?.trim() || "main";
					const result = await executeBrowserRpc(session, {
						action: "run",
						name,
						code: desktopBrowserNavigationCode(url),
					});
					return success(id, "browser_navigate", {
						name,
						url: result.details?.url ?? url,
						text: browserResultText(result),
					});
				} catch (err) {
					return error(id, "browser_navigate", err instanceof Error ? err.message : String(err));
				}
			}

			case "browser_history": {
				try {
					const name = command.name?.trim() || "main";
					const code = desktopBrowserHistoryCode(command.direction);
					const result = await executeBrowserRpc(session, { action: "run", name, code });
					return success(id, "browser_history", {
						name,
						url: result.details?.url ?? "",
						text: browserResultText(result),
					});
				} catch (err) {
					return error(id, "browser_history", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_git_status": {
				try {
					const cwd = session.sessionManager.getCwd();
					const [summary, head, branches, localBranches, defaultBranchName] = await Promise.all([
						git.status.summary(cwd),
						git.head.resolve(cwd),
						git.branch.list(cwd, { all: true }).catch((): string[] => []),
						git.branch.list(cwd).catch((): string[] => []),
						git.branch.default(cwd).catch(() => null),
					]);
					const branchName = head?.kind === "ref" ? head.branchName : null;
					const [remoteName, mergeRef] = branchName
						? await Promise.all([
								git.config.getBranch(cwd, branchName, "remote"),
								git.config.getBranch(cwd, branchName, "merge"),
							])
						: [undefined, undefined];
					const upstream =
						remoteName && mergeRef ? `${remoteName}/${mergeRef.replace(/^refs\/heads\//, "")}` : null;
					const baseCandidates = defaultBranchName
						? [`origin/${defaultBranchName}`, `upstream/${defaultBranchName}`, defaultBranchName]
						: ["origin/main", "upstream/main", "main", "origin/master", "master"];
					const baseBranch =
						baseCandidates.find(candidate => branches.includes(candidate) && candidate !== branchName) ??
						(upstream?.split("/").at(-1) !== branchName ? upstream : null);
					return success(id, "get_git_status", {
						branch: branchName,
						upstream,
						baseBranch,
						branches,
						localBranches,
						staged: summary?.staged ?? 0,
						unstaged: summary?.unstaged ?? 0,
						untracked: summary?.untracked ?? 0,
					});
				} catch (err) {
					return error(id, "get_git_status", err instanceof Error ? err.message : String(err));
				}
			}

			case "revert_files": {
				if (session.isStreaming)
					return error(id, "revert_files", "Cannot revert files while a response is in progress");
				const files = [...new Set(command.files.map(file => file.trim()).filter(Boolean))];
				if (files.length === 0) return error(id, "revert_files", "No files provided");
				try {
					const cwd = session.sessionManager.getCwd();
					const tracked = new Set(await git.ls.files(cwd));
					const untracked = files.filter(file => !tracked.has(file));
					if (untracked.length > 0)
						return error(id, "revert_files", `Cannot revert untracked files: ${untracked.join(", ")}`);
					await git.restore(cwd, { source: "HEAD", staged: true, worktree: true, files });
					return success(id, "revert_files", { files });
				} catch (err) {
					return error(id, "revert_files", err instanceof Error ? err.message : String(err));
				}
			}

			case "commit": {
				if (session.isStreaming) return error(id, "commit", "Cannot commit while a response is in progress");
				const message = command.message.trim();
				if (!message) return error(id, "commit", "Commit message cannot be empty");
				try {
					const cwd = session.sessionManager.getCwd();
					if (!(await git.diff.has(cwd, { cached: true })))
						return error(id, "commit", "No staged changes to commit");
					const result = await git.commit(cwd, message);
					return success(id, "commit", { stdout: result.stdout, stderr: result.stderr });
				} catch (err) {
					return error(id, "commit", err instanceof Error ? err.message : String(err));
				}
			}

			case "push": {
				if (session.isStreaming) return error(id, "push", "Cannot push while a response is in progress");
				try {
					const cwd = session.sessionManager.getCwd();
					const head = await git.head.resolve(cwd);
					if (head?.kind !== "ref" || !head.branchName) return error(id, "push", "Cannot push a detached HEAD");
					const remote = command.remote?.trim() || undefined;
					const refspec = command.refspec?.trim() || undefined;
					await git.push(cwd, { remote, refspec });
					return success(id, "push", { remote: remote ?? null, refspec: refspec ?? null });
				} catch (err) {
					return error(id, "push", err instanceof Error ? err.message : String(err));
				}
			}

			case "create_pull_request": {
				if (session.isStreaming)
					return error(id, "create_pull_request", "Cannot create a pull request while a response is in progress");
				const title = command.title.trim();
				if (!title) return error(id, "create_pull_request", "Pull request title cannot be empty");
				try {
					const args = ["pr", "create", "--title", title, "--body", command.body.trim()];
					const base = command.base?.trim();
					if (base) args.push("--base", base);
					if (command.draft) args.push("--draft");
					return success(id, "create_pull_request", {
						url: (await git.github.text(session.sessionManager.getCwd(), args)).trim(),
					});
				} catch (err) {
					return error(id, "create_pull_request", err instanceof Error ? err.message : String(err));
				}
			}

			case "list_worktrees": {
				try {
					const entries = await git.worktree.list(session.sessionManager.getCwd());
					return success(id, "list_worktrees", {
						worktrees: entries.map(entry => ({
							path: entry.path,
							branch: entry.branch ?? null,
							detached: entry.detached,
							head: entry.head ?? null,
						})),
					});
				} catch (err) {
					return error(id, "list_worktrees", err instanceof Error ? err.message : String(err));
				}
			}

			case "create_worktree": {
				if (session.isStreaming)
					return error(id, "create_worktree", "Cannot create a worktree while a response is in progress");
				const rawPath = command.path.trim();
				const worktreePath = path.resolve(rawPath);
				if (!rawPath || !path.isAbsolute(rawPath))
					return error(id, "create_worktree", "Worktree path must be absolute");
				if (!command.ref.trim()) return error(id, "create_worktree", "Worktree ref cannot be empty");
				try {
					const cwd = session.sessionManager.getCwd();
					await git.worktree.add(cwd, worktreePath, command.ref.trim(), { detach: command.detach });
					const created = (await git.worktree.list(cwd)).find(entry => path.resolve(entry.path) === worktreePath);
					return success(id, "create_worktree", {
						path: worktreePath,
						branch: created?.branch ?? null,
						detached: created?.detached ?? Boolean(command.detach),
						head: created?.head ?? null,
					});
				} catch (err) {
					return error(id, "create_worktree", err instanceof Error ? err.message : String(err));
				}
			}

			case "remove_worktree": {
				if (session.isStreaming)
					return error(id, "remove_worktree", "Cannot remove a worktree while a response is in progress");
				const rawPath = command.path.trim();
				const worktreePath = path.resolve(rawPath);
				if (!rawPath || !path.isAbsolute(rawPath))
					return error(id, "remove_worktree", "Worktree path must be absolute");
				try {
					const cwd = session.sessionManager.getCwd();
					if (path.resolve(cwd) === worktreePath)
						return error(id, "remove_worktree", "Cannot remove the active workspace");
					const known = (await git.worktree.list(cwd)).some(entry => path.resolve(entry.path) === worktreePath);
					if (!known) return error(id, "remove_worktree", "Path is not a registered worktree");
					await git.worktree.remove(cwd, worktreePath, { force: command.force === true });
					return success(id, "remove_worktree", { path: worktreePath });
				} catch (err) {
					return error(id, "remove_worktree", err instanceof Error ? err.message : String(err));
				}
			}

			// Non-destructive: stage/unstage only mutate the git index, never the
			// working tree. `git.stage.hunks` builds a patch from the current diff
			// and applies it with --cached. Desktop-added; see core-touchpoints.md.
			case "stage_hunks": {
				if (command.selections.length === 0) return error(id, "stage_hunks", "No selections provided");
				const cwd = session.sessionManager.getCwd();
				try {
					await git.stage.hunks(cwd, command.selections);
					return success(id, "stage_hunks", { staged: command.selections.length });
				} catch (err) {
					return error(id, "stage_hunks", err instanceof Error ? err.message : String(err));
				}
			}

			case "unstage": {
				const cwd = session.sessionManager.getCwd();
				try {
					await git.stage.reset(cwd, command.files ?? []);
					return success(id, "unstage");
				} catch (err) {
					return error(id, "unstage", err instanceof Error ? err.message : String(err));
				}
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "get_branch_messages": {
				const messages = session.getUserMessagesForBranching();
				return success(id, "get_branch_messages", { messages });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				const applied = await session.setSessionName(name, "user");
				if (!applied) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				return success(id, "set_session_name");
			}

			case "handoff": {
				// Resetting the agent mid-stream lets the live turn keep emitting into a
				// session that handoff has already torn down. Refuse while a prompt is in
				// flight (mirrors the TUI /handoff guard).
				if (session.isStreaming) {
					return error(id, "handoff", "Cannot hand off while a response is in progress");
				}
				const result = await session.handoff(command.customInstructions);
				return success(id, "handoff", result ? { savedPath: result.savedPath } : null);
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			// =================================================================
			// Login
			// =================================================================

			case "get_login_providers": {
				const oauthProviders = new Map(getOAuthProviders().map(provider => [provider.id, provider]));
				// Mirror the TUI oauth-selector: hide a login entry when either its
				// own id or the provider id it stores credentials under is disabled,
				// so alias logins (e.g. `openai-codex-device` ⇒ `openai-codex`)
				// disappear alongside the model provider they authenticate.
				const disabled = new Set(session.settings.get("disabledProviders"));
				const providers = PROVIDER_REGISTRY.filter(
					provider =>
						!disabled.has(provider.id) &&
						!(provider.storeCredentialsAs && disabled.has(provider.storeCredentialsAs)),
				).map(provider => {
					const oauthProvider = oauthProviders.get(provider.id);
					const origin = session.modelRegistry.authStorage.getCredentialOrigin(provider.id);
					return {
						id: provider.id,
						name: provider.name,
						available: oauthProvider?.available ?? provider.available ?? true,
						authenticated: session.modelRegistry.authStorage.hasAuth(provider.id),
						authKind: origin?.kind,
						envVar: origin?.envVar,
						supportsOAuth: oauthProvider !== undefined,
						supportsApiKey: true,
					};
				});
				return success(id, "get_login_providers", { providers });
			}

			case "login": {
				const knownProvider = getOAuthProviders().find(p => p.id === command.providerId);
				if (!knownProvider) {
					return error(id, "login", `Unknown OAuth provider: ${command.providerId}`);
				}
				const uiCtx = new RpcExtensionUIContext(pendingExtensionRequests, output);
				// Track whether onAuth has fired. Providers that require interactive
				// input before a browser URL cannot be satisfied headlessly; after
				// onAuth, prompt input is the pasted OAuth code/redirect URL path.
				let authEmitted = false;
				try {
					await session.modelRegistry.authStorage.login(command.providerId, {
						onAuth: info => {
							authEmitted = true;
							output({
								type: "extension_ui_request",
								id: Snowflake.next() as string,
								method: "open_url",
								url: info.url,
								launchUrl: info.launchUrl,
								instructions: info.instructions,
							} as RpcExtensionUIRequest);
						},
						onProgress: message => {
							uiCtx.notify(message, "info");
						},
						onPrompt: async prompt => {
							if (!authEmitted) {
								// onPrompt called before any auth URL — provider requires
								// interactive input that cannot be satisfied headlessly.
								return Promise.reject(
									new Error(
										`Provider '${command.providerId}' requires interactive prompts ` +
											"which are not supported in RPC mode. Use the terminal UI to log in.",
									),
								);
							}
							return (await uiCtx.input(prompt.message, prompt.placeholder, { timeout: 600_000 })) ?? "";
						},
					});
					await session.modelRegistry.refresh();
					return success(id, "login", { providerId: command.providerId });
				} catch (err: unknown) {
					return error(id, "login", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_api_key": {
				const knownProvider = PROVIDER_REGISTRY.find(provider => provider.id === command.providerId);
				if (!knownProvider) {
					return error(id, "set_api_key", `Unknown provider: ${command.providerId}`);
				}
				const apiKey = command.apiKey.trim();
				if (!apiKey) {
					return error(id, "set_api_key", "API key cannot be empty");
				}
				try {
					await session.modelRegistry.authStorage.set(command.providerId, { type: "api_key", key: apiKey });
					await session.modelRegistry.refresh();
					return success(id, "set_api_key", { providerId: command.providerId });
				} catch (err: unknown) {
					return error(id, "set_api_key", err instanceof Error ? err.message : String(err));
				}
			}

			case "logout": {
				try {
					await session.modelRegistry.authStorage.logout(command.providerId);
					await session.modelRegistry.refresh();
					return success(id, "logout", { providerId: command.providerId });
				} catch (err: unknown) {
					return error(id, "logout", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_plan_mode": {
				if (!session.settings.get("plan.enabled")) {
					return error(id, "set_plan_mode", "Plan mode is disabled (plan.enabled = false).");
				}
				if (command.enabled && session.getGoalModeState()?.enabled) {
					return error(id, "set_plan_mode", "Pause or drop the active goal before entering plan mode");
				}
				try {
					if (command.enabled) {
						const previous = session.getPlanModeState();
						session.setPlanModeState({
							enabled: true,
							planFilePath: previous?.planFilePath ?? DEFAULT_PLAN_FILE_URL,
							workflow: command.workflow ?? previous?.workflow ?? "parallel",
							reentry: previous !== undefined,
						});
						session.setPlanProposalHandler(title => handlePlanProposal(title));
					} else {
						session.setPlanProposalHandler(null);
						session.setPlanModeState(undefined);
					}
					emitPlanModeChanged();
					return success(id, "set_plan_mode", { planMode: toRpcPlanMode() });
				} catch (err: unknown) {
					return error(id, "set_plan_mode", err instanceof Error ? err.message : String(err));
				}
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(undefined, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	// Deferred shutdown (pi.shutdown() from an extension) must not kill the
	// process while a background-dispatched bash still owes the client its
	// response frame. The coordinator drains tracked tasks before exiting and
	// re-checks the request as each task settles.
	const shutdownCoordinator = new RpcShutdownCoordinator({
		isShutdownRequested: () => shutdownState.requested,
		performShutdown: async () => {
			// Route through the idempotent session.dispose() so the browser
			// reaper (releaseTabsForOwner) and other bounded teardown run before
			// the process exits. dispose() also emits `session_shutdown`, so we
			// must NOT emit it separately here or the event fires twice. Skipping
			// dispose left OMP-owned Chromium alive after RPC shutdown (#5643).
			await session.dispose();
			process.exit(0);
		},
	});

	const dispatchFrameDeps: RpcInputFrameDeps = {
		handleCommand,
		output,
		errorResponse: error,
		trackBackgroundTask: task => shutdownCoordinator.track(task),
		pendingExtensionRequests,
		onHostToolResult: frame => hostToolBridge.handleResult(frame),
		onHostToolUpdate: frame => hostToolBridge.handleUpdate(frame),
		onHostUriResult: frame => hostUriBridge.handleResult(frame),
	};

	const inputDispatcher = new RpcInputDispatcher({
		deps: dispatchFrameDeps,
		afterSerialCommand: () => shutdownCoordinator.checkShutdownRequested(),
	});

	// Keep the stdin reader moving: side-channel frames dispatch immediately,
	// ordinary commands serialize through inputDispatcher, and bash remains
	// background-dispatched so abort_bash can overtake it.
	for await (const parsed of readJsonl(Bun.stdin.stream())) {
		inputDispatcher.dispatch(parsed);
	}

	// stdin closed — RPC client is gone. Fail pending side-channel requests
	// first so active/queued commands can settle, then drain accepted work.
	pendingExtensionRequests.rejectAll("RPC client disconnected before extension UI response completed");
	hostToolBridge.close("RPC client disconnected before host tool execution completed");
	hostUriBridge.clear("RPC client disconnected before host URI request completed");
	await inputDispatcher.drain();
	await shutdownCoordinator.drain();
	subagentRegistry?.dispose();
	// Dispose the main session before exiting so the browser reaper and other
	// bounded teardown run on the stdin-EOF path too (#5643). Idempotent: a
	// prior pi.shutdown() through the coordinator makes this await settle
	// immediately.
	await session.dispose();
	process.exit(0);
}
