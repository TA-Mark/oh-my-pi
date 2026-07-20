/**
 * OMP RPC protocol types for the desktop client (standalone, DOM-safe).
 *
 * These are hand-authored to mirror the canonical engine source:
 *   - commands/responses: packages/coding-agent/src/modes/rpc/rpc-types.ts
 *   - events:             packages/agent/src/types.ts (AgentEvent)
 *
 * DRIFT GUARD: re-exporting the canonical `.ts` types was tried and rejected —
 * it drags the entire agent/ai source graph into the desktop typecheck under an
 * incompatible lib/module config (hundreds of spurious errors: `.md` imports,
 * `toWellFormed`/es2024, DOM `MessageEvent`). Instead, protocol conformance is
 * verified at runtime by scripts/smoke-rpc.ts, which drives the real engine and
 * asserts the command/response contract. Keep that probe in sync with this file.
 */

// ── Commands (frontend -> engine) ────────────────────────────────────────────

/**
 * Image attached to a `prompt` (multimodal input). Mirrors pi-ai `ImageContent`.
 * `data` is base64 (no data-URL prefix); `mimeType` e.g. "image/png".
 */
export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
	detail?: "auto" | "low" | "high" | "original";
}

export interface AvailableCommand {
	name: string;
	aliases?: string[];
	description?: string;
	source: string;
}

export type McpServerConfigInput =
	| {
			type?: "stdio";
			command: string;
			args?: string[];
			env?: Record<string, string>;
			cwd?: string;
			timeout?: number;
	  }
	| {
			type: "http" | "sse";
			url: string;
			headers?: Record<string, string>;
			timeout?: number;
	  };

export type RpcCommand =
	| {
			id?: string;
			type: "prompt";
			message: string;
			images?: ImageContent[];
			streamingBehavior?: "steer" | "followUp";
	  }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "abort_and_prompt"; message: string; images?: ImageContent[] }
	| { id?: string; type: "new_session"; parentSession?: string }
	| { id?: string; type: "set_workspace"; cwd: string }
	| { id?: string; type: "get_state" }
	| { id?: string; type: "get_settings" }
	| { id?: string; type: "set_setting"; path: string; value: unknown }
	| { id?: string; type: "set_plugin_enabled"; name: string; enabled: boolean }
	| { id?: string; type: "set_plugin_features"; name: string; features: string[] | null }
	| { id?: string; type: "set_plugin_setting"; name: string; key: string; value: unknown }
	| { id?: string; type: "delete_plugin_setting"; name: string; key: string }
	| { id?: string; type: "install_plugin"; spec: string }
	| { id?: string; type: "update_plugin"; name: string }
	| { id?: string; type: "uninstall_plugin"; name: string }
	| { id?: string; type: "get_marketplace" }
	| { id?: string; type: "add_marketplace"; source: string }
	| { id?: string; type: "update_marketplace"; name: string }
	| { id?: string; type: "remove_marketplace"; name: string }
	| { id?: string; type: "install_marketplace_plugin"; name: string; marketplace: string; scope?: "user" | "project" }
	| { id?: string; type: "upgrade_marketplace_plugin"; pluginId: string; scope?: "user" | "project" }
	| { id?: string; type: "uninstall_marketplace_plugin"; pluginId: string; scope?: "user" | "project" }
	| {
			id?: string;
			type: "set_marketplace_plugin_enabled";
			pluginId: string;
			enabled: boolean;
			scope?: "user" | "project";
	  }
	| { id?: string; type: "get_available_commands" }
	| { id?: string; type: "set_todos"; phases: unknown[] }
	| { id?: string; type: "set_host_tools"; tools: unknown[] }
	| { id?: string; type: "set_host_uri_schemes"; schemes: unknown[] }
	| { id?: string; type: "get_available_models" }
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }
	| { id?: string; type: "set_approval_mode"; mode: ApprovalMode }
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_interrupt_mode"; mode: "immediate" | "wait" }
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }
	| { id?: string; type: "set_session_name"; name: string }
	| { id?: string; type: "get_subagents" }
	| { id?: string; type: "set_subagent_subscription"; level: "off" | "progress" | "events" }
	| { id?: string; type: "get_subagent_messages"; subagentId?: string; sessionFile?: string; fromByte?: number }
	| { id?: string; type: "read_artifact"; artifactId: string; maxBytes?: number }
	| { id?: string; type: "get_goal" }
	| { id?: string; type: "create_goal"; objective: string; tokenBudget?: number }
	| { id?: string; type: "pause_goal" }
	| { id?: string; type: "resume_goal" }
	| { id?: string; type: "drop_goal" }
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "list_sessions" }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "branch"; entryId: string }
	| { id?: string; type: "get_branch_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "handoff"; customInstructions?: string }
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "get_workspace_diff"; scope?: ReviewScope; ref?: string }
	| { id?: string; type: "list_review_commits"; limit?: number }
	| { id?: string; type: "list_workspace_files"; query?: string; limit?: number }
	| { id?: string; type: "read_workspace_file"; path: string; maxBytes?: number }
	| { id?: string; type: "get_context_snapshot" }
	| { id?: string; type: "reload_skills" }
	| { id?: string; type: "set_skill_enabled"; name: string; enabled: boolean }
	| { id?: string; type: "get_mcp_status" }
	| { id?: string; type: "add_mcp_server"; name: string; scope: "user" | "project"; config: McpServerConfigInput }
	| { id?: string; type: "remove_mcp_server"; serverName: string; scope: "user" | "project" }
	| { id?: string; type: "test_mcp_server"; serverName: string }
	| { id?: string; type: "reload_mcp" }
	| { id?: string; type: "get_mcp_capabilities" }
	| { id?: string; type: "reconnect_mcp"; serverName: string }
	| { id?: string; type: "set_mcp_enabled"; serverName: string; enabled: boolean }
	| { id?: string; type: "unauth_mcp"; serverName: string }
	| { id?: string; type: "reauth_mcp"; serverName: string }
	| { id?: string; type: "get_memory_status" }
	| { id?: string; type: "search_memory"; query: string; limit?: number }
	| { id?: string; type: "save_memory"; content: string; context?: string; source?: string; importance?: number }
	| { id?: string; type: "enqueue_memory" }
	| { id?: string; type: "clear_memory" }
	| { id?: string; type: "browser_open"; url: string; name?: string }
	| { id?: string; type: "browser_close"; name?: string; all?: boolean }
	| { id?: string; type: "browser_snapshot"; name?: string }
	| { id?: string; type: "browser_navigate"; url: string; name?: string }
	| { id?: string; type: "browser_history"; direction: "back" | "forward" | "reload"; name?: string }
	| { id?: string; type: "browser_list_tabs" }
	| { id?: string; type: "get_git_status" }
	| { id?: string; type: "revert_files"; files: string[] }
	| { id?: string; type: "commit"; message: string }
	| { id?: string; type: "push"; remote?: string; refspec?: string }
	| { id?: string; type: "create_pull_request"; title: string; body: string; base?: string; draft?: boolean }
	| { id?: string; type: "list_worktrees" }
	| { id?: string; type: "create_worktree"; path: string; ref: string; detach?: boolean }
	| { id?: string; type: "remove_worktree"; path: string; force?: boolean }
	| { id?: string; type: "get_login_providers" }
	| { id?: string; type: "login"; providerId: string }
	| { id?: string; type: "set_api_key"; providerId: string; apiKey: string }
	| { id?: string; type: "logout"; providerId: string }
	| { id?: string; type: "set_plan_mode"; enabled: boolean; workflow?: "parallel" | "iterative" }
	| { id?: string; type: "stage_hunks"; selections: HunkSelection[] }
	| { id?: string; type: "unstage"; files?: string[] };

/**
 * Hunk selection for `stage_hunks` (mirrors engine `RpcHunkSelection`). `all`
 * stages the whole file; `indices` stages hunks by 0-based diff position.
 */
export interface HunkSelection {
	path: string;
	hunks: { type: "all" } | { type: "indices"; indices: number[] };
}

/**
 * Session thinking levels accepted by `set_thinking_level`
 * (mirrors ThinkingLevel in packages/agent/src/thinking.ts; "inherit" omitted —
 * it's for nested/agent defaults, not a user-facing session choice).
 */
export const THINKING_LEVELS = ["off", "auto", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number] | "inherit";
export type ApprovalMode = "always-ask" | "write" | "yolo";

// ── Responses (engine -> frontend) ───────────────────────────────────────────

interface RpcResponseBase {
	type: "response";
	id?: string;
	command: string;
}
export type RpcResponse =
	| (RpcResponseBase & { success: true; data?: unknown })
	| (RpcResponseBase & { success: false; error: string });

/** Emitted once when the engine finished startup and is ready for commands. */
export interface ReadyFrame {
	type: "ready";
}

/** Subset of the engine `RpcSessionState` the desktop reads (see rpc-types.ts). */
export interface SessionState {
	model?: ModelInfo;
	thinkingLevel?: ThinkingLevel;
	/** User selector; `auto` remains visible while thinkingLevel is its effective effort. */
	configuredThinkingLevel?: ThinkingLevel;
	approvalMode?: ApprovalMode;
	isStreaming: boolean;
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	messageCount: number;
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	interruptMode?: "immediate" | "wait";
	isCompacting?: boolean;
	autoCompactionEnabled?: boolean;
	autoRetryEnabled?: boolean;
	queuedMessageCount?: number;
	/** Plan-mode snapshot when active (undefined = plan mode off). */
	planMode?: PlanModeState;
	/** Goal-mode snapshot when a goal exists. */
	goalMode?: GoalModeState;
	/** Authoritative model context usage reported by the core. */
	contextUsage?: ContextUsage;
	contextBreakdown?: ContextBreakdown;
}

export interface ContextUsage {
	tokens: number;
	contextWindow: number;
	percent: number;
}

export interface ContextBreakdown {
	contextWindow: number;
	anchored: boolean;
	usedTokens: number;
	systemPromptTokens: number;
	systemToolsTokens: number;
	systemContextTokens: number;
	skillsTokens: number;
	messagesTokens: number;
}

export interface SessionStats {
	sessionFile?: string;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; total: number };
	premiumRequests: number;
	cost: number;
	contextUsage?: unknown;
}

/** Plan-mode snapshot (mirrors engine `RpcPlanModeState`). */
export interface PlanModeState {
	enabled: boolean;
	planFilePath: string;
	workflow?: "parallel" | "iterative";
}

export type GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";

export interface GoalState {
	id: string;
	objective: string;
	status: GoalStatus;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
}

export interface GoalModeState {
	enabled: boolean;
	mode: "active" | "exiting";
	reason?: "completed";
	goal: GoalState;
}

export interface GoalResult {
	goal: GoalState | null;
	state: GoalModeState | null;
}

/** One changed file from `get_workspace_diff` (mirrors engine `RpcWorkspaceFileChange`). */
export interface WorkspaceFileChange {
	path: string;
	status: "modified" | "added" | "deleted" | "renamed" | "untracked";
	diff: string;
	additions: number;
	deletions: number;
	oldPath?: string;
	/** Diff omitted (binary or oversized); path/status still shown. */
	truncated?: boolean;
}

export type ReviewScope = "all" | "unstaged" | "staged" | "commit" | "branch" | "last_turn";

export interface ReviewCommit {
	hash: string;
	subject: string;
	committedAt: number;
}

export type RpcSettingCategory =
	| "providers"
	| "tools"
	| "mcp"
	| "plugins"
	| "skills"
	| "memory"
	| "retry"
	| "compaction";
export type RpcSettingType = "boolean" | "string" | "number" | "enum" | "array" | "record";
export interface RpcSettingOption {
	value: string;
	label: string;
	description?: string;
}
export interface RpcSettingDescriptor {
	path: string;
	category: Exclude<RpcSettingCategory, "plugins">;
	type: RpcSettingType;
	value: unknown;
	configured: boolean;
	label: string;
	description: string;
	group?: string;
	options?: RpcSettingOption[];
	activation: "immediate" | "next_engine_restart";
}
export interface RpcPluginDescriptor {
	name: string;
	version: string;
	description?: string;
	enabled: boolean;
	enabledFeatures: string[];
	availableFeatures: string[];
	settings: RpcPluginSettingDescriptor[];
}

export interface RpcPluginSettingDescriptor {
	key: string;
	type: "string" | "number" | "boolean" | "enum";
	description?: string;
	secret: boolean;
	env?: string;
	environmentAvailable: boolean;
	configured: boolean;
	value: unknown;
	defaultValue?: string | number | boolean;
	values?: string[];
	min?: number;
	max?: number;
	step?: number;
}
export interface RpcSettingsSnapshot {
	settings: RpcSettingDescriptor[];
	plugins: RpcPluginDescriptor[];
}
export interface MarketplacePluginDescriptor {
	id: string;
	name: string;
	marketplace: string;
	description?: string;
	version?: string;
	author?: string;
	homepage?: string;
	repository?: string;
	license?: string;
	keywords?: string[];
	category?: string;
	tags?: string[];
	capabilities: Array<"commands" | "agents" | "hooks" | "mcp" | "lsp" | "dap">;
	installations: Array<{ scope: "user" | "project"; version: string; enabled: boolean; shadowed: boolean }>;
}
export interface MarketplaceSnapshot {
	marketplaces: Array<{ name: string; sourceType: "github" | "git" | "url" | "local"; updatedAt: string }>;
	plugins: MarketplacePluginDescriptor[];
}
export interface WorkspaceEntry {
	path: string;
	name: string;
	type: "file" | "directory";
	size: number | null;
	mtimeMs: number | null;
}
export interface WorkspaceFileContent {
	path: string;
	content: string;
	size: number;
	truncated: boolean;
}
export interface GitStatus {
	branch: string | null;
	upstream: string | null;
	baseBranch: string | null;
	branches: string[];
	localBranches: string[];
	staged: number;
	unstaged: number;
	untracked: number;
}
export interface Worktree {
	path: string;
	branch: string | null;
	detached: boolean;
	head: string | null;
}
export interface BrowserTab {
	name: string;
	url: string;
	title?: string;
	state: "alive" | "dead";
	backend: "worker" | "cmux";
}

export interface BrowserState {
	tabs: BrowserTab[];
	downloadPolicy: "deny";
}
export interface BashResult {
	output: string;
	exitCode?: number;
	cancelled: boolean;
	truncated: boolean;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	artifactId?: string;
	workingDir?: string;
}
export interface ScheduledTaskRun {
	at: string;
	status: "success" | "failed" | "skipped";
	detail?: string;
}
export interface ScheduledTask {
	id: string;
	name: string;
	workspace: string;
	prompt: string;
	intervalMinutes: number;
	maxRetries: number;
	enabled: boolean;
	nextRunAt: string;
	lastRunAt?: string;
	lastStatus?: ScheduledTaskRun["status"];
	lastError?: string;
	runs: ScheduledTaskRun[];
}
export type ScheduledTaskInput = Pick<
	ScheduledTask,
	"name" | "workspace" | "prompt" | "intervalMinutes" | "maxRetries" | "enabled"
> & { id?: string };
export interface ContextSnapshot {
	skills: string[];
	memoryBackend: string | null;
	skillDetails: Array<{
		name: string;
		description: string;
		filePath: string;
		source: string;
		provider: string;
		providerName: string;
		level: "user" | "project" | "native";
		hidden?: boolean;
	}>;
	skillWarnings: Array<{ skillPath: string; message: string }>;
}
export interface McpServerStatus {
	name: string;
	enabled: boolean;
	status: "connected" | "connecting" | "disconnected";
	toolCount: number;
	toolNames: string[];
	transport: "stdio" | "http" | "sse" | "unknown";
	source?: { provider: string; providerName: string; level: "user" | "project" | "native" };
	auth: { configured: boolean; oauth: boolean; credentialConfigured: boolean; credentialAvailable: boolean };
	lastError?: string;
}
export interface McpCapabilitySnapshot {
	resources: Array<{
		serverName: string;
		resources: Array<{
			uri: string;
			name: string;
			title?: string;
			description?: string;
			mimeType?: string;
			size?: number;
		}>;
		templates: Array<{ uriTemplate: string; name: string; title?: string; description?: string; mimeType?: string }>;
	}>;
	prompts: Array<{
		serverName: string;
		prompts: Array<{
			name: string;
			title?: string;
			description?: string;
			arguments?: Array<{ name: string; description?: string; required?: boolean }>;
		}>;
	}>;
	notifications: {
		enabled: boolean;
		servers: Array<{
			serverName: string;
			toolsChanged: boolean;
			resourcesChanged: boolean;
			promptsChanged: boolean;
			resourceSubscriptions: string[];
		}>;
	};
}
export interface MemoryStatus {
	backend: "off" | "local" | "hindsight" | "mnemopi";
	active: boolean;
	writable: boolean;
	searchable: boolean;
	scope?: string;
	retainBank?: string;
	recallBanks?: string[];
	workingCount?: number;
	episodicCount?: number;
	tripleCount?: number;
	lastMemory?: string;
	lastRecall?: boolean;
	database?: string;
	message?: string;
	error?: string;
}
export interface MemorySearchItem {
	id?: string;
	content: string;
	source?: string;
	timestamp?: string;
	score?: number;
}
export interface MemorySearchResult {
	backend: "off" | "local" | "hindsight" | "mnemopi";
	query: string;
	count: number;
	items: MemorySearchItem[];
	message?: string;
}

export interface MemorySaveResult {
	backend: "off" | "local" | "hindsight" | "mnemopi";
	stored: number;
	ids?: string[];
	queued?: boolean;
	message?: string;
}

export interface MemoryActionResult {
	backend: "off" | "local" | "hindsight" | "mnemopi";
	operation: "clear" | "enqueue";
	success: boolean;
	message?: string;
}

/** Session descriptor from `list_sessions` (mirrors engine `RpcSessionSummary`). */
export interface SessionSummary {
	path: string;
	id: string;
	title?: string;
	messageCount: number;
	/** ISO-8601 timestamps. */
	created: string;
	modified: string;
	/** True when this is the session currently loaded in the engine. */
	active: boolean;
}

/**
 * A persisted session message from `get_messages` (subset of engine `AgentMessage`).
 * Used to re-seed the transcript after switching sessions. `toolResult`/`toolCall`
 * shapes mirror pi-ai `ToolResultMessage` / `ToolCall`.
 */
export interface SessionMessage {
	role: "user" | "assistant" | "developer" | "toolResult";
	content?: ContentPart[] | string;
	/** assistant turn failure. */
	errorMessage?: string;
	stopReason?: string;
	/** role === "toolResult" fields. */
	toolCallId?: string;
	toolName?: string;
	details?: unknown;
	isError?: boolean;
}

/** Lightweight model descriptor for header display (subset of pi-ai `Model`). */
export interface ModelInfo {
	provider: string;
	id: string;
	contextWindow?: number;
	reasoning?: boolean;
	thinking?: {
		efforts?: readonly ThinkingLevel[];
		defaultLevel?: ThinkingLevel;
		requiresEffort?: boolean;
	};
}

/** Subset of engine `RpcSubagentSnapshot` the subagent panel renders. */
export interface SubagentSnapshot {
	id: string;
	index: number;
	agent: string;
	status: string;
	task?: string;
	assignment?: string;
	description?: string;
}

export interface SubagentMessagesSnapshot {
	sessionFile: string;
	fromByte: number;
	nextByte: number;
	reset: boolean;
	entries: unknown[];
	messages: SessionMessage[];
}

export interface ArtifactContent {
	id: string;
	content: string;
	size: number;
	truncated: boolean;
}

/** Frame types the RPC server emits for subagents (after set_subagent_subscription). */
export const SUBAGENT_FRAME_TYPES = ["subagent_lifecycle", "subagent_progress", "subagent_event"] as const;

// ── Host bridges (engine ↔ desktop) ─────────────────────────────────────────
// These frames mirror RpcHostTool* and RpcHostUri* in the canonical OMP RPC
// protocol.  The desktop keeps the payload deliberately DOM-safe while
// preserving the AgentToolResult wire shape (content/details/isError).

export interface HostToolDefinition {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
	hidden?: boolean;
	loadMode?: "eager" | "discoverable" | "explicit";
}

/** Safe Electron implementations exposed by the optional host registry UI. */
export type HostToolAction = "open_external_url" | "reveal_path" | "copy_text" | "read_workspace_file";

export interface DesktopHostToolConfig extends HostToolDefinition {
	action: HostToolAction;
	requiresApproval: boolean;
}

export interface HostToolCallRequest {
	type: "host_tool_call";
	id: string;
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
}

export interface HostToolCancelRequest {
	type: "host_tool_cancel";
	id: string;
	targetId: string;
}

export type HostToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface HostToolResultPayload {
	content: HostToolContent[];
	details?: unknown;
	isError?: boolean;
	useless?: boolean;
}

export interface HostToolUpdateFrame {
	type: "host_tool_update";
	id: string;
	partialResult: HostToolResultPayload;
}

export interface HostToolResultFrame {
	type: "host_tool_result";
	id: string;
	result: HostToolResultPayload;
	isError?: boolean;
}

export interface HostUriSchemeDefinition {
	scheme: string;
	description?: string;
	writable?: boolean;
	immutable?: boolean;
}

export type HostUriOperation = "read" | "write";

export interface HostUriRequest {
	type: "host_uri_request";
	id: string;
	operation: HostUriOperation;
	url: string;
	content?: string;
}

export interface HostUriCancelRequest {
	type: "host_uri_cancel";
	id: string;
	targetId: string;
}

export interface HostUriResultFrame {
	type: "host_uri_result";
	id: string;
	content?: string;
	contentType?: "text/markdown" | "application/json" | "text/plain";
	notes?: string[];
	immutable?: boolean;
	isError?: boolean;
	error?: string;
}

// ── Extension UI (engine -> frontend) ────────────────────────────────────────
// Mirrors RpcExtensionUIRequest in coding-agent rpc-types.ts. The engine drives
// dialogs, notifications, editor control, and OAuth URLs through these frames;
// the *_dialog methods require an ExtensionUIResponse keyed by `id`.

export type ExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "editor";
			title: string;
			prefill?: string;
			promptStyle?: boolean;
	  }
	| { type: "extension_ui_request"; id: string; method: "cancel"; targetId: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines?: string[];
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "open_url";
			url: string;
			launchUrl?: string;
			instructions?: string;
	  };

/** Methods that block waiting for an {@link ExtensionUIResponse}. */
export type ExtensionUIDialogMethod = "select" | "confirm" | "input" | "editor";

export type ExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };

/** Runtime failure emitted by an extension during RPC startup or dispatch. */
export interface ExtensionError {
	type: "extension_error";
	extensionPath?: string;
	event?: string;
	error: string;
}

export interface LoginProvider {
	id: string;
	name: string;
	available: boolean;
	authenticated: boolean;
	authKind?: "runtime" | "config" | "oauth" | "api_key" | "env" | "fallback";
	envVar?: string;
	supportsOAuth: boolean;
	supportsApiKey: boolean;
}

// ── Event classification (mirrors rpc-client.ts) ─────────────────────────────

export const AGENT_EVENT_TYPES = [
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
] as const;

export const SESSION_EVENT_TYPES = [
	...AGENT_EVENT_TYPES,
	"auto_compaction_start",
	"auto_compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"retry_fallback_applied",
	"retry_fallback_succeeded",
	"ttsr_triggered",
	"todo_reminder",
	"todo_auto_clear",
	"irc_message",
	"notice",
	"thinking_level_changed",
	"goal_updated",
	"plan_mode_changed",
	"available_commands_update",
] as const;

// ── Event shapes the reducer reads (mirrors AgentEvent + a few session events) ─

export interface TextPart {
	type: "text";
	text: string;
}
export type ContentPart = TextPart | { type: string; [key: string]: unknown };

/** Message snapshot carried by message_* events (`AgentMessage`). */
export interface EngineMessage {
	role: string;
	content: ContentPart[] | string;
	/** Present on assistant messages when the provider call failed (stopReason "error"). */
	errorMessage?: string;
	stopReason?: string;
}

/**
 * Events the client forwards to the reducer. Precise union (no catch-all) so the
 * reducer switch narrows cleanly; the client casts inbound frames whose `type`
 * is in {@link SESSION_EVENT_TYPES}, and the reducer ignores unmodeled ones.
 */
export type EngineEvent =
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "message_start"; message: EngineMessage }
	| { type: "message_update"; message: EngineMessage; assistantMessageEvent?: { type: string; delta?: string } }
	| { type: "message_end"; message: EngineMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args?: unknown; intent?: string }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args?: unknown; partialResult?: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result?: unknown; isError?: boolean }
	| { type: "notice"; message?: string; text?: string; level?: "info" | "warning" | "error" }
	| {
			type: "auto_compaction_start";
			reason: "threshold" | "overflow" | "idle" | "incomplete";
			action: "context-full" | "handoff" | "shake" | "snapcompact";
	  }
	| {
			type: "auto_compaction_end";
			action: "context-full" | "handoff" | "shake" | "snapcompact";
			aborted: boolean;
			willRetry: boolean;
			skipped?: boolean;
			errorMessage?: string;
	  }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "retry_fallback_applied"; from: string; to: string; role: string }
	| { type: "retry_fallback_succeeded"; model: string; role: string }
	| { type: "ttsr_triggered"; rules: unknown[] }
	| { type: "todo_reminder"; todos: unknown[]; attempt: number; maxAttempts: number }
	| { type: "todo_auto_clear" }
	| { type: "irc_message"; message: unknown }
	| {
			type: "thinking_level_changed";
			thinkingLevel?: ThinkingLevel;
			configured?: ThinkingLevel;
			resolved?: string;
	  }
	| { type: "goal_updated"; goal: GoalState | null; state?: GoalModeState }
	| { type: "available_commands_update"; commands: AvailableCommand[] }
	| { type: "plan_mode_changed"; planMode?: PlanModeState };
