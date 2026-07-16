/**
 * Browser-side RPC client. Mirrors the classification logic of the canonical
 * `packages/coding-agent/src/modes/rpc/rpc-client.ts`, but instead of spawning
 * the engine itself; it drives the Electron preload bridge:
 *   - sends commands via `send_rpc`
 *   - receives NDJSON frames via the `rpc://frame` event
 */

import { onEngineExit, onRpcFrame, onRpcStderr, sendRpcLine, startEngine, stopEngine } from "./desktop-bridge";
import {
	type ApprovalMode,
	type AvailableCommand,
	type AvailableCommandsUpdateFrame,
	type BashResult,
	type BranchMessage,
	type BranchResult,
	type BrowserTabInfo,
	type CommandOutputFrame,
	type CompactionResult,
	type ConfigUpdateFrame,
	type EngineEvent,
	type ExtensionErrorFrame,
	type ExtensionUIRequest,
	type ExtensionUIResponse,
	type GitStatus,
	type HandoffResult,
	type HostToolCallRequest,
	type HostToolCancelRequest,
	type HostToolDefinition,
	type HostToolUpdateFrame,
	type HostUriCancelRequest,
	type HostUriRequest,
	type HostUriResultFrame,
	type HostUriSchemeDefinition,
	type HunkSelection,
	type ImageContent,
	type LoginProvider,
	type McpServerStatus,
	type MemorySearchResult,
	type MemoryStatus,
	type ModelInfo,
	type PluginDescriptor,
	type PromptResultFrame,
	type RpcCommand,
	type RpcErrorPayload,
	type RpcResponse,
	SESSION_EVENT_TYPES,
	type SessionInfoUpdateFrame,
	type SessionMessage,
	type SessionState,
	type SessionStats,
	type SessionSummary,
	type SettingDescriptor,
	type SettingsSnapshot,
	SUBAGENT_FRAME_TYPES,
	type SubagentMessagesResult,
	type SubagentSnapshot,
	type ThinkingLevel,
	type TodoPhase,
	type WorkspaceEntry,
	type WorkspaceFileChange,
	type WorkspaceFileContent,
	type WorktreeInfo,
} from "./rpc-protocol";

const sessionEventTypes = new Set<string>(SESSION_EVENT_TYPES);
const subagentFrameTypes = new Set<string>(SUBAGENT_FRAME_TYPES);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

const READY_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;

export type EngineStatus = "idle" | "starting" | "ready" | "error" | "stopped";

export interface EngineReadyInfo {
	protocolVersion: number;
	capabilities: readonly string[];
}

export function supportsCapability(capabilities: readonly string[], capability: string): boolean {
	return capabilities.includes(capability);
}

export interface DesktopRpcClientHandlers {
	onEvent?: (event: EngineEvent) => void;
	onStatus?: (status: EngineStatus, detail?: string) => void;
	onStderr?: (line: string) => void;
	/** Fired when a subagent frame arrives; the app should refresh via getSubagents(). */
	onSubagentUpdate?: () => void;
	/** Fired for every extension UI request (dialogs, notify, open_url, …). */
	onExtensionUI?: (request: ExtensionUIRequest) => void;
	onReady?: (info: EngineReadyInfo) => void;
	onHostToolCall?: (request: HostToolCallRequest) => void;
	onHostToolCancel?: (request: HostToolCancelRequest) => void;
	onHostToolUpdate?: (frame: HostToolUpdateFrame) => void;
	onPromptResult?: (frame: PromptResultFrame) => void;
	onHostUriRequest?: (request: HostUriRequest) => void;
	onHostUriCancel?: (request: HostUriCancelRequest) => void;
	onEventGap?: (expected: number, received: number) => void;
	onCommandOutput?: (frame: CommandOutputFrame) => void;
	onAvailableCommandsUpdate?: (frame: AvailableCommandsUpdateFrame) => void;
	onSessionInfoUpdate?: (frame: SessionInfoUpdateFrame) => void;
	onConfigUpdate?: (frame: ConfigUpdateFrame) => void;
	onExtensionError?: (frame: ExtensionErrorFrame) => void;
}

export interface DesktopRpcTransport {
	startEngine(cwd?: string): Promise<void>;
	stopEngine(): Promise<void>;
	sendRpcLine(line: string): Promise<void>;
	onRpcFrame(cb: (line: string) => void): () => void;
	onRpcStderr(cb: (line: string) => void): () => void;
	onEngineExit(cb: () => void): () => void;
}

const MAIN_TRANSPORT: DesktopRpcTransport = {
	startEngine,
	stopEngine,
	sendRpcLine,
	onRpcFrame,
	onRpcStderr,
	onEngineExit,
};

interface PendingRequest {
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	command: string;
	requestId: string;
}

export class DesktopRpcClient {
	#handlers: DesktopRpcClientHandlers;
	#pending = new Map<string, PendingRequest>();
	#reqId = 0;
	#unlisten: Array<(() => void) | Promise<() => void>> = [];
	#readyResolve: (() => void) | undefined;
	#started = false;
	#ready = false;
	#readyInfo: EngineReadyInfo = { protocolVersion: 1, capabilities: [] };
	#lastEventSequence = 0;
	#transport: DesktopRpcTransport;

	get readyInfo(): EngineReadyInfo {
		return this.#readyInfo;
	}

	constructor(handlers: DesktopRpcClientHandlers = {}, transport: DesktopRpcTransport = MAIN_TRANSPORT) {
		this.#handlers = handlers;
		this.#transport = transport;
	}

	async start(cwd?: string): Promise<void> {
		if (this.#started) throw new Error("client already started");
		this.#started = true;
		this.#ready = false;
		this.#readyInfo = { protocolVersion: 1, capabilities: [] };

		// Attach listeners before spawning so the `ready` frame can't be missed.
		this.#unlisten.push(this.#transport.onRpcFrame(line => this.#handleLine(line)));
		this.#unlisten.push(this.#transport.onRpcStderr(line => this.#handlers.onStderr?.(line)));
		this.#unlisten.push(
			this.#transport.onEngineExit(() => {
				this.#started = false;
				this.#ready = false;
				this.#rejectPending("engine exited");
				this.#handlers.onStatus?.("stopped");
			}),
		);

		const ready = new Promise<void>(resolve => {
			this.#readyResolve = resolve;
		});

		this.#handlers.onStatus?.("starting");
		try {
			await this.#transport.startEngine(cwd);
		} catch (err) {
			this.#started = false;
			this.#ready = false;
			this.#rejectPending("engine failed to become ready");
			this.#handlers.onStatus?.("error", errorMessage(err));
			throw err;
		}

		let readyTimer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			readyTimer = setTimeout(() => reject(new Error("timeout waiting for engine ready")), READY_TIMEOUT_MS);
		});
		try {
			await Promise.race([ready, timeout]);
			this.#handlers.onStatus?.("ready");
		} catch (err) {
			this.#started = false;
			this.#ready = false;
			this.#rejectPending("engine failed to become ready");
			this.#handlers.onStatus?.("error", errorMessage(err));
			throw err;
		} finally {
			if (readyTimer) clearTimeout(readyTimer);
		}
	}

	async stop(): Promise<void> {
		const unlisteners = this.#unlisten.splice(0);
		for (const unlisten of unlisteners) {
			try {
				(await unlisten)();
			} catch {
				// A transport may already have torn down its event surface.
			}
		}
		this.#rejectPending("client stopped");
		await this.#transport.stopEngine().catch(() => {});
		this.#started = false;
		this.#ready = false;
	}

	async restart(cwd?: string): Promise<void> {
		await this.stop();
		await this.start(cwd);
	}

	/** Reject and clear every in-flight request with a transport error. */
	#rejectPending(reason: string): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new RpcTransportError(reason, pending.command, pending.requestId));
		}
		this.#pending.clear();
	}

	// ── Commands ────────────────────────────────────────────────────────────

	async prompt(
		message: string,
		images?: ImageContent[],
		streamingBehavior?: "steer" | "followUp",
	): Promise<{ agentInvoked: boolean }> {
		const command =
			images && images.length > 0
				? { type: "prompt" as const, message, images, ...(streamingBehavior ? { streamingBehavior } : {}) }
				: { type: "prompt" as const, message, ...(streamingBehavior ? { streamingBehavior } : {}) };
		const response = await this.#send(command);
		// The engine returns `{ agentInvoked: false }` only for local-only commands
		// (slash commands that never start a turn); a real prompt returns no data.
		const data = this.#data<{ agentInvoked?: boolean }>(response);
		return { agentInvoked: data.agentInvoked !== false };
	}

	async abortAndPrompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send(
			images && images.length > 0
				? { type: "abort_and_prompt", message, images }
				: { type: "abort_and_prompt", message },
			120_000,
		);
	}

	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send(images?.length ? { type: "steer", message, images } : { type: "steer", message });
	}

	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send(images?.length ? { type: "follow_up", message, images } : { type: "follow_up", message });
	}

	async getAvailableCommands(): Promise<AvailableCommand[]> {
		return (
			this.#data<{ commands?: AvailableCommand[] }>(await this.#send({ type: "get_available_commands" })).commands ??
			[]
		);
	}

	async setHostTools(tools: HostToolDefinition[]): Promise<string[]> {
		return this.#data<{ toolNames: string[] }>(await this.#send({ type: "set_host_tools", tools })).toolNames;
	}

	async setHostUriSchemes(schemes: HostUriSchemeDefinition[]): Promise<string[]> {
		return this.#data<{ schemes: string[] }>(await this.#send({ type: "set_host_uri_schemes", schemes })).schemes;
	}

	async respondHostTool(request: HostToolCallRequest, result: unknown, isError = false): Promise<void> {
		await this.respondHostToolById(request.id, result, isError);
	}

	async respondHostToolById(id: string, result: unknown, isError = false): Promise<void> {
		await this.#transport.sendRpcLine(JSON.stringify({ type: "host_tool_result", id, result, isError }));
	}

	async updateHostTool(id: string, partialResult: unknown): Promise<void> {
		await this.#transport.sendRpcLine(JSON.stringify({ type: "host_tool_update", id, partialResult }));
	}

	async respondHostUri(request: HostUriRequest, response: Omit<HostUriResultFrame, "type" | "id">): Promise<void> {
		await this.respondHostUriById(request.id, response);
	}

	async respondHostUriById(id: string, response: Omit<HostUriResultFrame, "type" | "id">): Promise<void> {
		await this.#transport.sendRpcLine(JSON.stringify({ type: "host_uri_result", id, ...response }));
	}

	async abort(): Promise<void> {
		await this.#send({ type: "abort" });
	}

	async newSession(): Promise<void> {
		await this.#send({ type: "new_session" });
	}

	/**
	 * Re-root the live engine at a new project directory and open a fresh task,
	 * WITHOUT respawning the engine. Used when the user switches projects so the
	 * process, credentials, and RPC stream stay alive (Codex/Claude-style).
	 */
	async setWorkspace(cwd: string): Promise<{ cwd: string }> {
		const response = await this.#send({ type: "set_workspace", cwd });
		return this.#data<{ cwd: string }>(response);
	}

	async getState(): Promise<SessionState> {
		const response = await this.#send({ type: "get_state" });
		return this.#data<SessionState>(response);
	}

	async getSettings(): Promise<SettingsSnapshot> {
		return this.#data<SettingsSnapshot>(await this.#send({ type: "get_settings" }));
	}

	async setSetting(path: string, value: unknown): Promise<SettingDescriptor> {
		return this.#data<SettingDescriptor>(await this.#send({ type: "set_setting", path, value }));
	}

	async setPluginEnabled(name: string, enabled: boolean): Promise<PluginDescriptor> {
		return this.#data<PluginDescriptor>(await this.#send({ type: "set_plugin_enabled", name, enabled }));
	}

	async installPlugin(spec: string): Promise<PluginDescriptor> {
		return this.#data(await this.#send({ type: "install_plugin", spec }, 600_000));
	}

	async updatePlugin(name: string): Promise<PluginDescriptor> {
		return this.#data(await this.#send({ type: "update_plugin", name }, 600_000));
	}

	async uninstallPlugin(name: string): Promise<void> {
		await this.#send({ type: "uninstall_plugin", name }, 600_000);
	}

	async setSubagentSubscription(level: "off" | "progress" | "events"): Promise<void> {
		await this.#send({ type: "set_subagent_subscription", level });
	}

	async getSubagents(): Promise<SubagentSnapshot[]> {
		const response = await this.#send({ type: "get_subagents" });
		return this.#data<{ subagents?: SubagentSnapshot[] }>(response).subagents ?? [];
	}

	async getLoginProviders(): Promise<LoginProvider[]> {
		const response = await this.#send({ type: "get_login_providers" });
		return this.#data<{ providers?: LoginProvider[] }>(response).providers ?? [];
	}

	/** Start OAuth login. The engine emits `open_url` (handled via onExtensionUI) and resolves when auth completes. */
	async login(providerId: string): Promise<void> {
		await this.#send({ type: "login", providerId }, 600_000);
	}

	/** Store a provider API key in the engine credential store. */
	async setApiKey(providerId: string, apiKey: string): Promise<void> {
		await this.#send({ type: "set_api_key", providerId, apiKey });
	}

	/** Sign out of a provider (clears stored credentials). */
	async logout(providerId: string): Promise<void> {
		await this.#send({ type: "logout", providerId });
	}

	/** Toggle plan mode. When enabling, the engine makes the working tree read-only
	 *  until the agent submits a plan for approval (surfaced via a confirm dialog). */
	async setPlanMode(enabled: boolean, workflow?: "parallel" | "iterative"): Promise<void> {
		await this.#send(workflow ? { type: "set_plan_mode", enabled, workflow } : { type: "set_plan_mode", enabled });
	}

	/** Reply to an extension UI dialog request (select/confirm/input/editor). Side-channel frame, not a command. */
	async respondExtensionUI(response: ExtensionUIResponse): Promise<void> {
		await this.#transport.sendRpcLine(JSON.stringify(response));
	}

	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.#send({ type: "get_available_models" });
		const data = this.#data<{ models?: ModelInfo[] }>(response);
		return data.models ?? [];
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		await this.#send({ type: "set_model", provider, modelId });
	}

	async cycleModel(): Promise<ModelInfo | null> {
		return this.#data<ModelInfo | null>(await this.#send({ type: "cycle_model" }));
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.#send({ type: "set_thinking_level", level });
	}

	async setApprovalMode(mode: ApprovalMode): Promise<void> {
		await this.#send({ type: "set_approval_mode", mode });
	}

	async setSessionName(name: string): Promise<void> {
		await this.#send({ type: "set_session_name", name });
	}

	/** List sessions for the current workspace (newest first, `active` flags the loaded one). */
	async listSessions(): Promise<SessionSummary[]> {
		const response = await this.#send({ type: "list_sessions" });
		return this.#data<{ sessions?: SessionSummary[] }>(response).sessions ?? [];
	}

	/** Switch to a different session file. Returns `cancelled: true` if an extension blocked it. */
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const response = await this.#send({ type: "switch_session", sessionPath });
		return this.#data<{ cancelled: boolean }>(response);
	}

	/** Fetch the full persisted message history of the loaded session (for transcript re-seed). */
	async getMessages(): Promise<SessionMessage[]> {
		const response = await this.#send({ type: "get_messages" });
		return this.#data<{ messages?: SessionMessage[] }>(response).messages ?? [];
	}

	/** Fetch the workspace git diff (changed/untracked files vs HEAD) for the Changes panel. */
	async getWorkspaceDiff(): Promise<WorkspaceFileChange[]> {
		const response = await this.#send({ type: "get_workspace_diff" });
		return this.#data<{ files?: WorkspaceFileChange[] }>(response).files ?? [];
	}

	async listWorkspaceFiles(
		query?: string,
		limit?: number,
	): Promise<{ entries: WorkspaceEntry[]; truncated: boolean }> {
		return this.#data<{ entries: WorkspaceEntry[]; truncated: boolean }>(
			await this.#send({ type: "list_workspace_files", query, limit }),
		);
	}

	async readWorkspaceFile(path: string, maxBytes?: number): Promise<WorkspaceFileContent> {
		return this.#data<WorkspaceFileContent>(await this.#send({ type: "read_workspace_file", path, maxBytes }));
	}

	async getContextSnapshot(): Promise<{
		skills: string[];
		memoryBackend: string | null;
		skillDetails?: Array<{ name: string; description: string; filePath: string; source: string; hidden?: boolean }>;
		skillWarnings?: Array<{ skillPath: string; message: string }>;
	}> {
		return this.#data(await this.#send({ type: "get_context_snapshot" }));
	}

	async getMcpStatus(): Promise<McpServerStatus[]> {
		return this.#data<{ servers?: McpServerStatus[] }>(await this.#send({ type: "get_mcp_status" })).servers ?? [];
	}

	async reconnectMcp(serverName: string): Promise<{ serverName: string; status: string; toolCount: number }> {
		return this.#data(await this.#send({ type: "reconnect_mcp", serverName }));
	}

	async setMcpEnabled(serverName: string, enabled: boolean): Promise<{ serverName: string; enabled: boolean }> {
		return this.#data(await this.#send({ type: "set_mcp_enabled", serverName, enabled }));
	}

	async getMemoryStatus(): Promise<MemoryStatus> {
		return this.#data(await this.#send({ type: "get_memory_status" }));
	}

	async searchMemory(query: string, limit?: number): Promise<MemorySearchResult> {
		return this.#data(await this.#send({ type: "search_memory", query, limit }));
	}

	async browserOpen(url: string, name?: string): Promise<{ name: string; url: string; text: string }> {
		return this.#data<{ name: string; url: string; text: string }>(
			await this.#send({ type: "browser_open", url, name }),
		);
	}

	async browserListTabs(): Promise<BrowserTabInfo[]> {
		return this.#data<{ tabs?: BrowserTabInfo[] }>(await this.#send({ type: "browser_list_tabs" })).tabs ?? [];
	}

	async browserClose(name?: string, all = false): Promise<string> {
		return this.#data<{ text: string }>(await this.#send({ type: "browser_close", name, all })).text;
	}

	async browserSnapshot(name?: string): Promise<{ name: string; url: string; snapshot: string }> {
		return this.#data<{ name: string; url: string; snapshot: string }>(
			await this.#send({ type: "browser_snapshot", name }),
		);
	}

	async browserNavigate(url: string, name?: string): Promise<{ name: string; url: string; text: string }> {
		return this.#data<{ name: string; url: string; text: string }>(
			await this.#send({ type: "browser_navigate", url, name }),
		);
	}

	async browserHistory(
		direction: "back" | "forward" | "reload",
		name?: string,
	): Promise<{ name: string; url: string; text: string }> {
		return this.#data<{ name: string; url: string; text: string }>(
			await this.#send({ type: "browser_history", direction, name }),
		);
	}

	async getGitStatus(): Promise<GitStatus> {
		return this.#data<GitStatus>(await this.#send({ type: "get_git_status" }));
	}

	async revertFiles(files: string[]): Promise<string[]> {
		return this.#data<{ files: string[] }>(await this.#send({ type: "revert_files", files })).files;
	}

	async commit(message: string): Promise<{ stdout: string; stderr: string }> {
		return this.#data<{ stdout: string; stderr: string }>(await this.#send({ type: "commit", message }));
	}

	async push(remote?: string, refspec?: string): Promise<{ remote: string | null; refspec: string | null }> {
		return this.#data<{ remote: string | null; refspec: string | null }>(
			await this.#send({ type: "push", remote, refspec }),
		);
	}

	async createPullRequest(title: string, body: string, base?: string, draft = false): Promise<string> {
		return this.#data<{ url: string }>(await this.#send({ type: "create_pull_request", title, body, base, draft }))
			.url;
	}

	async listWorktrees(): Promise<WorktreeInfo[]> {
		return this.#data<{ worktrees: WorktreeInfo[] }>(await this.#send({ type: "list_worktrees" })).worktrees;
	}

	async createWorktree(path: string, ref: string, detach = false): Promise<WorktreeInfo> {
		return this.#data<WorktreeInfo>(await this.#send({ type: "create_worktree", path, ref, detach }));
	}

	async removeWorktree(path: string, force = false): Promise<string> {
		return this.#data<{ path: string }>(await this.#send({ type: "remove_worktree", path, force })).path;
	}

	async bash(command: string): Promise<BashResult> {
		const response = await this.#send({ type: "bash", command });
		return this.#data<BashResult>(response);
	}

	async abortBash(): Promise<void> {
		await this.#send({ type: "abort_bash" });
	}

	async getSessionStats(): Promise<SessionStats> {
		return this.#data<SessionStats>(await this.#send({ type: "get_session_stats" }));
	}

	async getSubagentMessages(
		options: { subagentId?: string; sessionFile?: string; fromByte?: number } = {},
	): Promise<SubagentMessagesResult> {
		const response = await this.#send({ type: "get_subagent_messages", ...options });
		return this.#data<SubagentMessagesResult>(response);
	}

	async compact(customInstructions?: string): Promise<CompactionResult> {
		const command: RpcCommand = customInstructions ? { type: "compact", customInstructions } : { type: "compact" };
		return this.#data<CompactionResult>(await this.#send(command, 120_000));
	}

	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.#send({ type: "set_auto_retry", enabled });
	}

	async abortRetry(): Promise<void> {
		await this.#send({ type: "abort_retry" });
	}

	async getBranchMessages(): Promise<BranchMessage[]> {
		return (
			this.#data<{ messages?: BranchMessage[] }>(await this.#send({ type: "get_branch_messages" })).messages ?? []
		);
	}

	async branch(entryId: string): Promise<BranchResult> {
		return this.#data<BranchResult>(await this.#send({ type: "branch", entryId }, 120_000));
	}

	async getLastAssistantText(): Promise<string | null> {
		return this.#data<{ text: string | null }>(await this.#send({ type: "get_last_assistant_text" })).text ?? null;
	}

	async exportHtml(outputPath?: string): Promise<string> {
		const command: RpcCommand = outputPath ? { type: "export_html", outputPath } : { type: "export_html" };
		return this.#data<{ path: string }>(await this.#send(command, 120_000)).path;
	}

	async handoff(customInstructions?: string): Promise<HandoffResult | null> {
		const command: RpcCommand = customInstructions ? { type: "handoff", customInstructions } : { type: "handoff" };
		return this.#data<HandoffResult | null>(await this.#send(command, 120_000));
	}

	async cycleThinkingLevel(): Promise<string | null> {
		return this.#data<{ level?: string } | null>(await this.#send({ type: "cycle_thinking_level" }))?.level ?? null;
	}

	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.#send({ type: "set_steering_mode", mode });
	}

	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.#send({ type: "set_follow_up_mode", mode });
	}

	async setInterruptMode(mode: "immediate" | "wait"): Promise<void> {
		await this.#send({ type: "set_interrupt_mode", mode });
	}

	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.#send({ type: "set_auto_compaction", enabled });
	}

	async setTodos(phases: TodoPhase[]): Promise<TodoPhase[]> {
		return this.#data<{ todoPhases: TodoPhase[] }>(await this.#send({ type: "set_todos", phases })).todoPhases;
	}

	/** Stage whole files or specific hunks (git index only; non-destructive). */
	async stageHunks(selections: HunkSelection[]): Promise<void> {
		await this.#send({ type: "stage_hunks", selections });
	}

	/** Unstage files (empty = unstage all). Reverses {@link stageHunks} on the index. */
	async unstage(files?: string[]): Promise<void> {
		await this.#send(files && files.length > 0 ? { type: "unstage", files } : { type: "unstage" });
	}

	// ── Internal ──────────────────────────────────────────────────────────────

	#handleLine(line: string): void {
		let data: unknown;
		try {
			data = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRecord(data)) return;
		if (data.type === "ready") this.#lastEventSequence = 0;
		if (typeof data.seq === "number" && Number.isInteger(data.seq) && data.seq > 0) {
			if (data.seq !== this.#lastEventSequence + 1) {
				this.#handlers.onEventGap?.(this.#lastEventSequence + 1, data.seq);
				if (data.seq <= this.#lastEventSequence) return;
			}
			this.#lastEventSequence = data.seq;
		}

		if (data.type === "ready") {
			this.#ready = true;
			this.#readyInfo = {
				protocolVersion: typeof data.protocolVersion === "number" ? data.protocolVersion : 1,
				capabilities: Array.isArray(data.capabilities)
					? data.capabilities.filter((capability): capability is string => typeof capability === "string")
					: [],
			};
			this.#handlers.onReady?.(this.#readyInfo);
			this.#readyResolve?.();
			this.#readyResolve = undefined;
			return;
		}

		if (data.type === "response" && typeof data.command === "string") {
			const id = typeof data.id === "string" ? data.id : undefined;
			if (id && this.#pending.has(id)) {
				const pending = this.#pending.get(id)!;
				this.#pending.delete(id);
				clearTimeout(pending.timer);
				pending.resolve(data as unknown as RpcResponse);
			}
			return;
		}
		if (data.type === "prompt_result" && typeof data.agentInvoked === "boolean") {
			this.#handlers.onPromptResult?.(data as unknown as PromptResultFrame);
			return;
		}

		if (data.type === "command_output" && typeof data.text === "string") {
			this.#handlers.onCommandOutput?.(data as unknown as CommandOutputFrame);
			return;
		}
		if (data.type === "available_commands_update" && Array.isArray(data.commands)) {
			const commands = data.commands.filter(
				(command): command is AvailableCommand => isRecord(command) && typeof command.name === "string",
			);
			this.#handlers.onAvailableCommandsUpdate?.({ type: "available_commands_update", commands });
			return;
		}
		if (data.type === "session_info_update" && typeof data.sessionId === "string") {
			this.#handlers.onSessionInfoUpdate?.(data as unknown as SessionInfoUpdateFrame);
			return;
		}
		if (data.type === "config_update") {
			this.#handlers.onConfigUpdate?.(data as unknown as ConfigUpdateFrame);
			return;
		}
		if (data.type === "extension_error" && typeof data.error === "string") {
			this.#handlers.onExtensionError?.(data as unknown as ExtensionErrorFrame);
			return;
		}

		if (typeof data.type === "string" && sessionEventTypes.has(data.type)) {
			this.#handlers.onEvent?.(data as unknown as EngineEvent);
			return;
		}

		if (typeof data.type === "string" && subagentFrameTypes.has(data.type)) {
			this.#handlers.onSubagentUpdate?.();
			return;
		}

		if (data.type === "extension_ui_request" && typeof data.id === "string" && typeof data.method === "string") {
			this.#handlers.onExtensionUI?.(data as unknown as ExtensionUIRequest);
			return;
		}

		if (data.type === "host_tool_call" && typeof data.id === "string" && typeof data.toolName === "string") {
			this.#handlers.onHostToolCall?.(data as unknown as HostToolCallRequest);
			return;
		}
		if (data.type === "host_tool_cancel" && typeof data.id === "string" && typeof data.targetId === "string") {
			this.#handlers.onHostToolCancel?.(data as unknown as HostToolCancelRequest);
			return;
		}
		if (data.type === "host_tool_update" && typeof data.id === "string") {
			this.#handlers.onHostToolUpdate?.(data as unknown as HostToolUpdateFrame);
			return;
		}
		if (data.type === "host_uri_request" && typeof data.id === "string" && typeof data.url === "string") {
			this.#handlers.onHostUriRequest?.(data as unknown as HostUriRequest);
			return;
		}
		if (data.type === "host_uri_cancel" && typeof data.id === "string" && typeof data.targetId === "string") {
			this.#handlers.onHostUriCancel?.(data as unknown as HostUriCancelRequest);
			return;
		}

		// Unknown frame types remain forward-compatible: a newer engine may emit
		// metadata the current desktop does not understand yet.
	}

	#send(command: RpcCommand, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<RpcResponse> {
		if (!this.#started || !this.#ready) {
			return Promise.reject(new RpcTransportError("engine is not ready", command.type, "not-ready"));
		}
		const id = `req_${++this.#reqId}`;
		const promise = new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new RpcTimeoutError(`timeout waiting for response to ${command.type}`, command.type, id));
			}, timeoutMs);
			this.#pending.set(id, { resolve, reject, timer, command: command.type, requestId: id });
		});
		void this.#transport.sendRpcLine(JSON.stringify({ ...command, id })).catch((err: unknown) => {
			const pending = this.#pending.get(id);
			if (!pending) return;
			this.#pending.delete(id);
			clearTimeout(pending.timer);
			pending.reject(new RpcTransportError(errorMessage(err), command.type, id));
		});
		// Surface engine-side failures uniformly, so void commands (prompt, abort,
		// …) that never call #data don't swallow a success:false response.
		return promise.then(response => {
			if (!response.success) {
				const error = normalizeRpcError(response.error);
				throw new RpcEngineError(error.message, response.command, response.id ?? id, error.code);
			}
			return response;
		});
	}

	#data<T>(response: RpcResponse): T {
		// #send already rejected non-success responses, so `data` is present here.
		return (response.success ? (response.data === undefined ? {} : response.data) : {}) as T;
	}
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

/**
 * Base for RPC request failures. Callers branch on the subclass to recover
 * differently: timeout → offer retry, transport → suggest restarting the
 * engine, engine → surface the message and keep the transcript.
 */
export abstract class RpcError extends Error {
	abstract readonly kind: "timeout" | "transport" | "engine";
	constructor(
		message: string,
		readonly command: string,
		readonly requestId: string,
	) {
		super(message);
		this.name = new.target.name;
	}
}

/** No response arrived within the timeout window. */
export class RpcTimeoutError extends RpcError {
	readonly kind = "timeout" as const;
}

/** The command could not be delivered, or the client/engine stopped while awaiting it. */
export class RpcTransportError extends RpcError {
	readonly kind = "transport" as const;
}

/** The engine processed the command and returned `success: false`. */
export class RpcEngineError extends RpcError {
	readonly kind = "engine" as const;
	constructor(
		message: string,
		command: string,
		requestId: string,
		readonly code?: string,
	) {
		super(message, command, requestId);
	}
}

function normalizeRpcError(error: string | RpcErrorPayload): RpcErrorPayload {
	if (typeof error === "string") return { message: error };
	return typeof error.message === "string" ? error : { message: "Unknown engine error" };
}
