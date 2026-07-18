/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */
import type { AgentMessage, AgentToolResult, ThinkingLevel, ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { Effort, ImageContent, Model, ToolExample } from "@oh-my-pi/pi-ai";
import type { BashResult } from "../../exec/bash-executor";
import type { ContextUsage } from "../../extensibility/extensions/types";
import type { Goal, GoalModeState } from "../../goals/state";
import type { AgentSessionEvent, ContextUsageBreakdown, SessionStats } from "../../session/agent-session";
import type { FileEntry } from "../../session/session-entries";
import type { SessionArtifactContent } from "../../session/session-manager";
import type { AvailableSlashCommandSource } from "../../slash-commands/available-commands";
import type {
	AgentProgress,
	SubagentEventPayload,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "../../task";
import type { ConfiguredThinkingLevel } from "../../thinking";
import type { ApprovalMode } from "../../tools/approval";
import type { TodoPhase } from "../../tools/todo";

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "abort_and_prompt"; message: string; images?: ImageContent[] }
	| { id?: string; type: "new_session"; parentSession?: string }
	| { id?: string; type: "set_workspace"; cwd: string }

	// State
	| { id?: string; type: "get_state" }
	| { id?: string; type: "get_settings" }
	| { id?: string; type: "set_setting"; path: string; value: unknown }
	| { id?: string; type: "set_plugin_enabled"; name: string; enabled: boolean }
	| { id?: string; type: "set_plugin_features"; name: string; features: string[] | null }
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
	| { id?: string; type: "set_todos"; phases: TodoPhase[] }
	| { id?: string; type: "set_host_tools"; tools: RpcHostToolDefinition[] }
	| { id?: string; type: "set_host_uri_schemes"; schemes: RpcHostUriSchemeDefinition[] }
	| { id?: string; type: "set_subagent_subscription"; level: RpcSubagentSubscriptionLevel }
	| { id?: string; type: "get_subagents" }
	| { id?: string; type: "get_subagent_messages"; subagentId?: string; sessionFile?: string; fromByte?: number }
	| { id?: string; type: "read_artifact"; artifactId: string; maxBytes?: number }
	| { id?: string; type: "get_goal" }
	| { id?: string; type: "create_goal"; objective: string; tokenBudget?: number }
	| { id?: string; type: "pause_goal" }
	| { id?: string; type: "resume_goal" }
	| { id?: string; type: "drop_goal" }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ConfiguredThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_interrupt_mode"; mode: "immediate" | "wait" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }
	| { id?: string; type: "set_approval_mode"; mode: ApprovalMode }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "get_workspace_diff" }
	| { id?: string; type: "list_workspace_files"; query?: string; limit?: number }
	| { id?: string; type: "read_workspace_file"; path: string; maxBytes?: number }
	| { id?: string; type: "get_context_snapshot" }
	| { id?: string; type: "reload_skills" }
	| { id?: string; type: "set_skill_enabled"; name: string; enabled: boolean }
	| { id?: string; type: "get_mcp_status" }
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
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "list_sessions" }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "branch"; entryId: string }
	| { id?: string; type: "get_branch_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }
	| { id?: string; type: "handoff"; customInstructions?: string }

	// Messages
	| { id?: string; type: "get_messages" }

	// Login
	| { id?: string; type: "get_login_providers" }
	| { id?: string; type: "login"; providerId: string }
	| { id?: string; type: "set_api_key"; providerId: string; apiKey: string }
	| { id?: string; type: "logout"; providerId: string }

	// Plan mode (desktop-added core command; core-touchpoints.md).
	// Approval is handled agent-driven: the agent writes the plan title to
	// `xd://propose`, which the plan proposal handler routes to the host dialog.
	| { id?: string; type: "set_plan_mode"; enabled: boolean; workflow?: "parallel" | "iterative" }

	// Staging (desktop-added core command; core-touchpoints.md). Non-destructive:
	// stage/unstage only touch the git index, never the working tree, so a mistaken
	// selection is fully reversible with the inverse command.
	| { id?: string; type: "stage_hunks"; selections: RpcHunkSelection[] }
	| { id?: string; type: "unstage"; files?: string[] };

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: Model;
	thinkingLevel: ThinkingLevel | undefined;
	/** User-selected thinking mode; differs from thinkingLevel when configured as auto. */
	configuredThinkingLevel: ConfiguredThinkingLevel | undefined;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	interruptMode: "immediate" | "wait";
	approvalMode: ApprovalMode;
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	autoRetryEnabled: boolean;
	messageCount: number;
	queuedMessageCount: number;
	todoPhases: TodoPhase[];
	/** For session dump / export (plain-text parity with /dump). */
	systemPrompt?: string[];
	dumpTools?: Array<{ name: string; description: string; parameters: unknown; examples?: readonly ToolExample[] }>;
	/** Current context window usage. */
	contextUsage?: ContextUsage;
	/** Authoritative category breakdown backing contextUsage. */
	contextBreakdown?: ContextUsageBreakdown;
	/** Plan-mode snapshot when active (undefined = plan mode off). Mirrors {@link RpcPlanModeState}. */
	planMode?: RpcPlanModeState;
	/** Goal-mode snapshot when a goal exists. */
	goalMode?: GoalModeState;
}

export interface RpcGoalResult {
	goal: Goal | null;
	state: GoalModeState | null;
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
}

export interface RpcSettingsSnapshot {
	settings: RpcSettingDescriptor[];
	plugins: RpcPluginDescriptor[];
}

export interface RpcMarketplacePluginDescriptor {
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
	installations: Array<{ scope: "user" | "project"; version: string; enabled: boolean; shadowed: boolean }>;
}

export interface RpcMarketplaceSnapshot {
	marketplaces: Array<{ name: string; sourceType: "github" | "git" | "url" | "local"; updatedAt: string }>;
	plugins: RpcMarketplacePluginDescriptor[];
}

/** Plan-mode snapshot exposed over RPC (subset of the engine's {@link PlanModeState}). */
export interface RpcPlanModeState {
	enabled: boolean;
	planFilePath: string;
	workflow?: "parallel" | "iterative";
}

/** Compact session descriptor for the `list_sessions` picker (subset of {@link SessionInfo}). */
export interface RpcSessionSummary {
	path: string;
	id: string;
	title?: string;
	messageCount: number;
	created: string;
	modified: string;
	/** True when this is the session currently loaded in the RPC process. */
	active: boolean;
}

/** One changed file in the workspace git diff (from `get_workspace_diff`). */
export interface RpcWorkspaceFileChange {
	/** Repo-relative path (post-rename path for renames). */
	path: string;
	status: "modified" | "added" | "deleted" | "renamed" | "untracked";
	/** Unified diff text for this file (may be empty for binary/oversized). */
	diff: string;
	additions: number;
	deletions: number;
	/** Pre-rename path when status === "renamed". */
	oldPath?: string;
	/** True when the diff was omitted (binary or too large); path/status still shown. */
	truncated?: boolean;
}

export interface RpcGitStatus {
	branch: string | null;
	staged: number;
	unstaged: number;
	untracked: number;
}

export interface RpcWorktree {
	path: string;
	branch: string | null;
	detached: boolean;
	head: string | null;
}

export interface RpcWorkspaceEntry {
	path: string;
	name: string;
	type: "file" | "directory";
	size: number | null;
	mtimeMs: number | null;
}

export interface RpcWorkspaceFileContent {
	path: string;
	content: string;
	size: number;
	truncated: boolean;
}

/**
 * Hunk selection for `stage_hunks` (mirrors the engine's {@link HunkSelection} in
 * utils/git.ts). `all` stages the whole file; `indices` stages specific hunks by
 * their 0-based position in the file's unified diff.
 */
export interface RpcHunkSelection {
	path: string;
	hunks: { type: "all" } | { type: "indices"; indices: number[] };
}

export interface RpcAvailableSlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint?: string };
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source: AvailableSlashCommandSource;
}

export interface RpcAvailableCommandsUpdateFrame {
	type: "available_commands_update";
	commands: RpcAvailableSlashCommand[];
}

/** Emitted whenever plan mode is toggled (set/clear) so the client updates
 *  without polling get_state. `planMode` is undefined when plan mode is off. */
export interface RpcPlanModeChangedFrame {
	type: "plan_mode_changed";
	planMode?: RpcPlanModeState;
}

export interface RpcPromptResultFrame {
	type: "prompt_result";
	id?: string;
	agentInvoked: boolean;
}

export interface RpcHandoffResult {
	savedPath?: string;
}

export type RpcSubagentSubscriptionLevel = "off" | "progress" | "events";

export interface RpcSubagentSnapshot {
	id: string;
	index: number;
	agent: string;
	agentSource: AgentProgress["agentSource"];
	description?: string;
	status: AgentProgress["status"];
	task?: string;
	assignment?: string;
	sessionFile?: string;
	lastUpdate: number;
	progress?: AgentProgress;
	parentToolCallId?: string;
}

export interface RpcSubagentMessagesResult {
	sessionFile: string;
	fromByte: number;
	nextByte: number;
	reset: boolean;
	entries: FileEntry[];
	messages: AgentMessage[];
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
export type RpcResponse =
	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true; data?: { agentInvoked: boolean } }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "abort_and_prompt"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "set_workspace"; success: true; data: { cwd: string } }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
	| { id?: string; type: "response"; command: "get_settings"; success: true; data: RpcSettingsSnapshot }
	| { id?: string; type: "response"; command: "set_setting"; success: true; data: RpcSettingDescriptor }
	| { id?: string; type: "response"; command: "set_plugin_enabled"; success: true; data: RpcPluginDescriptor }
	| { id?: string; type: "response"; command: "set_plugin_features"; success: true; data: RpcPluginDescriptor }
	| { id?: string; type: "response"; command: "install_plugin"; success: true; data: RpcPluginDescriptor }
	| { id?: string; type: "response"; command: "update_plugin"; success: true; data: RpcPluginDescriptor }
	| { id?: string; type: "response"; command: "uninstall_plugin"; success: true; data: { name: string } }
	| { id?: string; type: "response"; command: "get_marketplace"; success: true; data: RpcMarketplaceSnapshot }
	| { id?: string; type: "response"; command: "add_marketplace"; success: true; data: RpcMarketplaceSnapshot }
	| { id?: string; type: "response"; command: "update_marketplace"; success: true; data: RpcMarketplaceSnapshot }
	| { id?: string; type: "response"; command: "remove_marketplace"; success: true; data: RpcMarketplaceSnapshot }
	| {
			id?: string;
			type: "response";
			command: "install_marketplace_plugin";
			success: true;
			data: RpcMarketplaceSnapshot;
	  }
	| {
			id?: string;
			type: "response";
			command: "upgrade_marketplace_plugin";
			success: true;
			data: RpcMarketplaceSnapshot;
	  }
	| {
			id?: string;
			type: "response";
			command: "uninstall_marketplace_plugin";
			success: true;
			data: RpcMarketplaceSnapshot;
	  }
	| {
			id?: string;
			type: "response";
			command: "set_marketplace_plugin_enabled";
			success: true;
			data: RpcMarketplaceSnapshot;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_commands";
			success: true;
			data: { commands: RpcAvailableSlashCommand[] };
	  }
	| { id?: string; type: "response"; command: "set_todos"; success: true; data: { todoPhases: TodoPhase[] } }
	| { id?: string; type: "response"; command: "set_host_tools"; success: true; data: { toolNames: string[] } }
	| { id?: string; type: "response"; command: "set_host_uri_schemes"; success: true; data: { schemes: string[] } }
	| {
			id?: string;
			type: "response";
			command: "set_subagent_subscription";
			success: true;
			data: { level: RpcSubagentSubscriptionLevel };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_subagents";
			success: true;
			data: { subagents: RpcSubagentSnapshot[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_subagent_messages";
			success: true;
			data: RpcSubagentMessagesResult;
	  }
	| { id?: string; type: "response"; command: "read_artifact"; success: true; data: SessionArtifactContent }
	| { id?: string; type: "response"; command: "get_goal"; success: true; data: RpcGoalResult }
	| { id?: string; type: "response"; command: "create_goal"; success: true; data: RpcGoalResult }
	| { id?: string; type: "response"; command: "pause_goal"; success: true; data: RpcGoalResult }
	| { id?: string; type: "response"; command: "resume_goal"; success: true; data: RpcGoalResult }
	| { id?: string; type: "response"; command: "drop_goal"; success: true; data: RpcGoalResult }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model; thinkingLevel: ThinkingLevel | undefined; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model[] };
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: Effort } | null;
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }
	| { id?: string; type: "response"; command: "set_interrupt_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }
	| { id?: string; type: "response"; command: "set_approval_mode"; success: true; data: { mode: ApprovalMode } }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| {
			id?: string;
			type: "response";
			command: "get_workspace_diff";
			success: true;
			data: { files: RpcWorkspaceFileChange[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "list_workspace_files";
			success: true;
			data: { entries: RpcWorkspaceEntry[]; truncated: boolean };
	  }
	| { id?: string; type: "response"; command: "read_workspace_file"; success: true; data: RpcWorkspaceFileContent }
	| {
			id?: string;
			type: "response";
			command: "get_context_snapshot";
			success: true;
			data: {
				skills: string[];
				memoryBackend: string | null;
				skillDetails: Array<{
					name: string;
					description: string;
					filePath: string;
					source: string;
					hidden?: boolean;
				}>;
				skillWarnings: Array<{ skillPath: string; message: string }>;
			};
	  }
	| { id?: string; type: "response"; command: "reload_skills"; success: true; data: { skills: string[] } }
	| {
			id?: string;
			type: "response";
			command: "set_skill_enabled";
			success: true;
			data: { name: string; enabled: boolean; skills: string[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_mcp_status";
			success: true;
			data: {
				servers: Array<{
					name: string;
					enabled: boolean;
					status: "connected" | "connecting" | "disconnected";
					toolCount: number;
					transport: "stdio" | "http" | "sse" | "unknown";
					auth: {
						configured: boolean;
						oauth: boolean;
						credentialConfigured: boolean;
						credentialAvailable: boolean;
					};
					lastError?: string;
				}>;
			};
	  }
	| {
			id?: string;
			type: "response";
			command: "reconnect_mcp";
			success: true;
			data: { serverName: string; status: string; toolCount: number };
	  }
	| {
			id?: string;
			type: "response";
			command: "set_mcp_enabled";
			success: true;
			data: { serverName: string; enabled: boolean };
	  }
	| {
			id?: string;
			type: "response";
			command: "unauth_mcp";
			success: true;
			data: { serverName: string; removed: boolean; status: "disconnected" };
	  }
	| {
			id?: string;
			type: "response";
			command: "reauth_mcp";
			success: true;
			data: { serverName: string; status: string; toolCount: number };
	  }
	| { id?: string; type: "response"; command: "get_memory_status"; success: true; data: unknown }
	| { id?: string; type: "response"; command: "search_memory"; success: true; data: unknown }
	| { id?: string; type: "response"; command: "save_memory"; success: true; data: unknown }
	| { id?: string; type: "response"; command: "enqueue_memory"; success: true; data: unknown }
	| { id?: string; type: "response"; command: "clear_memory"; success: true; data: unknown }
	| {
			id?: string;
			type: "response";
			command: "browser_open";
			success: true;
			data: { name: string; url: string; text: string };
	  }
	| { id?: string; type: "response"; command: "browser_close"; success: true; data: { text: string } }
	| {
			id?: string;
			type: "response";
			command: "browser_snapshot";
			success: true;
			data: { name: string; url: string; snapshot: string };
	  }
	| {
			id?: string;
			type: "response";
			command: "browser_navigate";
			success: true;
			data: { name: string; url: string; text: string };
	  }
	| {
			id?: string;
			type: "response";
			command: "browser_history";
			success: true;
			data: { name: string; url: string; text: string };
	  }
	| {
			id?: string;
			type: "response";
			command: "browser_list_tabs";
			success: true;
			data: {
				tabs: Array<{
					name: string;
					url: string;
					title?: string;
					state: "alive" | "dead";
					backend: "worker" | "cmux";
				}>;
				downloadPolicy: "deny";
			};
	  }
	| { id?: string; type: "response"; command: "get_git_status"; success: true; data: RpcGitStatus }
	| { id?: string; type: "response"; command: "revert_files"; success: true; data: { files: string[] } }
	| { id?: string; type: "response"; command: "commit"; success: true; data: { stdout: string; stderr: string } }
	| {
			id?: string;
			type: "response";
			command: "push";
			success: true;
			data: { remote: string | null; refspec: string | null };
	  }
	| { id?: string; type: "response"; command: "create_pull_request"; success: true; data: { url: string } }
	| { id?: string; type: "response"; command: "list_worktrees"; success: true; data: { worktrees: RpcWorktree[] } }
	| { id?: string; type: "response"; command: "create_worktree"; success: true; data: RpcWorktree }
	| { id?: string; type: "response"; command: "remove_worktree"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "list_sessions"; success: true; data: { sessions: RpcSessionSummary[] } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "branch"; success: true; data: { text: string; cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_branch_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }
	| { id?: string; type: "response"; command: "handoff"; success: true; data: RpcHandoffResult | null }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }

	// Login
	| {
			id?: string;
			type: "response";
			command: "get_login_providers";
			success: true;
			data: {
				providers: Array<{
					id: string;
					name: string;
					available: boolean;
					authenticated: boolean;
					authKind?: "runtime" | "config" | "oauth" | "api_key" | "env" | "fallback";
					envVar?: string;
					supportsOAuth: boolean;
					supportsApiKey: boolean;
				}>;
			};
	  }
	| { id?: string; type: "response"; command: "login"; success: true; data: { providerId: string } }
	| { id?: string; type: "response"; command: "set_api_key"; success: true; data: { providerId: string } }
	| { id?: string; type: "response"; command: "logout"; success: true; data: { providerId: string } }

	// Plan mode
	| { id?: string; type: "response"; command: "set_plan_mode"; success: true; data: { planMode?: RpcPlanModeState } }

	// Staging (desktop-added core command; core-touchpoints.md)
	| { id?: string; type: "response"; command: "stage_hunks"; success: true; data: { staged: number } }
	| { id?: string; type: "response"; command: "unstage"; success: true }

	// Error response (any command can fail)
	| { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// Subagent Events (stdout)
// ============================================================================

export interface RpcSubagentLifecycleFrame {
	type: "subagent_lifecycle";
	payload: SubagentLifecyclePayload;
}

export interface RpcSubagentProgressFrame {
	type: "subagent_progress";
	payload: SubagentProgressPayload;
}

export interface RpcSubagentEventFrame {
	type: "subagent_event";
	payload: SubagentEventPayload;
}

export type RpcSubagentFrame = RpcSubagentLifecycleFrame | RpcSubagentProgressFrame | RpcSubagentEventFrame;

export type RpcSessionEventFrame = AgentSessionEvent | RpcSubagentFrame;

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
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
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "open_url";
			url: string;
			/**
			 * Short loopback URL that 302-redirects to {@link url}. When present,
			 * hosts SHOULD surface it as the copy target so terminal viewport
			 * truncation cannot corrupt OAuth query parameters on the full URL.
			 */
			launchUrl?: string;
			instructions?: string;
	  };

// ============================================================================
// Host Tool Frames (bidirectional)
// ============================================================================

export interface RpcHostToolDefinition {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
	hidden?: boolean;
	/** How this host tool is presented when enabled; omission normalizes to `"discoverable"` at the adapter boundary. */
	loadMode?: ToolLoadMode;
}

/** Emitted by the RPC server when it needs the host to execute a registered tool. */
export interface RpcHostToolCallRequest {
	type: "host_tool_call";
	id: string;
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
}

/** Emitted by the RPC server when a pending host tool call should be aborted. */
export interface RpcHostToolCancelRequest {
	type: "host_tool_cancel";
	id: string;
	targetId: string;
}

/** Sent by the host to stream partial tool updates back to the RPC server. */
export interface RpcHostToolUpdate {
	type: "host_tool_update";
	id: string;
	partialResult: AgentToolResult<unknown>;
}

/** Sent by the host to complete a pending tool call. */
export interface RpcHostToolResult {
	type: "host_tool_result";
	id: string;
	result: AgentToolResult<unknown>;
	isError?: boolean;
}

// ============================================================================
// Host URI Frames (bidirectional)
// ============================================================================

export interface RpcHostUriSchemeDefinition {
	/** URL scheme without trailing `://` (e.g. `db`, `notion`). */
	scheme: string;
	/** Optional human-readable description for logs/diagnostics. */
	description?: string;
	/** When true, the write tool is allowed to dispatch writes to this scheme. */
	writable?: boolean;
	/** When true, downstream callers suppress hashline anchors for resolved content. */
	immutable?: boolean;
}

export type RpcHostUriOperation = "read" | "write";

/** Emitted by the RPC server when it needs the host to satisfy a URI operation. */
export interface RpcHostUriRequest {
	type: "host_uri_request";
	id: string;
	operation: RpcHostUriOperation;
	url: string;
	/** Present for write operations. */
	content?: string;
}

/** Emitted by the RPC server when a pending URI request should be aborted. */
export interface RpcHostUriCancelRequest {
	type: "host_uri_cancel";
	id: string;
	targetId: string;
}

/** Sent by the host to complete a pending URI request. */
export interface RpcHostUriResult {
	type: "host_uri_result";
	id: string;
	/**
	 * Required for successful `read` results. Ignored for `write` success.
	 * Set on errors when a textual explanation accompanies `isError`.
	 */
	content?: string;
	/** Defaults to 	ext/plain` when omitted. */
	contentType?: "text/markdown" | "application/json" | "text/plain";
	/** Optional resolution notes propagated to the read tool. */
	notes?: string[];
	/** Overrides the scheme-level `immutable` flag for this single resolution. */
	immutable?: boolean;
	/** When true, surface the result content as an error to the caller. */
	isError?: boolean;
	/** Optional error message; preferred over `content` for error surfacing. */
	error?: string;
}

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];
