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

export type RpcCommand =
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "abort_and_prompt"; message: string; images?: ImageContent[] }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "new_session"; parentSession?: string }
	| { id?: string; type: "set_workspace"; cwd: string }
	| { id?: string; type: "get_state" }
	| { id?: string; type: "get_settings" }
	| { id?: string; type: "set_setting"; path: string; value: unknown }
	| { id?: string; type: "set_plugin_enabled"; name: string; enabled: boolean }
	| { id?: string; type: "install_plugin"; spec: string }
	| { id?: string; type: "update_plugin"; name: string }
	| { id?: string; type: "uninstall_plugin"; name: string }
	| { id?: string; type: "get_available_commands" }
	| { id?: string; type: "get_subagent_messages"; subagentId?: string; sessionFile?: string; fromByte?: number }
	| { id?: string; type: "set_host_tools"; tools: HostToolDefinition[] }
	| { id?: string; type: "set_host_uri_schemes"; schemes: HostUriSchemeDefinition[] }
	| { id?: string; type: "get_available_models" }
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "set_approval_mode"; mode: ApprovalMode }
	| { id?: string; type: "set_session_name"; name: string }
	| { id?: string; type: "get_subagents" }
	| { id?: string; type: "set_subagent_subscription"; level: "off" | "progress" | "events" }
	| { id?: string; type: "list_sessions" }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "get_workspace_diff" }
	| { id?: string; type: "list_workspace_files"; query?: string; limit?: number }
	| { id?: string; type: "read_workspace_file"; path: string; maxBytes?: number }
	| { id?: string; type: "get_context_snapshot" }
	| { id?: string; type: "get_mcp_status" }
	| { id?: string; type: "reconnect_mcp"; serverName: string }
	| { id?: string; type: "set_mcp_enabled"; serverName: string; enabled: boolean }
	| { id?: string; type: "get_memory_status" }
	| { id?: string; type: "search_memory"; query: string; limit?: number }
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
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "get_branch_messages" }
	| { id?: string; type: "branch"; entryId: string }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "handoff"; customInstructions?: string }
	| { id?: string; type: "cycle_thinking_level" }
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_interrupt_mode"; mode: "immediate" | "wait" }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }
	| { id?: string; type: "set_todos"; phases: TodoPhase[] }
	| { id?: string; type: "get_login_providers" }
	| { id?: string; type: "login"; providerId: string }
	| { id?: string; type: "set_api_key"; providerId: string; apiKey: string }
	| { id?: string; type: "logout"; providerId: string }
	| { id?: string; type: "set_plan_mode"; enabled: boolean; workflow?: "parallel" | "iterative" }
	| { id?: string; type: "stage_hunks"; selections: HunkSelection[] }
	| { id?: string; type: "unstage"; files?: string[] };

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
}

export interface McpServerStatus {
	name: string;
	status: "connected" | "connecting" | "disconnected";
	toolCount: number;
	transport: "stdio" | "http" | "sse" | "unknown";
	auth: { configured: boolean; oauth: boolean; credentialConfigured: boolean };
}

export interface MemoryStatus {
	backend: "off" | "local" | "hindsight" | "mnemopi";
	active: boolean;
	writable: boolean;
	searchable: boolean;
	message?: string;
	error?: string;
	workingCount?: number;
	episodicCount?: number;
	database?: string;
}

export interface MemorySearchResult {
	backend: MemoryStatus["backend"];
	query: string;
	count: number;
	items: Array<{ id?: string; content: string; source?: string; timestamp?: string; score?: number }>;
	message?: string;
}

export interface BrowserTabInfo {
	name: string;
	url: string;
	title?: string;
	state: "alive" | "dead";
	backend: "worker" | "cmux";
}

export type SettingCategory = "providers" | "tools" | "mcp" | "plugins" | "skills" | "memory" | "retry" | "compaction";
export type SettingType = "boolean" | "string" | "number" | "enum" | "array" | "record";

export interface SettingOption {
	value: string;
	label: string;
	description?: string;
}

export interface SettingDescriptor {
	path: string;
	category: Exclude<SettingCategory, "plugins">;
	type: SettingType;
	value: unknown;
	configured: boolean;
	label: string;
	description: string;
	group?: string;
	options?: SettingOption[];
	activation: "immediate" | "next_engine_restart";
}

export interface PluginDescriptor {
	name: string;
	version: string;
	description?: string;
	enabled: boolean;
	enabledFeatures: string[];
	availableFeatures: string[];
}

export interface SettingsSnapshot {
	settings: SettingDescriptor[];
	plugins: PluginDescriptor[];
}

export interface CompactionResult {
	summary: string;
	shortSummary?: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: unknown;
	preserveData?: Record<string, unknown>;
}

export interface BranchMessage {
	entryId: string;
	text: string;
}

export interface BranchResult {
	text: string;
	cancelled: boolean;
}

export interface HandoffResult {
	savedPath?: string;
}

export interface TodoPhase {
	name: string;
	tasks: { content: string; status: "pending" | "in_progress" | "completed" | "abandoned" }[];
}

export interface AvailableCommand {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint?: string };
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source: "builtin" | "skill" | "extension" | "custom" | "mcp_prompt" | "file";
}

export interface HostToolDefinition {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
	hidden?: boolean;
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

export interface HostToolResultFrame {
	type: "host_tool_result";
	id: string;
	result: unknown;
	isError?: boolean;
}

export interface HostToolUpdateFrame {
	type: "host_tool_update";
	id: string;
	partialResult: unknown;
}

export interface PromptResultFrame {
	type: "prompt_result";
	id?: string;
	agentInvoked: boolean;
}

export interface HostUriSchemeDefinition {
	scheme: string;
	description?: string;
	writable?: boolean;
	immutable?: boolean;
}

export interface HostUriRequest {
	type: "host_uri_request";
	id: string;
	operation: "read" | "write";
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
	isError?: boolean;
}

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
export const THINKING_LEVELS = ["off", "auto", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number] | "inherit";
export type ApprovalMode = "always-ask" | "write" | "yolo";

// ── Responses (engine -> frontend) ───────────────────────────────────────────

interface RpcResponseBase {
	type: "response";
	id?: string;
	command: string;
}
export interface RpcErrorPayload {
	code?: string;
	message: string;
	details?: unknown;
}
export type RpcResponse =
	| (RpcResponseBase & { success: true; data?: unknown })
	| (RpcResponseBase & { success: false; error: string | RpcErrorPayload });

/** Emitted once when the engine finished startup and is ready for commands. */
export interface ReadyFrame {
	type: "ready";
}

/** Subset of the engine `RpcSessionState` the desktop reads (see rpc-types.ts). */
export interface SessionState {
	model?: ModelInfo;
	thinkingLevel?: ThinkingLevel;
	approvalMode?: ApprovalMode;
	isStreaming: boolean;
	sessionId: string;
	sessionName?: string;
	messageCount: number;
	autoRetryEnabled?: boolean;
	autoCompactionEnabled?: boolean;
	isCompacting?: boolean;
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	interruptMode?: "immediate" | "wait";
	todoPhases?: TodoPhase[];
	/** Plan-mode snapshot when active (undefined = plan mode off). */
	planMode?: PlanModeState;
}

/** Plan-mode snapshot (mirrors engine `RpcPlanModeState`). */
export interface PlanModeState {
	enabled: boolean;
	planFilePath: string;
	workflow?: "parallel" | "iterative";
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

export interface GitStatus {
	branch: string | null;
	staged: number;
	unstaged: number;
	untracked: number;
}

export interface WorktreeInfo {
	path: string;
	branch: string | null;
	detached: boolean;
	head: string | null;
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
	sessionFile?: string;
}

export interface SubagentMessage {
	role: string;
	content?: unknown;
}

export interface SubagentMessagesResult {
	sessionFile: string;
	fromByte: number;
	nextByte: number;
	reset: boolean;
	entries: unknown[];
	messages: SubagentMessage[];
}

/** Frame types the RPC server emits for subagents (after set_subagent_subscription). */
export const SUBAGENT_FRAME_TYPES = ["subagent_lifecycle", "subagent_progress", "subagent_event"] as const;

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
	| { type: "extension_ui_request"; id: string; method: "open_url"; url: string; instructions?: string };

/** Methods that block waiting for an {@link ExtensionUIResponse}. */
export type ExtensionUIDialogMethod = "select" | "confirm" | "input" | "editor";

export type ExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };

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

// Runtime metadata/output frames emitted outside the request-response channel.
export interface CommandOutputFrame {
	type: "command_output";
	text: string;
}

export interface AvailableCommandsUpdateFrame {
	type: "available_commands_update";
	commands: AvailableCommand[];
}

export interface SessionInfoUpdateFrame {
	type: "session_info_update";
	title?: string;
	sessionId: string;
}

export interface ConfigUpdateFrame {
	type: "config_update";
	model?: ModelInfo;
	thinkingLevel?: ThinkingLevel;
}

export interface ExtensionErrorFrame {
	type: "extension_error";
	extensionPath?: string;
	event?: string;
	error: string;
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

export interface SessionRule {
	name: string;
	description?: string;
}

export interface SessionGoal {
	id: string;
	objective: string;
	status: "active" | "paused" | "budget-limited" | "complete" | "dropped";
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
}

export interface SessionCustomMessage {
	role: "custom";
	customType: string;
	content: string | ContentPart[];
	display: boolean;
	timestamp: number;
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
	| {
			type: "auto_compaction_start";
			reason: "threshold" | "overflow" | "idle" | "incomplete";
			action: "context-full" | "handoff" | "shake" | "snapcompact";
	  }
	| {
			type: "auto_compaction_end";
			action: "context-full" | "handoff" | "shake" | "snapcompact";
			result?: CompactionResult;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
			skipped?: boolean;
	  }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
			errorId?: number;
	  }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "retry_fallback_applied"; from: string; to: string; role: string }
	| { type: "retry_fallback_succeeded"; model: string; role: string }
	| { type: "ttsr_triggered"; rules: SessionRule[] }
	| { type: "todo_reminder"; todos: TodoPhase["tasks"]; attempt: number; maxAttempts: number }
	| { type: "todo_auto_clear" }
	| { type: "irc_message"; message: SessionCustomMessage }
	| { type: "notice"; message?: string; text?: string; level?: "info" | "warning" | "error" }
	| {
			type: "thinking_level_changed";
			thinkingLevel?: ThinkingLevel;
			configured?: ThinkingLevel;
			resolved?: ThinkingLevel;
	  }
	| { type: "goal_updated"; goal: SessionGoal | null }
	| { type: "plan_mode_changed"; planMode?: PlanModeState };
