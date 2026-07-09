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
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[] }
	| { id?: string; type: "steer"; message: string }
	| { id?: string; type: "follow_up"; message: string }
	| { id?: string; type: "abort" }
	| { id?: string; type: "new_session"; parentSession?: string }
	| { id?: string; type: "get_state" }
	| { id?: string; type: "get_available_models" }
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "set_session_name"; name: string }
	| { id?: string; type: "get_subagents" }
	| { id?: string; type: "set_subagent_subscription"; level: "off" | "progress" | "events" }
	| { id?: string; type: "list_sessions" }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "get_workspace_diff" }
	| { id?: string; type: "get_login_providers" }
	| { id?: string; type: "login"; providerId: string }
	| { id?: string; type: "set_api_key"; providerId: string; apiKey: string }
	| { id?: string; type: "logout"; providerId: string };

/**
 * Session thinking levels accepted by `set_thinking_level`
 * (mirrors ThinkingLevel in packages/agent/src/thinking.ts; "inherit" omitted —
 * it's for nested/agent defaults, not a user-facing session choice).
 */
export const THINKING_LEVELS = ["off", "auto", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number] | "inherit";

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
	isStreaming: boolean;
	sessionId: string;
	sessionName?: string;
	messageCount: number;
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
	| { type: "notice"; message?: string; text?: string; level?: "info" | "warning" | "error" };
