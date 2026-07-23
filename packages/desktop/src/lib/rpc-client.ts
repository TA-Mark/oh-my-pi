/**
 * Browser-side RPC client. Mirrors the classification logic of the canonical
 * `packages/coding-agent/src/modes/rpc/rpc-client.ts`, but instead of spawning
 * the engine itself it drives the Electron main-process bridge:
 *   - sends commands over a secure contextBridge IPC channel
 *   - receives NDJSON frames from the Electron child process
 */

import { onEngineExit, onRpcFrame, onRpcStderr, sendRpcLine, startEngine, stopEngine } from "./desktop-bridge";
import {
	type ApprovalMode,
	type ArtifactContent,
	type AvailableCommand,
	type BashResult,
	type BrowserState,
	type BrowserTab,
	type ContextSnapshot,
	type EngineEvent,
	type ExtensionError,
	type ExtensionUIRequest,
	type ExtensionUIResponse,
	type GatewayProviderConfigInput,
	type GitStatus,
	type GoalResult,
	type GuidedGoalMessage,
	type GuidedGoalTurnResult,
	type HostToolCallRequest,
	type HostToolCancelRequest,
	type HostToolDefinition,
	type HostToolResultFrame,
	type HostToolResultPayload,
	type HostToolUpdateFrame,
	type HostUriCancelRequest,
	type HostUriRequest,
	type HostUriResultFrame,
	type HostUriSchemeDefinition,
	type HunkSelection,
	type ImageContent,
	type LoginProvider,
	type MarketplaceSnapshot,
	type McpCapabilitySnapshot,
	type McpServerConfigInput,
	type McpServerStatus,
	type MemoryActionResult,
	type MemorySaveResult,
	type MemorySearchResult,
	type MemoryStatus,
	type ModelInfo,
	type ReviewCommit,
	type ReviewScope,
	type RpcCommand,
	type RpcPluginDescriptor,
	type RpcResponse,
	type RpcSettingDescriptor,
	type RpcSettingsSnapshot,
	SESSION_EVENT_TYPES,
	type SessionMessage,
	type SessionState,
	type SessionStats,
	type SessionSummary,
	SUBAGENT_FRAME_TYPES,
	type SubagentMessagesSnapshot,
	type SubagentSnapshot,
	type ThinkingLevel,
	type VibeModeResult,
	type WorkspaceEntry,
	type WorkspaceFileChange,
	type WorkspaceFileContent,
	type Worktree,
} from "./rpc-protocol";

const sessionEventTypes = new Set<string>(SESSION_EVENT_TYPES);
const subagentFrameTypes = new Set<string>(SUBAGENT_FRAME_TYPES);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

const READY_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;

export type EngineStatus = "idle" | "starting" | "ready" | "error" | "stopped";

export interface DesktopRpcClientHandlers {
	onEvent?: (event: EngineEvent) => void;
	onStatus?: (status: EngineStatus, detail?: string) => void;
	onStderr?: (line: string) => void;
	/** Fired when a subagent frame arrives; the app should refresh via getSubagents(). */
	onSubagentUpdate?: () => void;
	/** Fired for every extension UI request (dialogs, notify, open_url, …). */
	onExtensionUI?: (request: ExtensionUIRequest) => void;
	onExtensionError?: (error: ExtensionError) => void;
	onHostToolCall?: (request: HostToolCallRequest) => void | Promise<void>;
	onHostToolCancel?: (request: HostToolCancelRequest) => void;
	onHostUriRequest?: (request: HostUriRequest) => void | Promise<void>;
	onHostUriCancel?: (request: HostUriCancelRequest) => void;
}

export interface DesktopRpcTransport {
	start(cwd?: string): Promise<void>;
	stop(): Promise<void>;
	send(line: string): Promise<void>;
	onFrame(cb: (line: string) => void): Promise<() => void>;
	onStderr(cb: (line: string) => void): Promise<() => void>;
	onExit(cb: () => void): Promise<() => void>;
}

const mainEngineTransport: DesktopRpcTransport = {
	start: startEngine,
	stop: stopEngine,
	send: sendRpcLine,
	onFrame: onRpcFrame,
	onStderr: onRpcStderr,
	onExit: onEngineExit,
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
	#unlisten: Array<() => void> = [];
	#readyResolve: (() => void) | undefined;
	#readyReject: ((error: Error) => void) | undefined;
	#started = false;
	#transport: DesktopRpcTransport;

	constructor(handlers: DesktopRpcClientHandlers = {}, transport: DesktopRpcTransport = mainEngineTransport) {
		this.#handlers = handlers;
		this.#transport = transport;
	}

	async start(cwd?: string): Promise<void> {
		if (this.#started) throw new Error("client already started");
		this.#started = true;

		// Attach listeners before spawning so the `ready` frame can't be missed.
		this.#unlisten.push(await this.#transport.onFrame(line => this.#handleLine(line)));
		this.#unlisten.push(await this.#transport.onStderr(line => this.#handlers.onStderr?.(line)));
		this.#unlisten.push(
			await this.#transport.onExit(() => {
				this.#rejectPending("engine exited");
				this.#readyReject?.(new RpcTransportError("engine exited before ready", "startup", "startup"));
				this.#readyResolve = undefined;
				this.#readyReject = undefined;
				this.#started = false;
				this.#removeListeners();
				this.#handlers.onStatus?.("stopped");
			}),
		);

		const ready = Promise.withResolvers<void>();
		this.#readyResolve = ready.resolve;
		this.#readyReject = ready.reject;

		this.#handlers.onStatus?.("starting");
		try {
			await this.#transport.start(cwd);
		} catch (err) {
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
			this.#removeListeners();
			this.#started = false;
			this.#handlers.onStatus?.("error", errorMessage(err));
			throw err;
		} finally {
			if (readyTimer) clearTimeout(readyTimer);
			this.#readyResolve = undefined;
			this.#readyReject = undefined;
		}
	}

	async stop(): Promise<void> {
		this.#removeListeners();
		this.#started = false;
		this.#readyResolve = undefined;
		this.#readyReject = undefined;
		this.#rejectPending("client stopped");
		await this.#transport.stop().catch(() => {});
	}

	/**
	 * Detach this renderer client without reaping the app-owned engine. Electron
	 * can recreate the renderer (and React StrictMode can replay effects) while
	 * the desktop app is still alive; keeping the sidecar warm avoids a second
	 * cold start and mirrors an app-server lifecycle.
	 */
	disconnect(): void {
		this.#removeListeners();
		this.#started = false;
		this.#readyResolve = undefined;
		this.#readyReject = undefined;
		this.#rejectPending("client disconnected");
	}

	#removeListeners(): void {
		for (const unlisten of this.#unlisten) unlisten();
		this.#unlisten = [];
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
		const response = await this.#send({
			type: "prompt",
			message,
			...(images && images.length > 0 ? { images } : {}),
			...(streamingBehavior ? { streamingBehavior } : {}),
		});
		// The engine returns `{ agentInvoked: false }` only for local-only commands
		// (slash commands that never start a turn); a real prompt returns no data.
		const data = this.#data<{ agentInvoked?: boolean }>(response);
		return { agentInvoked: data.agentInvoked !== false };
	}

	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send(images && images.length > 0 ? { type: "steer", message, images } : { type: "steer", message });
	}

	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send(
			images && images.length > 0 ? { type: "follow_up", message, images } : { type: "follow_up", message },
		);
	}

	async abortAndPrompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send(
			images && images.length > 0
				? { type: "abort_and_prompt", message, images }
				: { type: "abort_and_prompt", message },
		);
	}

	async abort(): Promise<void> {
		await this.#send({ type: "abort" });
	}

	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.#send(
			parentSession ? { type: "new_session", parentSession } : { type: "new_session" },
		);
		return this.#data<{ cancelled: boolean }>(response);
	}

	/** Activate a cached project runtime, hydrating it on the first visit. */
	async setWorkspace(
		cwd: string,
	): Promise<{ cwd: string; restored: boolean; cacheSize: number; evictedCwds: string[] }> {
		const response = await this.#send({ type: "set_workspace", cwd }, READY_TIMEOUT_MS);
		return this.#data<{ cwd: string; restored: boolean; cacheSize: number; evictedCwds: string[] }>(response);
	}

	async getState(): Promise<SessionState> {
		const response = await this.#send({ type: "get_state" });
		return this.#data<SessionState>(response);
	}

	async getSettings(): Promise<RpcSettingsSnapshot> {
		const response = await this.#send({ type: "get_settings" });
		return this.#data<RpcSettingsSnapshot>(response);
	}

	async setSetting(path: string, value: unknown): Promise<RpcSettingDescriptor> {
		const response = await this.#send({ type: "set_setting", path, value });
		return this.#data<RpcSettingDescriptor>(response);
	}

	async setPluginEnabled(name: string, enabled: boolean): Promise<RpcPluginDescriptor> {
		const response = await this.#send({ type: "set_plugin_enabled", name, enabled });
		return this.#data<RpcPluginDescriptor>(response);
	}

	async setPluginFeatures(name: string, features: string[] | null): Promise<RpcPluginDescriptor> {
		const response = await this.#send({ type: "set_plugin_features", name, features }, 60_000);
		return this.#data<RpcPluginDescriptor>(response);
	}

	async setPluginSetting(name: string, key: string, value: unknown): Promise<RpcPluginDescriptor> {
		const response = await this.#send({ type: "set_plugin_setting", name, key, value }, 60_000);
		return this.#data<RpcPluginDescriptor>(response);
	}

	async deletePluginSetting(name: string, key: string): Promise<RpcPluginDescriptor> {
		const response = await this.#send({ type: "delete_plugin_setting", name, key }, 60_000);
		return this.#data<RpcPluginDescriptor>(response);
	}

	async installPlugin(spec: string): Promise<RpcPluginDescriptor> {
		const response = await this.#send({ type: "install_plugin", spec }, 120_000);
		return this.#data<RpcPluginDescriptor>(response);
	}

	async updatePlugin(name: string): Promise<RpcPluginDescriptor> {
		const response = await this.#send({ type: "update_plugin", name }, 120_000);
		return this.#data<RpcPluginDescriptor>(response);
	}

	async uninstallPlugin(name: string): Promise<void> {
		await this.#send({ type: "uninstall_plugin", name }, 120_000);
	}

	async getMarketplace(): Promise<MarketplaceSnapshot> {
		const response = await this.#send({ type: "get_marketplace" }, 60_000);
		return this.#data<MarketplaceSnapshot>(response);
	}

	async addMarketplace(source: string): Promise<MarketplaceSnapshot> {
		const response = await this.#send({ type: "add_marketplace", source }, 5 * 60_000);
		return this.#data<MarketplaceSnapshot>(response);
	}

	async updateMarketplace(name: string): Promise<MarketplaceSnapshot> {
		const response = await this.#send({ type: "update_marketplace", name }, 5 * 60_000);
		return this.#data<MarketplaceSnapshot>(response);
	}

	async removeMarketplace(name: string): Promise<MarketplaceSnapshot> {
		const response = await this.#send({ type: "remove_marketplace", name }, 5 * 60_000);
		return this.#data<MarketplaceSnapshot>(response);
	}

	async installMarketplacePlugin(
		name: string,
		marketplace: string,
		scope: "user" | "project" = "user",
	): Promise<MarketplaceSnapshot> {
		const response = await this.#send({ type: "install_marketplace_plugin", name, marketplace, scope }, 5 * 60_000);
		return this.#data<MarketplaceSnapshot>(response);
	}

	async upgradeMarketplacePlugin(pluginId: string, scope: "user" | "project"): Promise<MarketplaceSnapshot> {
		const response = await this.#send({ type: "upgrade_marketplace_plugin", pluginId, scope }, 5 * 60_000);
		return this.#data<MarketplaceSnapshot>(response);
	}

	async uninstallMarketplacePlugin(pluginId: string, scope: "user" | "project"): Promise<MarketplaceSnapshot> {
		const response = await this.#send({ type: "uninstall_marketplace_plugin", pluginId, scope }, 5 * 60_000);
		return this.#data<MarketplaceSnapshot>(response);
	}

	async setMarketplacePluginEnabled(
		pluginId: string,
		enabled: boolean,
		scope: "user" | "project",
	): Promise<MarketplaceSnapshot> {
		const response = await this.#send({ type: "set_marketplace_plugin_enabled", pluginId, enabled, scope });
		return this.#data<MarketplaceSnapshot>(response);
	}

	async getAvailableCommands(): Promise<AvailableCommand[]> {
		const response = await this.#send({ type: "get_available_commands" });
		return this.#data<{ commands?: AvailableCommand[] }>(response).commands ?? [];
	}

	async setTodos(phases: unknown[]): Promise<unknown[]> {
		const response = await this.#send({ type: "set_todos", phases });
		return this.#data<{ todoPhases?: unknown[] }>(response).todoPhases ?? [];
	}

	async setHostTools(tools: HostToolDefinition[]): Promise<string[]> {
		const response = await this.#send({ type: "set_host_tools", tools });
		return this.#data<{ toolNames?: string[] }>(response).toolNames ?? [];
	}

	async setHostUriSchemes(schemes: HostUriSchemeDefinition[]): Promise<string[]> {
		const response = await this.#send({ type: "set_host_uri_schemes", schemes });
		return this.#data<{ schemes?: string[] }>(response).schemes ?? [];
	}

	async sendHostToolUpdate(id: string, partialResult: HostToolResultPayload): Promise<void> {
		await this.#sendFrame({ type: "host_tool_update", id, partialResult });
	}

	async sendHostToolResult(id: string, result: HostToolResultPayload, isError = false): Promise<void> {
		await this.#sendFrame({ type: "host_tool_result", id, result, ...(isError ? { isError: true } : {}) });
	}

	async sendHostUriResult(id: string, result: Omit<HostUriResultFrame, "type" | "id">): Promise<void> {
		await this.#sendFrame({ type: "host_uri_result", id, ...result });
	}

	async setSubagentSubscription(level: "off" | "progress" | "events"): Promise<void> {
		await this.#send({ type: "set_subagent_subscription", level });
	}

	async getSubagents(): Promise<SubagentSnapshot[]> {
		const response = await this.#send({ type: "get_subagents" });
		return this.#data<{ subagents?: SubagentSnapshot[] }>(response).subagents ?? [];
	}

	async getSubagentMessages(
		options: { subagentId?: string; sessionFile?: string; fromByte?: number } = {},
	): Promise<SubagentMessagesSnapshot> {
		const response = await this.#send({ type: "get_subagent_messages", ...options });
		return this.#data<SubagentMessagesSnapshot>(response);
	}

	async readArtifact(artifactId: string, maxBytes?: number): Promise<ArtifactContent> {
		const response = await this.#send(
			maxBytes === undefined
				? { type: "read_artifact", artifactId }
				: { type: "read_artifact", artifactId, maxBytes },
		);
		return this.#data<ArtifactContent>(response);
	}

	async getGoal(): Promise<GoalResult> {
		const response = await this.#send({ type: "get_goal" });
		return this.#data<GoalResult>(response);
	}

	async createGoal(objective: string, tokenBudget?: number): Promise<GoalResult> {
		const response = await this.#send({ type: "create_goal", objective, ...(tokenBudget ? { tokenBudget } : {}) });
		return this.#data<GoalResult>(response);
	}

	async pauseGoal(): Promise<GoalResult> {
		const response = await this.#send({ type: "pause_goal" });
		return this.#data<GoalResult>(response);
	}

	async resumeGoal(): Promise<GoalResult> {
		const response = await this.#send({ type: "resume_goal" });
		return this.#data<GoalResult>(response);
	}

	async dropGoal(): Promise<GoalResult> {
		const response = await this.#send({ type: "drop_goal" });
		return this.#data<GoalResult>(response);
	}

	async guidedGoalTurn(messages: GuidedGoalMessage[], sideSessionId: string): Promise<GuidedGoalTurnResult> {
		const response = await this.#send({ type: "guided_goal_turn", messages, sideSessionId }, 120_000);
		return this.#data<GuidedGoalTurnResult>(response);
	}

	async setVibeMode(enabled: boolean): Promise<VibeModeResult> {
		const response = await this.#send({ type: "set_vibe_mode", enabled }, 60_000);
		return this.#data<VibeModeResult>(response);
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

	async configureGatewayProvider(
		input: GatewayProviderConfigInput,
	): Promise<{ providerId: string; modelsConfigPath: string }> {
		const response = await this.#send({ type: "configure_gateway_provider", ...input }, 60_000);
		return this.#data<{ providerId: string; modelsConfigPath: string }>(response);
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
		await this.#transport.send(JSON.stringify(response));
	}

	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.#send({ type: "get_available_models" });
		const data = this.#data<{ models?: ModelInfo[] }>(response);
		return data.models ?? [];
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		await this.#send({ type: "set_model", provider, modelId });
	}

	async cycleModel(): Promise<void> {
		await this.#send({ type: "cycle_model" });
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.#send({ type: "set_thinking_level", level });
	}

	async cycleThinkingLevel(): Promise<unknown> {
		const response = await this.#send({ type: "cycle_thinking_level" });
		return this.#data<unknown>(response);
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

	async compact(customInstructions?: string): Promise<unknown> {
		const response = await this.#send(
			customInstructions ? { type: "compact", customInstructions } : { type: "compact" },
			120_000,
		);
		return this.#data<unknown>(response);
	}

	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.#send({ type: "set_auto_compaction", enabled });
	}

	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.#send({ type: "set_auto_retry", enabled });
	}

	async abortRetry(): Promise<void> {
		await this.#send({ type: "abort_retry" });
	}

	async setApprovalMode(mode: ApprovalMode): Promise<void> {
		await this.#send({ type: "set_approval_mode", mode });
	}

	async setSessionName(name: string): Promise<void> {
		await this.#send({ type: "set_session_name", name });
	}

	async getSessionStats(): Promise<SessionStats> {
		const response = await this.#send({ type: "get_session_stats" });
		return this.#data<SessionStats>(response);
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

	async branch(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.#send({ type: "branch", entryId }, 60_000);
		return this.#data<{ text: string; cancelled: boolean }>(response);
	}

	async getBranchMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.#send({ type: "get_branch_messages" });
		return this.#data<{ messages?: Array<{ entryId: string; text: string }> }>(response).messages ?? [];
	}

	async getLastAssistantText(): Promise<string | null> {
		const response = await this.#send({ type: "get_last_assistant_text" });
		return this.#data<{ text: string | null }>(response).text;
	}

	async exportHtml(outputPath?: string): Promise<string> {
		const response = await this.#send(
			outputPath ? { type: "export_html", outputPath } : { type: "export_html" },
			120_000,
		);
		return this.#data<{ path: string }>(response).path;
	}

	async handoff(customInstructions?: string): Promise<{ savedPath?: string } | null> {
		const response = await this.#send(
			customInstructions ? { type: "handoff", customInstructions } : { type: "handoff" },
			120_000,
		);
		return this.#data<{ savedPath?: string } | null>(response);
	}

	/** Fetch the full persisted message history of the loaded session (for transcript re-seed). */
	async getMessages(): Promise<SessionMessage[]> {
		const response = await this.#send({ type: "get_messages" });
		return this.#data<{ messages?: SessionMessage[] }>(response).messages ?? [];
	}

	/** Fetch a concrete Git review scope for the Changes panel. */
	async getWorkspaceDiff(scope: ReviewScope = "all", ref?: string): Promise<WorkspaceFileChange[]> {
		const response = await this.#send({ type: "get_workspace_diff", scope, ...(ref ? { ref } : {}) });
		return this.#data<{ files?: WorkspaceFileChange[] }>(response).files ?? [];
	}

	async listReviewCommits(limit = 12): Promise<ReviewCommit[]> {
		const response = await this.#send({ type: "list_review_commits", limit });
		return this.#data<{ commits?: ReviewCommit[] }>(response).commits ?? [];
	}

	async listWorkspaceFiles(
		query?: string,
		limit?: number,
	): Promise<{ entries: WorkspaceEntry[]; truncated: boolean }> {
		const response = await this.#send({
			type: "list_workspace_files",
			...(query ? { query } : {}),
			...(limit ? { limit } : {}),
		});
		const data = this.#data<{ entries?: WorkspaceEntry[]; truncated?: boolean }>(response);
		return { entries: data.entries ?? [], truncated: data.truncated === true };
	}

	async readWorkspaceFile(path: string, maxBytes?: number): Promise<WorkspaceFileContent> {
		const response = await this.#send({ type: "read_workspace_file", path, ...(maxBytes ? { maxBytes } : {}) });
		return this.#data<WorkspaceFileContent>(response);
	}

	async getContextSnapshot(): Promise<ContextSnapshot> {
		const response = await this.#send({ type: "get_context_snapshot" });
		return this.#data<ContextSnapshot>(response);
	}

	async reloadSkills(): Promise<void> {
		await this.#send({ type: "reload_skills" }, 60_000);
	}

	async setSkillEnabled(name: string, enabled: boolean): Promise<void> {
		await this.#send({ type: "set_skill_enabled", name, enabled }, 60_000);
	}

	async getMcpStatus(): Promise<McpServerStatus[]> {
		const response = await this.#send({ type: "get_mcp_status" });
		return this.#data<{ servers?: McpServerStatus[] }>(response).servers ?? [];
	}

	async addMcpServer(
		name: string,
		scope: "user" | "project",
		config: McpServerConfigInput,
	): Promise<{ serverName: string; scope: "user" | "project"; status: string; toolCount: number }> {
		const response = await this.#send({ type: "add_mcp_server", name, scope, config }, 120_000);
		return this.#data(response);
	}

	async removeMcpServer(serverName: string, scope: "user" | "project"): Promise<void> {
		await this.#send({ type: "remove_mcp_server", serverName, scope }, 120_000);
	}

	async testMcpServer(
		serverName: string,
	): Promise<{ serverName: string; connected: true; serverInfo?: { name: string; version: string } }> {
		const response = await this.#send({ type: "test_mcp_server", serverName }, 60_000);
		return this.#data(response);
	}

	async reloadMcp(): Promise<{
		servers: number;
		connected: number;
		toolCount: number;
		errors: Array<{ serverName: string; message: string }>;
	}> {
		const response = await this.#send({ type: "reload_mcp" }, 120_000);
		return this.#data(response);
	}

	async getMcpCapabilities(): Promise<McpCapabilitySnapshot> {
		const response = await this.#send({ type: "get_mcp_capabilities" }, 60_000);
		return this.#data<McpCapabilitySnapshot>(response);
	}

	async reconnectMcp(serverName: string): Promise<unknown> {
		const response = await this.#send({ type: "reconnect_mcp", serverName }, 60_000);
		return this.#data<unknown>(response);
	}

	async setMcpEnabled(serverName: string, enabled: boolean): Promise<void> {
		await this.#send({ type: "set_mcp_enabled", serverName, enabled }, 60_000);
	}

	async unauthMcp(serverName: string): Promise<{ serverName: string; removed: boolean; status: "disconnected" }> {
		const response = await this.#send({ type: "unauth_mcp", serverName }, 60_000);
		return this.#data<{ serverName: string; removed: boolean; status: "disconnected" }>(response);
	}

	async reauthMcp(serverName: string): Promise<{ serverName: string; status: string; toolCount: number }> {
		const response = await this.#send({ type: "reauth_mcp", serverName }, 10 * 60_000);
		return this.#data<{ serverName: string; status: string; toolCount: number }>(response);
	}

	async getMemoryStatus(): Promise<MemoryStatus> {
		const response = await this.#send({ type: "get_memory_status" });
		return this.#data<MemoryStatus>(response);
	}

	async searchMemory(query: string, limit?: number): Promise<MemorySearchResult> {
		const response = await this.#send({ type: "search_memory", query, ...(limit ? { limit } : {}) });
		return this.#data<MemorySearchResult>(response);
	}

	async saveMemory(content: string, context?: string): Promise<MemorySaveResult> {
		const response = await this.#send({
			type: "save_memory",
			content,
			...(context ? { context } : {}),
			source: "omp-desktop",
		});
		return this.#data<MemorySaveResult>(response);
	}

	async enqueueMemory(): Promise<MemoryActionResult> {
		const response = await this.#send({ type: "enqueue_memory" }, 120_000);
		return this.#data<MemoryActionResult>(response);
	}

	async clearMemory(): Promise<MemoryActionResult> {
		const response = await this.#send({ type: "clear_memory" }, 120_000);
		return this.#data<MemoryActionResult>(response);
	}

	async browserOpen(url: string, name?: string): Promise<unknown> {
		const response = await this.#send({ type: "browser_open", url, ...(name ? { name } : {}) }, 60_000);
		return this.#data<unknown>(response);
	}

	async browserNavigate(url: string, name?: string): Promise<unknown> {
		const response = await this.#send({ type: "browser_navigate", url, ...(name ? { name } : {}) }, 60_000);
		return this.#data<unknown>(response);
	}

	async browserHistory(direction: "back" | "forward" | "reload", name?: string): Promise<unknown> {
		const response = await this.#send({ type: "browser_history", direction, ...(name ? { name } : {}) }, 60_000);
		return this.#data<unknown>(response);
	}

	async browserSnapshot(name?: string): Promise<unknown> {
		const response = await this.#send({ type: "browser_snapshot", ...(name ? { name } : {}) }, 60_000);
		return this.#data<unknown>(response);
	}

	async browserListTabs(): Promise<BrowserTab[]> {
		const response = await this.#send({ type: "browser_list_tabs" });
		return this.#data<{ tabs?: BrowserTab[] }>(response).tabs ?? [];
	}

	async browserState(): Promise<BrowserState> {
		const response = await this.#send({ type: "browser_list_tabs" });
		const data = this.#data<{ tabs?: BrowserTab[]; downloadPolicy?: "deny" }>(response);
		return { tabs: data.tabs ?? [], downloadPolicy: data.downloadPolicy ?? "deny" };
	}

	async browserClose(name?: string, all?: boolean): Promise<void> {
		await this.#send({ type: "browser_close", ...(name ? { name } : {}), ...(all ? { all } : {}) }, 60_000);
	}

	async getGitStatus(): Promise<GitStatus> {
		const response = await this.#send({ type: "get_git_status" });
		return this.#data<GitStatus>(response);
	}

	async bash(command: string): Promise<BashResult> {
		const response = await this.#send({ type: "bash", command }, 120_000);
		return this.#data<BashResult>(response);
	}

	async abortBash(): Promise<void> {
		await this.#send({ type: "abort_bash" });
	}

	async revertFiles(files: string[]): Promise<void> {
		await this.#send({ type: "revert_files", files }, 60_000);
	}

	async commit(message: string): Promise<{ stdout: string; stderr: string }> {
		const response = await this.#send({ type: "commit", message }, 60_000);
		return this.#data<{ stdout: string; stderr: string }>(response);
	}

	async push(remote?: string, refspec?: string): Promise<void> {
		await this.#send({ type: "push", ...(remote ? { remote } : {}), ...(refspec ? { refspec } : {}) }, 120_000);
	}

	async createPullRequest(title: string, body: string, base?: string, draft?: boolean): Promise<string> {
		const response = await this.#send(
			{ type: "create_pull_request", title, body, ...(base ? { base } : {}), ...(draft ? { draft } : {}) },
			120_000,
		);
		return this.#data<{ url: string }>(response).url;
	}

	async listWorktrees(): Promise<Worktree[]> {
		const response = await this.#send({ type: "list_worktrees" });
		return this.#data<{ worktrees?: Worktree[] }>(response).worktrees ?? [];
	}

	async createWorktree(worktreePath: string, ref: string, detach?: boolean): Promise<Worktree> {
		const response = await this.#send(
			{ type: "create_worktree", path: worktreePath, ref, ...(detach ? { detach } : {}) },
			60_000,
		);
		return this.#data<Worktree>(response);
	}

	async removeWorktree(worktreePath: string, force = false): Promise<void> {
		await this.#send({ type: "remove_worktree", path: worktreePath, ...(force ? { force } : {}) }, 60_000);
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

		if (data.type === "ready") {
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

		if (data.type === "extension_error" && typeof data.error === "string") {
			this.#handlers.onExtensionError?.(data as unknown as ExtensionError);
			return;
		}

		if (data.type === "host_tool_call" && typeof data.id === "string" && typeof data.toolName === "string") {
			const request = data as unknown as HostToolCallRequest;
			void this.#handleHostToolCall(request);
			return;
		}

		if (data.type === "host_tool_cancel" && typeof data.id === "string" && typeof data.targetId === "string") {
			this.#handlers.onHostToolCancel?.(data as unknown as HostToolCancelRequest);
			return;
		}

		if (data.type === "host_uri_request" && typeof data.id === "string" && typeof data.url === "string") {
			const request = data as unknown as HostUriRequest;
			void this.#handleHostUriRequest(request);
			return;
		}

		if (data.type === "host_uri_cancel" && typeof data.id === "string" && typeof data.targetId === "string") {
			this.#handlers.onHostUriCancel?.(data as unknown as HostUriCancelRequest);
			return;
		}

		// Results/updates are host -> engine frames and are not expected from the
		// engine. Ignore them to avoid accidental response loops.
	}

	#sendFrame(frame: HostToolUpdateFrame | HostToolResultFrame | HostUriResultFrame): Promise<void> {
		return this.#transport.send(JSON.stringify(frame));
	}

	async #handleHostToolCall(request: HostToolCallRequest): Promise<void> {
		if (!this.#handlers.onHostToolCall) {
			await this.sendHostToolResult(
				request.id,
				{
					content: [{ type: "text", text: `No desktop handler registered for host tool "${request.toolName}"` }],
					isError: true,
				},
				true,
			);
			return;
		}
		try {
			await this.#handlers.onHostToolCall(request);
		} catch (error) {
			await this.sendHostToolResult(
				request.id,
				{
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					isError: true,
				},
				true,
			);
		}
	}

	async #handleHostUriRequest(request: HostUriRequest): Promise<void> {
		if (!this.#handlers.onHostUriRequest) {
			await this.sendHostUriResult(request.id, {
				isError: true,
				error: `No desktop handler registered for host URI ${request.url}`,
			});
			return;
		}
		try {
			await this.#handlers.onHostUriRequest(request);
		} catch (error) {
			await this.sendHostUriResult(request.id, {
				isError: true,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	#send(command: RpcCommand, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<RpcResponse> {
		const id = `req_${++this.#reqId}`;
		const promise = new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new RpcTimeoutError(`timeout waiting for response to ${command.type}`, command.type, id));
			}, timeoutMs);
			this.#pending.set(id, { resolve, reject, timer, command: command.type, requestId: id });
		});
		void this.#transport.send(JSON.stringify({ ...command, id })).catch((err: unknown) => {
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
				throw new RpcEngineError(response.error, response.command, response.id ?? id);
			}
			return response;
		});
	}

	#data<T>(response: RpcResponse): T {
		// #send already rejected non-success responses, so `data` is present here.
		return (response.success ? (response.data ?? {}) : {}) as T;
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
}
