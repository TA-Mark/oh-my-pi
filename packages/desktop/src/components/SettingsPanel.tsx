import {
	Bot,
	Brain,
	Bug,
	Check,
	ChevronDown,
	ChevronRight,
	Cloud,
	Database,
	EyeOff,
	HardDrive,
	KeyRound,
	LogOut,
	Plug,
	PlugZap,
	Plus,
	RefreshCw,
	RotateCcw,
	Search,
	Settings2,
	ShieldCheck,
	Sparkles,
	Volume2,
	Wrench,
	X,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
	ContextSnapshot,
	DesktopHostToolConfig,
	HostToolAction,
	LoginProvider,
	MarketplacePluginDescriptor,
	MarketplaceSnapshot,
	McpCapabilitySnapshot,
	McpServerConfigInput,
	McpServerStatus,
	MemorySearchResult,
	MemoryStatus,
	ModelInfo,
	RpcPluginDescriptor,
	RpcPluginSettingDescriptor,
	RpcSettingCategory,
	RpcSettingDescriptor,
	RpcSettingsSnapshot,
} from "../lib/rpc-protocol";

const HOST_ACTIONS: Array<{
	action: HostToolAction;
	label: string;
	defaultName: string;
	description: string;
	argument: string;
}> = [
	{
		action: "open_external_url",
		label: "Open external URL",
		defaultName: "desktop_open_url",
		description: "Open a credential-free http(s) or mailto URL in the system browser",
		argument: "url",
	},
	{
		action: "reveal_path",
		label: "Reveal path",
		defaultName: "desktop_reveal_path",
		description: "Reveal a file or directory in the system file manager",
		argument: "path",
	},
	{
		action: "copy_text",
		label: "Copy text",
		defaultName: "desktop_copy_text",
		description: "Copy text to the system clipboard",
		argument: "text",
	},
	{
		action: "read_workspace_file",
		label: "Read workspace file",
		defaultName: "desktop_read_workspace_file",
		description: "Read a bounded text file inside the active workspace",
		argument: "path",
	},
];

const CATEGORIES: Array<{
	id: RpcSettingCategory;
	label: string;
	description: string;
	section: "Core" | "Agent behavior" | "Integrations" | "Advanced";
	icon: typeof Settings2;
}> = [
	{
		id: "providers",
		label: "Models & providers",
		description: "Choose how OMP connects to model providers.",
		section: "Core",
		icon: Bot,
	},
	{
		id: "retry",
		label: "Retry",
		description: "Control recovery from temporary model failures.",
		section: "Agent behavior",
		icon: RotateCcw,
	},
	{
		id: "compaction",
		label: "Context compaction",
		description: "Manage how long conversations fit the model context.",
		section: "Agent behavior",
		icon: Brain,
	},
	{
		id: "memory",
		label: "Memory",
		description: "Review and manage durable agent memory.",
		section: "Agent behavior",
		icon: Database,
	},
	{
		id: "mcp",
		label: "MCP servers",
		description: "Manage external tools and authentication.",
		section: "Integrations",
		icon: Plug,
	},
	{
		id: "plugins",
		label: "Plugins",
		description: "Install and configure OMP extensions.",
		section: "Integrations",
		icon: Sparkles,
	},
	{
		id: "skills",
		label: "Skills",
		description: "Control reusable agent workflows.",
		section: "Integrations",
		icon: ShieldCheck,
	},
	{
		id: "tools",
		label: "Advanced",
		description: "Runtime controls and desktop host capabilities.",
		section: "Advanced",
		icon: Wrench,
	},
];

const PROVIDER_ADVANCED_SECTIONS: Array<{
	id: "privacy" | "tools" | "local" | "voice" | "performance" | "specific";
	label: string;
	description: string;
	guidance: string;
	icon: typeof Settings2;
	includes: (path: string) => boolean;
}> = [
	{
		id: "privacy",
		label: "Privacy & availability",
		description: "Protect sensitive text and hide providers you never want OMP to use.",
		guidance: "Change these only when your workspace has privacy rules or a provider must be completely unavailable.",
		icon: ShieldCheck,
		includes: path => path === "secrets.enabled" || path === "disabledProviders",
	},
	{
		id: "tools",
		label: "Tools & media",
		description: "Choose the services used for web research, images, and page fetching.",
		guidance: "Auto is recommended. Pick a service only when you need its specific quality, pricing, or credentials.",
		icon: Sparkles,
		includes: path =>
			[
				"providers.webSearch",
				"providers.webSearchExclude",
				"providers.webSearchGeminiModel",
				"providers.image",
				"providers.fetch",
			].includes(path),
	},
	{
		id: "local",
		label: "Local helper models",
		description: "Control small background models used for memory, reasoning selection, and recovery.",
		guidance: "Keep Online unless you specifically want on-device processing and have enough memory and compute.",
		icon: Brain,
		includes: path =>
			path.startsWith("providers.tinyModel") ||
			["providers.memoryModel", "providers.autoThinkingModel", "providers.unexpectedStopModel"].includes(path),
	},
	{
		id: "voice",
		label: "Voice & speech",
		description: "Choose text-to-speech services, voices, and when OMP should speak.",
		guidance: "These options have no effect until speech output is enabled.",
		icon: Volume2,
		includes: path => path === "providers.tts" || path.startsWith("tts.") || path.startsWith("speech."),
	},
	{
		id: "performance",
		label: "Performance & reliability",
		description: "Limit parallel requests and control how long OMP waits for provider responses.",
		guidance: "Defaults suit most users. Adjust only to address rate limits, account quotas, or stalled connections.",
		icon: RotateCcw,
		includes: path =>
			path === "providers.maxInFlightRequests" ||
			path === "providers.ollama-cloud.maxConcurrency" ||
			path.startsWith("providers.stream"),
	},
	{
		id: "specific",
		label: "Provider-specific behavior",
		description: "Compatibility and routing controls for individual provider implementations.",
		guidance: "Leave these at their defaults unless provider documentation or an error message tells you otherwise.",
		icon: Wrench,
		includes: () => true,
	},
];

const PROVIDER_FRIENDLY_COPY: Record<string, { label: string; description: string }> = {
	disabledProviders: {
		label: "Providers OMP must never use",
		description:
			"Enter provider IDs separated by commas. Their models and sign-in options will be hidden everywhere in OMP.",
	},
	"secrets.enabled": {
		label: "Mask secrets before model requests",
		description: "Detect and replace likely credentials before workspace content is sent to an AI provider.",
	},
	"providers.maxInFlightRequests": {
		label: "Parallel request limits by provider",
		description:
			'Prevents OMP processes from exceeding account limits. Example: { "openai": 3 }. Leave empty for no OMP limit.',
	},
	"providers.ollama-cloud.maxConcurrency": {
		label: "Parallel Ollama Cloud tasks",
		description: "Maximum Ollama Cloud subagents this app may run together. Use 0 for no provider-specific limit.",
	},
	"providers.webSearch": {
		label: "Web research service",
		description: "Auto tries the best available search service and falls back when one is unavailable.",
	},
	"providers.webSearchExclude": {
		label: "Search services to avoid",
		description: "Enter search provider IDs separated by commas. OMP will not use them, including as fallbacks.",
	},
	"providers.memoryModel": {
		label: "Model that organizes memory",
		description:
			"Extracts and consolidates durable facts in the background. Online is the recommended balance of quality and setup.",
	},
	"providers.autoThinkingModel": {
		label: "Model that selects reasoning effort",
		description: "Estimates task difficulty when reasoning is set to Auto. Online is recommended for most users.",
	},
	"providers.streamFirstEventTimeoutSeconds": {
		label: "Wait for a response to begin",
		description:
			"Seconds before treating a provider as stalled when no response has started. -1 uses the built-in default.",
	},
	"providers.streamIdleTimeoutSeconds": {
		label: "Wait between response updates",
		description: "Seconds before treating an active response as stalled. -1 uses the built-in default.",
	},
};

const RETRY_FRIENDLY_COPY: Record<string, { label: string; description: string }> = {
	"retry.maxRetries": {
		label: "Maximum recovery attempts",
		description: "How many times OMP may retry a temporary API failure before it stops or switches models.",
	},
	"retry.modelFallback": {
		label: "Use a fallback model",
		description: "Switch to a configured backup model when the current provider cannot recover.",
	},
	"retry.baseDelayMs": {
		label: "Initial wait before retrying",
		description: "The first pause after a temporary failure. Later attempts wait progressively longer.",
	},
	"retry.maxDelayMs": {
		label: "Longest acceptable wait",
		description: "Fail instead of leaving a task waiting longer than this value. Enter milliseconds.",
	},
	"retry.fallbackChains": {
		label: "Custom fallback routes",
		description: "Expert mapping of a model or role to an ordered list of backup models.",
	},
	"retry.fallbackRevertPolicy": {
		label: "Return to the primary model",
		description: "Choose whether OMP returns to the original model after its cooldown expires.",
	},
};

const COMPACTION_FRIENDLY_COPY: Record<string, { label: string; description: string }> = {
	"compaction.strategy": {
		label: "How to preserve the conversation",
		description: "Choose how OMP makes room while retaining the information needed to continue the task.",
	},
	"compaction.autoContinue": {
		label: "Continue the task automatically",
		description: "Resume the agent after context maintenance finishes instead of waiting for a new message.",
	},
	"compaction.midTurnEnabled": {
		label: "Recover during a long response",
		description: "Allow maintenance during a turn when a long-running task fills the context unexpectedly.",
	},
	"compaction.thresholdPercent": {
		label: "Start maintenance at",
		description:
			"Percentage of the model context that may be used before OMP creates more room. Default is recommended.",
	},
	"compaction.thresholdTokens": {
		label: "Fixed token trigger",
		description:
			"Optional fixed limit that overrides the percentage trigger. Keep Default unless you know the model window size.",
	},
	"compaction.keepRecentTokens": {
		label: "Recent context to keep intact",
		description: "Approximate number of the newest tokens preserved verbatim during maintenance.",
	},
	"compaction.reserveTokens": {
		label: "Space reserved for the next response",
		description: "Tokens kept free so the model has room to finish its next turn. Empty uses the adaptive default.",
	},
	"compaction.v2RetainedMessageBudget": {
		label: "Remote retained-message budget",
		description:
			"Maximum recent-message tokens retained by compatible remote compaction. The default suits most models.",
	},
	"compaction.remoteEnabled": {
		label: "Use provider-native maintenance",
		description: "Let compatible providers compact their own context; otherwise OMP summarizes locally.",
	},
	"compaction.remoteStreamingV2Enabled": {
		label: "Use modern streaming compaction",
		description: "Use the newer Responses compaction protocol when the selected provider supports it.",
	},
	"compaction.remoteEndpoint": {
		label: "Custom compaction endpoint",
		description:
			"Optional expert override for a compatible remote endpoint. Leave empty to use the provider default.",
	},
	"compaction.idleEnabled": {
		label: "Prepare context while idle",
		description: "Run maintenance in the background after the task has been idle, reducing interruptions later.",
	},
	"compaction.idleThresholdTokens": {
		label: "Idle maintenance trigger",
		description: "Only prepare context in the background when the conversation is larger than this token count.",
	},
	"compaction.idleTimeoutSeconds": {
		label: "Time before a task is idle",
		description: "How long OMP waits without activity before background maintenance may begin.",
	},
	"compaction.supersedeReads": {
		label: "Discard outdated file reads",
		description: "Prefer newer reads of the same file and remove obsolete copies from maintained context.",
	},
	"compaction.dropUseless": {
		label: "Remove uneventful tool results",
		description:
			"Drop successful results that add little future value, while preserving errors and meaningful changes.",
	},
	"compaction.handoffSaveToDisk": {
		label: "Save handoff notes to disk",
		description: "When using the Handoff strategy, keep the generated continuation document as a Markdown file.",
	},
};

const MEMORY_BACKENDS: Array<{
	id: MemoryStatus["backend"];
	label: string;
	description: string;
	detail: string;
	storage: string;
	privacy: string;
	setup: string;
	remembers: boolean;
	semanticRecall: boolean;
	requiresNewTask: boolean;
	icon: typeof Database;
}> = [
	{
		id: "off",
		label: "Off",
		description: "No persistent memory",
		detail: "OMP only uses the current conversation.",
		storage: "Nothing is written to durable memory.",
		privacy: "Conversation context only",
		setup: "No setup required",
		remembers: false,
		semanticRecall: false,
		requiresNewTask: false,
		icon: X,
	},
	{
		id: "local",
		label: "Local summaries",
		description: "Simple, private, file-based",
		detail: "Stores durable notes locally; no semantic search.",
		storage: "Summary files on this device",
		privacy: "Local only",
		setup: "Ready without extra services",
		remembers: true,
		semanticRecall: false,
		requiresNewTask: false,
		icon: HardDrive,
	},
	{
		id: "mnemopi",
		label: "Mnemopi",
		description: "Local structured memory",
		detail: "SQLite recall with optional embeddings and knowledge links.",
		storage: "Structured SQLite databases on this device",
		privacy: "Local by default",
		setup: "Works with built-in defaults; embeddings are optional",
		remembers: true,
		semanticRecall: true,
		requiresNewTask: true,
		icon: Database,
	},
	{
		id: "hindsight",
		label: "Hindsight",
		description: "Remote semantic memory",
		detail: "Connects to a Hindsight cloud or self-hosted service.",
		storage: "A Hindsight cloud or self-hosted server",
		privacy: "Data is sent to the configured server",
		setup: "Requires a server URL; private servers may require HINDSIGHT_API_TOKEN",
		remembers: true,
		semanticRecall: true,
		requiresNewTask: true,
		icon: Cloud,
	},
];

const MEMORY_FRIENDLY_COPY: Record<string, { label: string; description: string }> = {
	"autolearn.enabled": {
		label: "Suggest lessons after a task",
		description: "Prompt the agent to capture useful lessons and improve isolated managed skills when work stops.",
	},
	"autolearn.autoContinue": {
		label: "Capture lessons automatically",
		description: "Run one extra capture turn when work stops. This uses additional model tokens.",
	},
	"autolearn.minToolCalls": {
		label: "Minimum task activity",
		description: "Only suggest learning after a task has used at least this many tools.",
	},
	"mnemopi.scoping": {
		label: "Who can see a memory",
		description: "Keep memories isolated per project, share them globally, or combine project and shared recall.",
	},
	"mnemopi.embeddingVariant": {
		label: "Language coverage",
		description: "Choose English for stronger English recall or Multilingual for memories across languages.",
	},
	"mnemopi.autoRecall": {
		label: "Recall when a task starts",
		description: "Automatically add relevant local memories to the first turn of each session.",
	},
	"mnemopi.autoRetain": {
		label: "Remember completed work",
		description: "Automatically retain completed conversation turns in local structured memory.",
	},
	"mnemopi.polyphonicRecall": {
		label: "Use multi-signal recall",
		description:
			"Combine semantic, graph, factual, and temporal recall for richer results at higher processing cost.",
	},
	"mnemopi.enhancedRecall": {
		label: "Cache similar recalls",
		description: "Speed up repeated or similar memory searches using a tiered local cache.",
	},
	"mnemopi.proactiveLinking": {
		label: "Link related memories",
		description: "Connect new memories to related entities and past events as they are stored.",
	},
	"hindsight.apiUrl": {
		label: "Hindsight server",
		description: "URL of your Hindsight cloud or self-hosted service.",
	},
	"hindsight.scoping": {
		label: "Who can see a memory",
		description: "Choose whether projects use isolated, shared, or project-tagged memory banks.",
	},
	"hindsight.autoRecall": {
		label: "Recall when a task starts",
		description: "Automatically fetch relevant remote memories for the first turn of each session.",
	},
	"hindsight.autoRetain": {
		label: "Remember conversation history",
		description: "Automatically retain transcript updates and session boundaries in Hindsight.",
	},
	"hindsight.retainMode": {
		label: "How conversations are stored",
		description: "Store one evolving session document or smaller chunks divided by turn boundaries.",
	},
	"hindsight.recallBudget": {
		label: "Recall depth",
		description: "Balance memory-search quality, response time, and remote processing cost.",
	},
	"hindsight.mentalModelsEnabled": {
		label: "Use curated project knowledge",
		description: "Load Hindsight mental models such as conventions, decisions, and preferences at startup.",
	},
	"hindsight.mentalModelAutoSeed": {
		label: "Create starter knowledge models",
		description: "Create missing built-in project, decision, and preference models automatically.",
	},
};

const MCP_FRIENDLY_COPY: Record<string, { label: string; description: string }> = {
	"mcp.enableProjectConfig": {
		label: "Discover servers from this project",
		description:
			"Load MCP definitions from project-owned configuration, including .omp/mcp.json and compatible MCP files.",
	},
	"mcp.notifications": {
		label: "Forward subscribed resource updates",
		description:
			"When a connected server reports a subscribed resource change, inject that update into the active conversation.",
	},
	"mcp.notificationDebounceMs": {
		label: "Wait before forwarding updates",
		description: "Combine rapid resource notifications for this many milliseconds before adding them to the task.",
	},
};

const MCP_ENV_VALUE_EXAMPLE = "API_TOKEN=$" + "{MCP_TOKEN}";
const MCP_HEADER_VALUE_EXAMPLE = "Authorization=Bearer $" + "{MCP_TOKEN}";

export interface SettingsOperationFeedback {
	key: string;
	state: "saving" | "saved" | "error";
	message?: string;
}

interface PendingConfirmation {
	title: string;
	message: string;
	confirmLabel: string;
	onConfirm: () => void;
}

export interface SettingsPanelProps {
	open: boolean;
	snapshot: RpcSettingsSnapshot | null;
	loading: boolean;
	error: string | null;
	savingKeys: readonly string[];
	operationFeedbacks: readonly SettingsOperationFeedback[];
	initialCategory?: RpcSettingCategory;
	mcpServers: McpServerStatus[];
	mcpCapabilities: McpCapabilitySnapshot | null;
	memoryStatus: MemoryStatus | null;
	memorySearch: MemorySearchResult | null;
	marketplace: MarketplaceSnapshot | null;
	marketplaceError: string | null;
	skillDetails: ContextSnapshot["skillDetails"];
	skillWarnings: ContextSnapshot["skillWarnings"];
	hostTools: DesktopHostToolConfig[];
	workspaceUriEnabled: boolean;
	models: ModelInfo[];
	loginProviders: LoginProvider[];
	activeModel?: Pick<ModelInfo, "provider" | "id">;
	onRefresh: () => void;
	onOpenDiagnostics: () => void;
	onSaveSetting: (path: string, value: unknown) => void;
	onSelectModel: (provider: string, id: string) => void;
	onLogin: (providerId: string) => void;
	onSetApiKey: (providerId: string, apiKey: string) => void;
	onLogout: (providerId: string) => void;
	onSetPluginEnabled: (name: string, enabled: boolean) => void;
	onSetPluginFeatures: (name: string, features: string[]) => void;
	onSetPluginSetting: (name: string, key: string, value: unknown) => void;
	onDeletePluginSetting: (name: string, key: string) => void;
	onInstallPlugin: (spec: string) => void;
	onUpdatePlugin: (name: string) => void;
	onUninstallPlugin: (name: string) => void;
	onRefreshMarketplace: () => void;
	onAddMarketplace: (source: string) => void;
	onUpdateMarketplace: (name: string) => void;
	onRemoveMarketplace: (name: string) => void;
	onInstallMarketplacePlugin: (name: string, marketplace: string, scope: "user" | "project") => void;
	onUpgradeMarketplacePlugin: (pluginId: string, scope: "user" | "project") => void;
	onUninstallMarketplacePlugin: (pluginId: string, scope: "user" | "project") => void;
	onSetMarketplacePluginEnabled: (pluginId: string, enabled: boolean, scope: "user" | "project") => void;
	onRefreshMcp: () => void;
	onAddMcpServer: (name: string, scope: "user" | "project", config: McpServerConfigInput) => void;
	onRemoveMcpServer: (name: string, scope: "user" | "project") => void;
	onTestMcpServer: (name: string) => void;
	onReloadMcp: () => void;
	onReconnectMcp: (name: string) => void;
	onSetMcpEnabled: (name: string, enabled: boolean) => void;
	onUnauthMcp: (name: string) => void;
	onReauthMcp: (name: string) => void;
	onRefreshMemory: () => void;
	onSearchMemory: (query: string) => void;
	onSaveMemory: (content: string) => Promise<boolean>;
	onEnqueueMemory: () => void;
	onClearMemory: () => void;
	onAddMemoryContext: (item: MemorySearchResult["items"][number]) => void;
	onStartNewTask: () => void;
	onReloadSkills: () => void;
	onSetSkillEnabled: (name: string, enabled: boolean) => void;
	onHostToolsChange: (tools: DesktopHostToolConfig[]) => void;
	onWorkspaceUriEnabledChange: (enabled: boolean) => void;
	onClose: () => void;
}

function providerInitials(name: string): string {
	const initials = name
		.replace(/\([^)]*\)/g, "")
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map(part => part[0]?.toUpperCase() ?? "")
		.join("");
	return initials || "AI";
}

function parseMcpKeyValueLines(value: string): Record<string, string> {
	const entries: Array<[string, string]> = [];
	for (const rawLine of value.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const separator = line.indexOf("=");
		if (separator <= 0) throw new Error(`Expected KEY=value, received: ${line}`);
		entries.push([line.slice(0, separator).trim(), line.slice(separator + 1).trim()]);
	}
	return Object.fromEntries(entries);
}

function providerAuthLabel(provider: LoginProvider): string {
	switch (provider.authKind) {
		case "oauth":
			return "OAuth";
		case "api_key":
			return "API key";
		case "env":
			return provider.envVar ? `Environment · ${provider.envVar}` : "Environment variable";
		case "config":
			return "OMP configuration";
		case "runtime":
			return "Runtime credentials";
		case "fallback":
			return "Fallback credentials";
		default:
			return provider.supportsOAuth ? "OAuth" : provider.supportsApiKey ? "API key" : "Provider credentials";
	}
}

function SettingEditor({
	setting,
	disabled,
	onSave,
}: {
	setting: RpcSettingDescriptor;
	disabled: boolean;
	onSave: (value: unknown) => void;
}) {
	const serialized =
		setting.type === "array"
			? Array.isArray(setting.value)
				? setting.value.filter((item): item is string => typeof item === "string").join(", ")
				: ""
			: setting.type === "record"
				? JSON.stringify(setting.value ?? {}, null, 2)
				: String(setting.value ?? "");
	const [draft, setDraft] = useState(serialized);
	const [validationError, setValidationError] = useState<string | null>(null);
	const [recordKeyDraft, setRecordKeyDraft] = useState("");
	const [recordValueDraft, setRecordValueDraft] = useState("3");
	const dirty = draft !== serialized;
	useEffect(() => {
		setDraft(serialized);
		setValidationError(null);
	}, [serialized]);
	const saveScalar = () => {
		if (!dirty) return;
		if (setting.type === "number") {
			if (!draft.trim()) {
				onSave(null);
				return;
			}
			const value = Number(draft);
			if (!Number.isFinite(value)) {
				setValidationError("Enter a finite number.");
				return;
			}
			onSave(value);
			return;
		}
		onSave(draft || null);
	};
	if (setting.type === "boolean")
		return (
			<input
				type="checkbox"
				aria-label={setting.label}
				checked={setting.value === true}
				disabled={disabled}
				onChange={event => onSave(event.currentTarget.checked)}
			/>
		);
	if (setting.type === "enum")
		return (
			<select
				className="settings-select"
				aria-label={setting.label}
				value={draft}
				disabled={disabled}
				onChange={event => onSave(event.currentTarget.value)}
			>
				{setting.options?.map(option => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		);
	if (setting.type === "number" && setting.options?.length)
		return (
			<select
				className="settings-select"
				aria-label={setting.label}
				value={setting.value === -1 ? "default" : String(setting.value ?? "")}
				disabled={disabled}
				onChange={event => onSave(event.currentTarget.value === "default" ? -1 : Number(event.currentTarget.value))}
			>
				{setting.options.map(option => (
					<option key={option.value} value={option.value} title={option.description}>
						{option.label}
					</option>
				))}
			</select>
		);
	if (setting.type === "array")
		return (
			<div className="settings-scalar-editor">
				<div className="settings-control">
					<input
						className="settings-input"
						aria-label={setting.label}
						value={draft}
						disabled={disabled}
						placeholder="provider-one, provider-two"
						onChange={event => setDraft(event.currentTarget.value)}
						onKeyDown={event => {
							if (event.key === "Enter" && dirty) {
								onSave(
									draft
										.split(/[\n,]/)
										.map(value => value.trim())
										.filter(Boolean),
								);
							}
							if (event.key === "Escape") {
								event.preventDefault();
								event.stopPropagation();
								setDraft(serialized);
							}
						}}
					/>
					<button
						type="button"
						disabled={disabled || !dirty}
						onClick={() =>
							onSave(
								draft
									.split(/[\n,]/)
									.map(value => value.trim())
									.filter(Boolean),
							)
						}
					>
						Apply
					</button>
				</div>
				{dirty ? <span className="settings-unsaved">Separate multiple values with commas</span> : null}
			</div>
		);
	if (setting.type === "record" && setting.path === "providers.maxInFlightRequests") {
		const rawRecord = JSON.parse(draft) as Record<string, unknown>;
		const entries = Object.entries(rawRecord).filter(
			(entry): entry is [string, number] => typeof entry[1] === "number",
		);
		const parsed = Object.fromEntries(entries) as Record<string, number>;
		const updateRecord = (next: Record<string, number>) => setDraft(JSON.stringify(next, null, 2));
		return (
			<div className="settings-record-editor">
				{entries.length === 0 ? (
					<span className="settings-record-empty">No OMP limit is set. Provider account limits still apply.</span>
				) : (
					<div className="settings-record-entries">
						{entries.map(([providerId, limit]) => (
							<div className="settings-record-entry" key={providerId}>
								<code>{providerId}</code>
								<input
									type="number"
									min="1"
									aria-label={`Parallel request limit for ${providerId}`}
									value={limit}
									disabled={disabled}
									onChange={event => {
										const value = Number(event.currentTarget.value);
										if (Number.isFinite(value) && value > 0) updateRecord({ ...parsed, [providerId]: value });
									}}
								/>
								<button
									type="button"
									aria-label={`Remove request limit for ${providerId}`}
									disabled={disabled}
									onClick={() => {
										const next = { ...parsed };
										delete next[providerId];
										updateRecord(next);
									}}
								>
									<X size={13} />
								</button>
							</div>
						))}
					</div>
				)}
				<div className="settings-record-add">
					<input
						className="settings-input"
						aria-label="Provider ID for request limit"
						value={recordKeyDraft}
						disabled={disabled}
						placeholder="Provider ID, e.g. openai"
						onChange={event => setRecordKeyDraft(event.currentTarget.value)}
					/>
					<input
						type="number"
						min="1"
						aria-label="New parallel request limit"
						value={recordValueDraft}
						disabled={disabled}
						onChange={event => setRecordValueDraft(event.currentTarget.value)}
					/>
					<button
						type="button"
						disabled={
							disabled ||
							!recordKeyDraft.trim() ||
							!Number.isFinite(Number(recordValueDraft)) ||
							Number(recordValueDraft) <= 0
						}
						onClick={() => {
							updateRecord({ ...parsed, [recordKeyDraft.trim()]: Number(recordValueDraft) });
							setRecordKeyDraft("");
						}}
					>
						Add limit
					</button>
				</div>
				<div className="settings-record-actions">
					<span>{dirty ? "Changes have not been applied" : "Limits are shared across local OMP processes"}</span>
					<button type="button" disabled={disabled || !dirty} onClick={() => onSave(parsed)}>
						Apply limits
					</button>
				</div>
			</div>
		);
	}
	if (setting.type === "record")
		return (
			<div className="settings-structured">
				<textarea
					aria-label={`${setting.label} JSON`}
					value={draft}
					disabled={disabled}
					onChange={event => {
						setDraft(event.currentTarget.value);
						setValidationError(null);
					}}
					onKeyDown={event => {
						if (event.key === "Escape" && dirty) {
							event.preventDefault();
							event.stopPropagation();
							setDraft(serialized);
							setValidationError(null);
						}
					}}
				/>
				<button
					type="button"
					disabled={disabled || draft === serialized}
					onClick={() => {
						try {
							onSave(JSON.parse(draft));
						} catch (error) {
							setValidationError(error instanceof Error ? error.message : "Invalid JSON");
						}
					}}
				>
					Save JSON
				</button>
				{validationError ? <span className="settings-validation-error">{validationError}</span> : null}
			</div>
		);
	return (
		<div className="settings-scalar-editor">
			<div className="settings-control">
				<input
					className="settings-input"
					aria-label={setting.label}
					type={setting.type === "number" ? "number" : "text"}
					value={draft}
					disabled={disabled}
					onChange={event => {
						setDraft(event.currentTarget.value);
						setValidationError(null);
					}}
					onKeyDown={event => {
						if (event.key === "Enter") saveScalar();
						if (event.key === "Escape") {
							event.preventDefault();
							event.stopPropagation();
							setDraft(serialized);
							setValidationError(null);
						}
					}}
				/>
				<button type="button" disabled={disabled || !dirty} onClick={saveScalar}>
					Apply
				</button>
			</div>
			{validationError ? (
				<span className="settings-validation-error" role="alert">
					{validationError}
				</span>
			) : dirty ? (
				<span className="settings-unsaved">Not applied yet</span>
			) : null}
		</div>
	);
}

function SettingRow({
	setting,
	savingKey,
	feedback,
	showTechnicalDetails,
	onSave,
}: {
	setting: RpcSettingDescriptor;
	savingKey: string | null;
	feedback: SettingsOperationFeedback | null;
	showTechnicalDetails: boolean;
	onSave: (value: unknown) => void;
}) {
	const isSaving = savingKey === setting.path;
	const rowFeedback = feedback?.key === setting.path ? feedback : null;
	return (
		<div className={`settings-config-row${isSaving ? " settings-config-row--busy" : ""}`}>
			<div className="settings-config-copy">
				<div className="settings-setting-title">
					<strong>{setting.label}</strong>
					{setting.activation === "next_engine_restart" ? (
						<span className="settings-badge">Restart required</span>
					) : null}
				</div>
				<span>{setting.description}</span>
				{showTechnicalDetails ? <code>{setting.path}</code> : null}
				{rowFeedback ? (
					<span
						className={`settings-row-feedback settings-row-feedback--${rowFeedback.state}`}
						role={rowFeedback.state === "error" ? "alert" : "status"}
					>
						{rowFeedback.state === "saving"
							? (rowFeedback.message ?? "Saving…")
							: rowFeedback.state === "saved"
								? (rowFeedback.message ?? "Saved")
								: (rowFeedback.message ?? "Could not save this setting.")}
					</span>
				) : null}
			</div>
			<div className="settings-control">
				<SettingEditor setting={setting} disabled={isSaving} onSave={onSave} />
			</div>
		</div>
	);
}

function PluginSettingControl({
	pluginName,
	setting,
	busy,
	onSave,
	onReset,
}: {
	pluginName: string;
	setting: RpcPluginSettingDescriptor;
	busy: boolean;
	onSave: (value: unknown) => void;
	onReset: () => void;
}) {
	const label = `${pluginName} ${setting.key}`;
	const commitText = (value: string) => {
		if (setting.secret && value.length === 0) return;
		onSave(value);
	};
	return (
		<div className="plugin-setting-row">
			<div>
				<strong>{setting.key}</strong>
				<span>{setting.description ?? "Plugin-defined setting"}</span>
				{setting.env ? (
					<small className={setting.environmentAvailable ? "is-available" : ""}>
						{setting.environmentAvailable
							? `${setting.env} is available`
							: `Environment fallback: ${setting.env}`}
					</small>
				) : null}
			</div>
			<div className="plugin-setting-control">
				{setting.type === "boolean" ? (
					<input
						type="checkbox"
						aria-label={label}
						checked={setting.value === true}
						disabled={busy}
						onChange={event => onSave(event.currentTarget.checked)}
					/>
				) : setting.type === "enum" ? (
					<select
						className="settings-select"
						aria-label={label}
						value={typeof setting.value === "string" ? setting.value : ""}
						disabled={busy}
						onChange={event => onSave(event.currentTarget.value)}
					>
						{setting.value === null ? <option value="">Choose…</option> : null}
						{setting.values?.map(value => (
							<option key={value} value={value}>
								{value}
							</option>
						))}
					</select>
				) : (
					<input
						key={`${pluginName}:${setting.key}:${String(setting.value)}`}
						className="settings-input"
						type={setting.secret ? "password" : setting.type === "number" ? "number" : "text"}
						aria-label={label}
						defaultValue={
							setting.secret
								? ""
								: typeof setting.value === "string" || typeof setting.value === "number"
									? setting.value
									: ""
						}
						placeholder={setting.secret && setting.configured ? "Saved securely · enter to replace" : undefined}
						min={setting.min}
						max={setting.max}
						step={setting.step}
						disabled={busy}
						onBlur={event => {
							if (setting.type === "number") {
								const value = Number(event.currentTarget.value);
								if (Number.isFinite(value)) onSave(value);
							} else {
								commitText(event.currentTarget.value);
							}
						}}
						onKeyDown={event => {
							if (event.key === "Enter") event.currentTarget.blur();
						}}
					/>
				)}
				{setting.configured ? (
					<button type="button" disabled={busy} onClick={onReset}>
						Reset
					</button>
				) : null}
			</div>
		</div>
	);
}

function PluginRow({
	plugin,
	busy,
	onEnabled,
	onFeatures,
	onSetting,
	onResetSetting,
	onUpdate,
	onUninstall,
}: {
	plugin: RpcPluginDescriptor;
	busy: boolean;
	onEnabled: (enabled: boolean) => void;
	onFeatures: (features: string[]) => void;
	onSetting: (key: string, value: unknown) => void;
	onResetSetting: (key: string) => void;
	onUpdate: () => void;
	onUninstall: () => void;
}) {
	return (
		<article className={`plugin-runtime-card${plugin.enabled ? " is-enabled" : ""}`}>
			<div className="plugin-card-header">
				<span className="plugin-card-icon">
					<Sparkles size={16} />
				</span>
				<div className="plugin-card-copy">
					<div>
						<strong>{plugin.name}</strong>
						<span>v{plugin.version}</span>
						<span className={plugin.enabled ? "is-enabled" : ""}>{plugin.enabled ? "Active" : "Disabled"}</span>
					</div>
					<p>{plugin.description ?? "OMP plugin"}</p>
				</div>
				<div className="plugin-card-actions">
					<label>
						<input
							type="checkbox"
							aria-label={`Enable ${plugin.name}`}
							checked={plugin.enabled}
							disabled={busy}
							onChange={event => onEnabled(event.currentTarget.checked)}
						/>
						Enabled
					</label>
					<button type="button" disabled={busy} onClick={onUpdate}>
						Update
					</button>
					<button type="button" className="settings-danger-button" disabled={busy} onClick={onUninstall}>
						Uninstall
					</button>
				</div>
			</div>
			{plugin.availableFeatures.length > 0 ? (
				<div className="plugin-card-section">
					<strong>Optional features</strong>
					{plugin.availableFeatures.length > 0 ? (
						<div className="plugin-feature-list">
							{plugin.availableFeatures.map(feature => (
								<label key={feature}>
									<input
										type="checkbox"
										checked={plugin.enabledFeatures.includes(feature)}
										disabled={busy || !plugin.enabled}
										onChange={event => {
											const selected = event.currentTarget.checked
												? [...plugin.enabledFeatures, feature]
												: plugin.enabledFeatures.filter(name => name !== feature);
											onFeatures([...new Set(selected)]);
										}}
									/>
									{feature}
								</label>
							))}
						</div>
					) : null}
				</div>
			) : null}
			{plugin.settings.length > 0 ? (
				<div className="plugin-card-section">
					<strong>Plugin settings</strong>
					<div className="plugin-setting-list">
						{plugin.settings.map(setting => (
							<PluginSettingControl
								key={setting.key}
								pluginName={plugin.name}
								setting={setting}
								busy={busy}
								onSave={value => onSetting(setting.key, value)}
								onReset={() => onResetSetting(setting.key)}
							/>
						))}
					</div>
				</div>
			) : null}
		</article>
	);
}

function MarketplacePluginRow({
	plugin,
	busy,
	onInstall,
	onUpgrade,
	onUninstall,
	onEnabled,
}: {
	plugin: MarketplacePluginDescriptor;
	busy: boolean;
	onInstall: (scope: "user" | "project") => void;
	onUpgrade: (scope: "user" | "project") => void;
	onUninstall: (scope: "user" | "project") => void;
	onEnabled: (scope: "user" | "project", enabled: boolean) => void;
}) {
	return (
		<article className={`marketplace-plugin-card${plugin.installations.length > 0 ? " is-installed" : ""}`}>
			<div className="marketplace-plugin-main">
				<span className="plugin-card-icon">
					<Cloud size={16} />
				</span>
				<div className="plugin-card-copy">
					<div>
						<strong>{plugin.name}</strong>
						{plugin.version ? <span>v{plugin.version}</span> : null}
						<span>{plugin.marketplace}</span>
					</div>
					<p>{plugin.description ?? `Plugin from ${plugin.marketplace}`}</p>
					{plugin.capabilities.length > 0 ? (
						<div className="marketplace-plugin-capabilities">
							<strong>Provides</strong>
							{plugin.capabilities.map(capability => (
								<span key={capability}>{capability.toUpperCase()}</span>
							))}
						</div>
					) : null}
					{plugin.tags?.length ? (
						<div className="marketplace-plugin-tags">
							{plugin.tags.slice(0, 5).map(tag => (
								<span key={tag}>{tag}</span>
							))}
						</div>
					) : null}
					<small>
						{[plugin.author, plugin.category, plugin.license].filter(Boolean).join(" · ") || "OMP plugin catalog"}
					</small>
				</div>
			</div>
			<div className="marketplace-installations">
				{plugin.installations.length === 0 ? (
					<div className="marketplace-install-choice">
						<button
							type="button"
							className="settings-primary-button"
							disabled={busy}
							onClick={() => onInstall("project")}
						>
							Install for this project
						</button>
						<button type="button" disabled={busy} onClick={() => onInstall("user")}>
							Install for all projects
						</button>
					</div>
				) : (
					plugin.installations.map(installation => (
						<div className="marketplace-installation" key={installation.scope}>
							<label>
								<input
									type="checkbox"
									checked={installation.enabled}
									disabled={busy || installation.shadowed}
									onChange={event => onEnabled(installation.scope, event.currentTarget.checked)}
								/>
								{installation.scope} · v{installation.version}
								{installation.shadowed ? " · shadowed" : ""}
							</label>
							<div className="settings-control">
								<button type="button" disabled={busy} onClick={() => onUpgrade(installation.scope)}>
									Update
								</button>
								<button type="button" disabled={busy} onClick={() => onUninstall(installation.scope)}>
									Uninstall
								</button>
							</div>
						</div>
					))
				)}
			</div>
		</article>
	);
}

export function SettingsPanel(props: SettingsPanelProps) {
	const [category, setCategory] = useState<RpcSettingCategory>(props.initialCategory ?? "providers");
	const [query, setQuery] = useState("");
	const [showTechnicalDetails, setShowTechnicalDetails] = useState(false);
	const [showProviderAdvanced, setShowProviderAdvanced] = useState(false);
	const [openProviderSection, setOpenProviderSection] = useState<string | null>(null);
	const [showRetryAdvanced, setShowRetryAdvanced] = useState(false);
	const [showCompactionAdvanced, setShowCompactionAdvanced] = useState(false);
	const [openCompactionSection, setOpenCompactionSection] = useState<string | null>(null);
	const [showMemoryAdvanced, setShowMemoryAdvanced] = useState(false);
	const [openMemorySection, setOpenMemorySection] = useState<string | null>(null);
	const [showMcpBehavior, setShowMcpBehavior] = useState(false);
	const [openMcpServer, setOpenMcpServer] = useState<string | null>(null);
	const didAutoOpenMcpRef = useRef(false);
	const [showMcpAdd, setShowMcpAdd] = useState(false);
	const [mcpDraftName, setMcpDraftName] = useState("");
	const [mcpDraftScope, setMcpDraftScope] = useState<"user" | "project">("project");
	const [mcpDraftTransport, setMcpDraftTransport] = useState<"stdio" | "http" | "sse">("stdio");
	const [mcpDraftEndpoint, setMcpDraftEndpoint] = useState("");
	const [mcpDraftArgs, setMcpDraftArgs] = useState("");
	const [mcpDraftValues, setMcpDraftValues] = useState("");
	const [mcpDraftTimeout, setMcpDraftTimeout] = useState("");
	const [mcpDraftError, setMcpDraftError] = useState<string | null>(null);
	const [apiKeyProviderId, setApiKeyProviderId] = useState<string | null>(null);
	const [apiKeyDraft, setApiKeyDraft] = useState("");
	const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
	const confirmationRef = useRef<PendingConfirmation | null>(null);
	const confirmationTriggerRef = useRef<HTMLElement | null>(null);
	const confirmationWasOpenRef = useRef(false);
	const [pluginSpec, setPluginSpec] = useState("");
	const [marketplaceSource, setMarketplaceSource] = useState("");
	const [pluginPane, setPluginPane] = useState<"installed" | "discover" | "sources">("installed");
	const [openSkillName, setOpenSkillName] = useState<string | null>(null);
	const [memoryQuery, setMemoryQuery] = useState("");
	const [memoryDraft, setMemoryDraft] = useState("");
	const [previewMemoryBackend, setPreviewMemoryBackend] = useState<MemoryStatus["backend"] | null>(null);
	const [hostAction, setHostAction] = useState<HostToolAction>("open_external_url");
	const selectedHostAction = HOST_ACTIONS.find(item => item.action === hostAction) ?? HOST_ACTIONS[0];
	const [hostToolName, setHostToolName] = useState(selectedHostAction.defaultName);
	const panelRef = useRef<HTMLElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const previousFocusRef = useRef<HTMLElement | null>(null);
	const onCloseRef = useRef(props.onClose);
	const titleId = useId();
	const descriptionId = useId();
	const selectedCategory = CATEGORIES.find(item => item.id === category) ?? CATEGORIES[0];
	const isSaving = (key: string) => props.savingKeys.includes(key);
	const isSavingPrefix = (prefix: string) => props.savingKeys.some(key => key.startsWith(prefix));
	const hostBusy = isSavingPrefix("desktop:");
	const latestFeedback = props.operationFeedbacks.at(-1) ?? null;
	confirmationRef.current = confirmation;
	onCloseRef.current = props.onClose;
	useEffect(() => {
		if (confirmationWasOpenRef.current && !confirmation) {
			const frame = window.requestAnimationFrame(() => confirmationTriggerRef.current?.focus());
			confirmationWasOpenRef.current = false;
			return () => window.cancelAnimationFrame(frame);
		}
		confirmationWasOpenRef.current = confirmation !== null;
	}, [confirmation]);
	useEffect(() => {
		if (props.open && props.initialCategory) setCategory(props.initialCategory);
	}, [props.open, props.initialCategory]);
	useEffect(() => {
		if (!props.open) return;
		previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				if (confirmationRef.current) {
					setConfirmation(null);
					return;
				}
				onCloseRef.current();
				return;
			}
			if (event.key !== "Tab" || !panelRef.current) return;
			const focusRoot = confirmationRef.current
				? panelRef.current.querySelector<HTMLElement>(".settings-confirm-dialog")
				: panelRef.current;
			if (!focusRoot) return;
			const focusable = Array.from(
				focusRoot.querySelectorAll<HTMLElement>(
					'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
				),
			).filter(element => element.offsetParent !== null);
			if (focusable.length === 0) {
				event.preventDefault();
				focusRoot.focus();
				return;
			}
			const first = focusable[0];
			const last = focusable.at(-1) ?? first;
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.cancelAnimationFrame(frame);
			window.removeEventListener("keydown", onKeyDown);
			document.body.style.overflow = previousOverflow;
			previousFocusRef.current?.focus();
		};
	}, [props.open]);
	useEffect(() => {
		if (props.open) props.onRefresh();
	}, [props.open, props.onRefresh]);
	useEffect(() => {
		if (props.open && category === "mcp") props.onRefreshMcp();
	}, [props.open, category, props.onRefreshMcp]);
	useEffect(() => {
		if (!props.open || category !== "mcp" || didAutoOpenMcpRef.current || props.mcpServers.length === 0) return;
		didAutoOpenMcpRef.current = true;
		const attentionServer = props.mcpServers.find(server => server.enabled && server.status === "disconnected");
		setOpenMcpServer((attentionServer ?? props.mcpServers[0]).name);
	}, [category, props.mcpServers, props.open]);
	useEffect(() => {
		if (props.open && category === "memory") props.onRefreshMemory();
	}, [
		props.open,
		category,
		props.onRefreshMemory,
		props.snapshot?.settings.find(setting => setting.path === "memory.backend")?.value,
	]);
	useEffect(() => {
		if (!props.open || category !== "memory") return;
		const configured = props.snapshot?.settings.find(setting => setting.path === "memory.backend")?.value;
		if (configured === "off" || configured === "local" || configured === "mnemopi" || configured === "hindsight") {
			setPreviewMemoryBackend(current => current ?? configured);
		}
	}, [category, props.open, props.snapshot]);
	useEffect(() => {
		if (props.open && category === "plugins") props.onRefreshMarketplace();
	}, [props.open, category, props.onRefreshMarketplace]);
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const categorySearchText = useMemo(() => {
		const text = new Map<RpcSettingCategory, string>();
		for (const item of CATEGORIES) text.set(item.id, `${item.label} ${item.description}`.toLocaleLowerCase());
		for (const setting of props.snapshot?.settings ?? []) {
			text.set(
				setting.category,
				`${text.get(setting.category) ?? ""} ${setting.label} ${setting.description} ${setting.path} ${setting.group ?? ""}`.toLocaleLowerCase(),
			);
		}
		text.set(
			"plugins",
			`${text.get("plugins") ?? ""} ${(props.snapshot?.plugins ?? []).map(plugin => `${plugin.name} ${plugin.description ?? ""}`).join(" ")} ${(props.marketplace?.plugins ?? []).map(plugin => `${plugin.name} ${plugin.description ?? ""} ${plugin.tags?.join(" ") ?? ""}`).join(" ")}`.toLocaleLowerCase(),
		);
		text.set(
			"mcp",
			`${text.get("mcp") ?? ""} ${props.mcpServers.map(server => server.name).join(" ")}`.toLocaleLowerCase(),
		);
		text.set(
			"skills",
			`${text.get("skills") ?? ""} ${props.skillDetails.map(skill => `${skill.name} ${skill.description}`).join(" ")}`.toLocaleLowerCase(),
		);
		return text;
	}, [props.marketplace, props.mcpServers, props.skillDetails, props.snapshot]);
	const visibleCategories = useMemo(
		() =>
			CATEGORIES.filter(item =>
				item.section === "Advanced" && !showTechnicalDetails && !normalizedQuery
					? item.id === category
					: !normalizedQuery || categorySearchText.get(item.id)?.includes(normalizedQuery),
			),
		[category, categorySearchText, normalizedQuery, showTechnicalDetails],
	);
	useEffect(() => {
		if (!normalizedQuery || visibleCategories.some(item => item.id === category)) return;
		const first = visibleCategories[0];
		if (first) setCategory(first.id);
	}, [category, normalizedQuery, visibleCategories]);
	const settings = useMemo(
		() =>
			(props.snapshot?.settings ?? []).filter(
				setting =>
					setting.category === category &&
					(!normalizedQuery ||
						`${setting.label} ${setting.description} ${setting.path} ${setting.group ?? ""}`
							.toLocaleLowerCase()
							.includes(normalizedQuery)),
			),
		[props.snapshot, category, normalizedQuery],
	);
	const ignoredSkills = useMemo(() => {
		const value = props.snapshot?.settings.find(setting => setting.path === "skills.ignoredSkills")?.value;
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	}, [props.snapshot]);
	const groupedSettings = useMemo(() => {
		const groups = new Map<string, RpcSettingDescriptor[]>();
		for (const setting of settings) {
			const name = setting.group?.trim() || "General";
			groups.set(name, [...(groups.get(name) ?? []), setting]);
		}
		return [...groups.entries()];
	}, [settings]);
	const providerAdvancedSections = useMemo(
		() =>
			PROVIDER_ADVANCED_SECTIONS.map(section => ({
				...section,
				settings: settings.filter(setting => {
					const matched = PROVIDER_ADVANCED_SECTIONS.find(
						candidate => candidate.id !== "specific" && candidate.includes(setting.path),
					);
					return (matched?.id ?? "specific") === section.id;
				}),
			})).filter(section => section.settings.length > 0),
		[settings],
	);
	const providerModelCounts = useMemo(() => {
		const counts = new Map<string, number>();
		for (const model of props.models) counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
		return counts;
	}, [props.models]);
	const modelsByProvider = useMemo(() => {
		const groups = new Map<string, ModelInfo[]>();
		for (const model of props.models) groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
		return [...groups.entries()];
	}, [props.models]);
	const visibleLoginProviders = useMemo(
		() =>
			props.loginProviders.filter(provider => {
				if (!normalizedQuery) return true;
				return `${provider.name} ${provider.id} ${provider.authKind ?? ""} ${provider.envVar ?? ""}`
					.toLocaleLowerCase()
					.includes(normalizedQuery);
			}),
		[normalizedQuery, props.loginProviders],
	);
	const matchesQuery = (...values: Array<string | undefined>) =>
		!normalizedQuery || values.join(" ").toLocaleLowerCase().includes(normalizedQuery);
	const renderSettingRows = () =>
		groupedSettings.map(([group, groupSettings]) => (
			<section className="settings-setting-group" key={group} aria-label={group}>
				{groupedSettings.length > 1 || group !== "General" ? <h3>{group}</h3> : null}
				{groupSettings.map(setting => (
					<SettingRow
						key={setting.path}
						setting={setting}
						savingKey={isSaving(setting.path) ? setting.path : null}
						feedback={props.operationFeedbacks.find(feedback => feedback.key === setting.path) ?? null}
						showTechnicalDetails={showTechnicalDetails}
						onSave={value => props.onSaveSetting(setting.path, value)}
					/>
				))}
			</section>
		));
	const renderProviderSettingRows = (providerSettings: RpcSettingDescriptor[]) =>
		providerSettings.map(setting => {
			const copy = PROVIDER_FRIENDLY_COPY[setting.path];
			const displaySetting = copy ? { ...setting, ...copy } : setting;
			return (
				<SettingRow
					key={setting.path}
					setting={displaySetting}
					savingKey={isSaving(setting.path) ? setting.path : null}
					feedback={props.operationFeedbacks.find(feedback => feedback.key === setting.path) ?? null}
					showTechnicalDetails={showTechnicalDetails}
					onSave={value => props.onSaveSetting(setting.path, value)}
				/>
			);
		});
	const connectedProviderCount = props.loginProviders.filter(provider => provider.authenticated).length;
	const selectedModelValue = props.activeModel
		? JSON.stringify([props.activeModel.provider, props.activeModel.id])
		: "";
	const submitApiKey = (providerId: string) => {
		const value = apiKeyDraft.trim();
		if (!value) return;
		props.onSetApiKey(providerId, value);
		setApiKeyDraft("");
		setApiKeyProviderId(null);
	};
	const renderProviderDashboard = () => (
		<div className="provider-settings">
			<section className="provider-overview" aria-label="Provider overview">
				<div className="provider-overview-copy">
					<span className={`provider-overview-icon${connectedProviderCount > 0 ? " is-ready" : ""}`}>
						{connectedProviderCount > 0 ? <Check size={19} /> : <PlugZap size={19} />}
					</span>
					<div>
						<strong>{connectedProviderCount > 0 ? "Ready to use" : "Connect your first provider"}</strong>
						<span>
							{connectedProviderCount > 0
								? `${connectedProviderCount} connected provider${connectedProviderCount === 1 ? "" : "s"} · ${props.models.length} available model${props.models.length === 1 ? "" : "s"}`
								: "Sign in or add an API key below, then choose the model OMP should use."}
						</span>
					</div>
				</div>
				<div className="provider-model-select">
					<label htmlFor={`${titleId}-active-model`}>Active model</label>
					<select
						id={`${titleId}-active-model`}
						className="settings-select"
						value={selectedModelValue}
						disabled={props.models.length === 0}
						onChange={event => {
							const value = JSON.parse(event.currentTarget.value);
							if (Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "string") {
								props.onSelectModel(value[0], value[1]);
							}
						}}
					>
						{props.activeModel ? null : <option value="">Choose a model</option>}
						{props.models.length === 0 ? <option value="">Connect a provider first</option> : null}
						{modelsByProvider.map(([providerId, models]) => (
							<optgroup
								key={providerId}
								label={props.loginProviders.find(provider => provider.id === providerId)?.name ?? providerId}
							>
								{models.map(model => (
									<option
										key={`${model.provider}/${model.id}`}
										value={JSON.stringify([model.provider, model.id])}
									>
										{model.id}
									</option>
								))}
							</optgroup>
						))}
					</select>
					<span>
						{props.activeModel ? `${props.activeModel.provider}/${props.activeModel.id}` : "No model selected"}
					</span>
				</div>
			</section>

			<section className="provider-connections" aria-labelledby={`${titleId}-provider-connections`}>
				<div className="provider-section-title">
					<div>
						<h3 id={`${titleId}-provider-connections`}>Provider connections</h3>
						<p>Credentials are stored securely by OMP and never shown again.</p>
					</div>
					<span>
						{connectedProviderCount}/{props.loginProviders.length} connected
					</span>
				</div>
				<div className="provider-card-grid">
					{visibleLoginProviders.map(provider => {
						const modelCount = providerModelCounts.get(provider.id) ?? 0;
						const enteringApiKey = apiKeyProviderId === provider.id;
						return (
							<article
								className={`provider-card${provider.authenticated ? " provider-card--connected" : ""}`}
								key={provider.id}
							>
								<div className="provider-card-main">
									<span className="provider-card-logo" aria-hidden="true">
										{providerInitials(provider.name)}
									</span>
									<div className="provider-card-copy">
										<strong>{provider.name}</strong>
										<span>
											{modelCount > 0 ? `${modelCount} model${modelCount === 1 ? "" : "s"} · ` : ""}
											{providerAuthLabel(provider)}
										</span>
									</div>
									<span
										className={`provider-status provider-status--${provider.authenticated ? "connected" : provider.available ? "setup" : "unavailable"}`}
									>
										{provider.authenticated
											? "Connected"
											: provider.available
												? "Not connected"
												: "Unavailable"}
									</span>
								</div>
								<div className="provider-card-actions">
									{provider.supportsOAuth ? (
										<button
											type="button"
											disabled={!provider.available}
											onClick={() => props.onLogin(provider.id)}
										>
											<PlugZap size={14} /> {provider.authenticated ? "Reconnect" : "Sign in"}
										</button>
									) : null}
									{provider.supportsApiKey ? (
										<button
											type="button"
											disabled={!provider.available}
											onClick={() => {
												setApiKeyProviderId(enteringApiKey ? null : provider.id);
												setApiKeyDraft("");
											}}
										>
											<KeyRound size={14} /> {provider.authenticated ? "Replace key" : "Use API key"}
										</button>
									) : null}
									{provider.authenticated ? (
										<button
											className="provider-signout"
											type="button"
											onClick={() => props.onLogout(provider.id)}
										>
											<LogOut size={14} /> Sign out
										</button>
									) : null}
								</div>
								{enteringApiKey ? (
									<div className="provider-api-key-form">
										<label htmlFor={`${titleId}-api-key-${provider.id}`}>API key for {provider.name}</label>
										<div>
											<input
												id={`${titleId}-api-key-${provider.id}`}
												type="password"
												className="settings-input"
												value={apiKeyDraft}
												placeholder="Paste API key"
												autoFocus
												onChange={event => setApiKeyDraft(event.currentTarget.value)}
												onKeyDown={event => {
													if (event.key === "Enter") submitApiKey(provider.id);
													if (event.key === "Escape") {
														event.stopPropagation();
														setApiKeyProviderId(null);
														setApiKeyDraft("");
													}
												}}
											/>
											<button
												type="button"
												disabled={!apiKeyDraft.trim()}
												onClick={() => submitApiKey(provider.id)}
											>
												Save key
											</button>
										</div>
										<span>Environment variables take precedence when configured.</span>
									</div>
								) : null}
							</article>
						);
					})}
				</div>
				{props.loginProviders.length === 0 ? (
					<div className="provider-empty">
						<PlugZap size={22} />
						<strong>Provider catalog is unavailable</strong>
						<span>Refresh settings after the engine finishes starting.</span>
					</div>
				) : visibleLoginProviders.length === 0 ? (
					<div className="settings-empty">No providers match “{query.trim()}”.</div>
				) : null}
			</section>

			<section className="provider-advanced">
				<button
					type="button"
					className="provider-advanced-toggle"
					aria-expanded={showProviderAdvanced || Boolean(normalizedQuery)}
					onClick={() => setShowProviderAdvanced(value => !value)}
				>
					<span>
						<strong>Advanced provider behavior</strong>
						<small>Optional controls, organized by what they change</small>
					</span>
					{showProviderAdvanced || normalizedQuery ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
				</button>
				{showProviderAdvanced || normalizedQuery ? (
					<div className="provider-advanced-content">
						<div className="provider-advanced-guide">
							<ShieldCheck size={17} />
							<div>
								<strong>The defaults are recommended</strong>
								<span>
									You only need these controls for a specific privacy rule, tool preference, local model,
									account limit, or provider error.
								</span>
							</div>
						</div>
						<div className="provider-advanced-sections">
							{providerAdvancedSections.map(section => {
								const SectionIcon = section.icon;
								const expanded = Boolean(normalizedQuery) || openProviderSection === section.id;
								const configuredCount = section.settings.filter(setting => setting.configured).length;
								return (
									<section className="provider-advanced-section" key={section.id}>
										<button
											type="button"
											aria-expanded={expanded}
											aria-controls={`${titleId}-provider-section-${section.id}`}
											onClick={() =>
												setOpenProviderSection(current => (current === section.id ? null : section.id))
											}
										>
											<span className="provider-advanced-section-icon">
												<SectionIcon size={16} />
											</span>
											<span className="provider-advanced-section-copy">
												<strong>{section.label}</strong>
												<small>{section.description}</small>
											</span>
											<span className={`provider-advanced-state${configuredCount ? " is-custom" : ""}`}>
												{configuredCount ? `${configuredCount} customized` : "Using defaults"}
											</span>
											{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
										</button>
										{expanded ? (
											<div id={`${titleId}-provider-section-${section.id}`}>
												<p className="provider-advanced-guidance">{section.guidance}</p>
												{renderProviderSettingRows(section.settings)}
											</div>
										) : null}
									</section>
								);
							})}
						</div>
					</div>
				) : null}
			</section>
		</div>
	);
	const settingByPath = (path: string) => settings.find(setting => setting.path === path);
	const renderFriendlySettings = (paths: string[], copy: Record<string, { label: string; description: string }>) =>
		paths.flatMap(path => {
			const setting = settingByPath(path);
			if (!setting) return [];
			return [
				<SettingRow
					key={setting.path}
					setting={{ ...setting, ...copy[setting.path] }}
					savingKey={isSaving(setting.path) ? setting.path : null}
					feedback={props.operationFeedbacks.find(feedback => feedback.key === setting.path) ?? null}
					showTechnicalDetails={showTechnicalDetails}
					onSave={value => props.onSaveSetting(setting.path, value)}
				/>,
			];
		});
	const renderFeatureSwitch = (setting: RpcSettingDescriptor | undefined, label: string) => (
		<button
			type="button"
			className={`settings-feature-switch${setting?.value === true ? " is-on" : ""}`}
			role="switch"
			aria-checked={setting?.value === true}
			disabled={!setting || isSaving(setting.path)}
			onClick={() => setting && props.onSaveSetting(setting.path, setting.value !== true)}
		>
			<span aria-hidden="true" />
			{label}
		</button>
	);
	const renderRetryDashboard = () => {
		const enabled = settingByPath("retry.enabled");
		const maxRetries = settingByPath("retry.maxRetries")?.value;
		const baseDelay = settingByPath("retry.baseDelayMs")?.value;
		const fallback = settingByPath("retry.modelFallback")?.value === true;
		return (
			<div className="settings-feature-page">
				<section className={`settings-feature-hero${enabled?.value === true ? " is-enabled" : ""}`}>
					<div className="settings-feature-hero-copy">
						<span className="settings-feature-hero-icon">
							<RotateCcw size={20} />
						</span>
						<div>
							<strong>
								{enabled?.value === true ? "Automatic recovery is on" : "Automatic recovery is off"}
							</strong>
							<p>OMP can recover from temporary API errors and rate limits without losing the current task.</p>
						</div>
					</div>
					{renderFeatureSwitch(enabled, enabled?.value === true ? "Enabled" : "Disabled")}
				</section>
				<section className="settings-feature-flow" aria-label="Retry recovery flow">
					<div>
						<span>1</span>
						<strong>Temporary failure</strong>
						<small>Only recoverable provider errors trigger this flow.</small>
					</div>
					<ChevronRight size={16} />
					<div>
						<span>2</span>
						<strong>Wait and retry</strong>
						<small>
							Starts after {typeof baseDelay === "number" ? `${baseDelay / 1000}s` : "the default delay"} and
							increases gradually.
						</small>
					</div>
					<ChevronRight size={16} />
					<div>
						<span>3</span>
						<strong>{fallback ? "Use backup model" : "Stop after retries"}</strong>
						<small>
							{typeof maxRetries === "number"
								? `Up to ${maxRetries} recovery attempts.`
								: "Uses the configured retry budget."}
						</small>
					</div>
				</section>
				<section className="settings-feature-card">
					<div className="settings-feature-card-head">
						<div>
							<h3>Recovery behavior</h3>
							<p>The two choices most users may want to adjust.</p>
						</div>
						<span>Recommended defaults</span>
					</div>
					{renderFriendlySettings(["retry.maxRetries", "retry.modelFallback"], RETRY_FRIENDLY_COPY)}
				</section>
				<section className="settings-feature-advanced">
					<button
						type="button"
						aria-expanded={showRetryAdvanced}
						onClick={() => setShowRetryAdvanced(value => !value)}
					>
						<span>
							<strong>Fine-tune recovery</strong>
							<small>Timing and custom model-routing controls for unusual provider limits</small>
						</span>
						{showRetryAdvanced ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
					</button>
					{showRetryAdvanced ? (
						<div className="settings-feature-advanced-content">
							<p>
								Keep these defaults unless retries feel too aggressive, too slow, or require a specific backup
								route.
							</p>
							{renderFriendlySettings(
								["retry.baseDelayMs", "retry.maxDelayMs", "retry.fallbackRevertPolicy", "retry.fallbackChains"],
								RETRY_FRIENDLY_COPY,
							)}
						</div>
					) : null}
				</section>
			</div>
		);
	};
	const renderCompactionDashboard = () => {
		const enabled = settingByPath("compaction.enabled");
		const strategy = settingByPath("compaction.strategy");
		const strategyLabel =
			strategy?.options?.find(option => option.value === strategy.value)?.label ??
			String(strategy?.value ?? "Default");
		const advancedGroups = [
			{
				id: "preservation",
				label: "What OMP preserves",
				description: "Recent context, response space, and low-value tool results.",
				paths: [
					"compaction.keepRecentTokens",
					"compaction.reserveTokens",
					"compaction.v2RetainedMessageBudget",
					"compaction.supersedeReads",
					"compaction.dropUseless",
				],
			},
			{
				id: "remote",
				label: "Provider-native maintenance",
				description: "Remote compaction protocols and endpoint overrides.",
				paths: ["compaction.remoteEnabled", "compaction.remoteStreamingV2Enabled", "compaction.remoteEndpoint"],
			},
			{
				id: "idle",
				label: "Background preparation",
				description: "Prepare large conversations while the task is idle.",
				paths: ["compaction.idleEnabled", "compaction.idleThresholdTokens", "compaction.idleTimeoutSeconds"],
			},
			{
				id: "handoff",
				label: "Handoff files",
				description: "Optional artifacts created by the Handoff strategy.",
				paths: ["compaction.handoffSaveToDisk"],
			},
		];
		return (
			<div className="settings-feature-page">
				<section className={`settings-feature-hero${enabled?.value === true ? " is-enabled" : ""}`}>
					<div className="settings-feature-hero-copy">
						<span className="settings-feature-hero-icon">
							<Brain size={20} />
						</span>
						<div>
							<strong>
								{enabled?.value === true ? "Context maintenance is on" : "Context maintenance is off"}
							</strong>
							<p>
								OMP preserves the important parts of long conversations before the model runs out of context.
							</p>
						</div>
					</div>
					{renderFeatureSwitch(enabled, enabled?.value === true ? "Enabled" : "Disabled")}
				</section>
				<section className="settings-feature-flow" aria-label="Context maintenance flow">
					<div>
						<span>1</span>
						<strong>Context fills up</strong>
						<small>OMP watches the selected model's available context.</small>
					</div>
					<ChevronRight size={16} />
					<div>
						<span>2</span>
						<strong>{strategyLabel}</strong>
						<small>Older information is compressed or archived using this strategy.</small>
					</div>
					<ChevronRight size={16} />
					<div>
						<span>3</span>
						<strong>Task continues</strong>
						<small>Recent work and essential instructions remain available.</small>
					</div>
				</section>
				<section className="settings-feature-card">
					<div className="settings-feature-card-head">
						<div>
							<h3>Maintenance behavior</h3>
							<p>Choose the strategy, trigger point, and whether work resumes automatically.</p>
						</div>
						<span>Safe defaults</span>
					</div>
					{renderFriendlySettings(
						[
							"compaction.strategy",
							"compaction.thresholdPercent",
							"compaction.thresholdTokens",
							"compaction.autoContinue",
							"compaction.midTurnEnabled",
						],
						COMPACTION_FRIENDLY_COPY,
					)}
				</section>
				<section className="settings-feature-advanced">
					<button
						type="button"
						aria-expanded={showCompactionAdvanced}
						onClick={() => setShowCompactionAdvanced(value => !value)}
					>
						<span>
							<strong>Advanced context controls</strong>
							<small>Retention budgets, remote processing, idle preparation, and handoff files</small>
						</span>
						{showCompactionAdvanced ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
					</button>
					{showCompactionAdvanced ? (
						<div className="settings-guided-sections">
							{advancedGroups.map(group => {
								const expanded = openCompactionSection === group.id;
								return (
									<section className="settings-guided-section" key={group.id}>
										<button
											type="button"
											aria-expanded={expanded}
											onClick={() =>
												setOpenCompactionSection(current => (current === group.id ? null : group.id))
											}
										>
											<span>
												<strong>{group.label}</strong>
												<small>{group.description}</small>
											</span>
											{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
										</button>
										{expanded ? (
											<div>{renderFriendlySettings(group.paths, COMPACTION_FRIENDLY_COPY)}</div>
										) : null}
									</section>
								);
							})}
						</div>
					) : null}
				</section>
			</div>
		);
	};
	const renderMemoryDashboard = () => {
		const backendSetting = settingByPath("memory.backend");
		const selectedBackend = (backendSetting?.value ??
			props.memoryStatus?.backend ??
			"off") as MemoryStatus["backend"];
		const previewBackend = previewMemoryBackend ?? selectedBackend;
		const previewDefinition = MEMORY_BACKENDS.find(backend => backend.id === previewBackend) ?? MEMORY_BACKENDS[0];
		const PreviewBackendIcon = previewDefinition.icon;
		const statusReady = props.memoryStatus?.active === true && props.memoryStatus.backend === selectedBackend;
		const backendNeedsNewTask =
			previewDefinition.requiresNewTask && previewBackend === selectedBackend && !statusReady;
		const memorySections = [
			{
				id: "learning",
				label: "Learning after tasks",
				description: "Optional lesson capture and managed-skill improvement.",
				paths: ["autolearn.enabled", "autolearn.autoContinue", "autolearn.minToolCalls"],
			},
			...(selectedBackend === "local"
				? [
						{
							id: "local-pipeline",
							label: "Local summary pipeline",
							description: "Control which completed conversations become durable local summaries.",
							paths: [
								"memories.maxRolloutsPerStartup",
								"memories.maxRolloutAgeDays",
								"memories.minRolloutIdleHours",
								"memories.threadScanLimit",
								"memories.maxRawMemoriesForGlobal",
								"memories.summaryInjectionTokenLimit",
							],
						},
					]
				: []),
			...(selectedBackend === "mnemopi"
				? [
						{
							id: "mnemopi-recall",
							label: "Recall & retention",
							description: "Choose scope, automatic behavior, language support, and richer linking.",
							paths: [
								"mnemopi.scoping",
								"mnemopi.embeddingVariant",
								"mnemopi.autoRecall",
								"mnemopi.autoRetain",
								"mnemopi.polyphonicRecall",
								"mnemopi.enhancedRecall",
								"mnemopi.proactiveLinking",
							],
						},
						{
							id: "mnemopi-storage",
							label: "Storage & model overrides",
							description: "Expert database, embedding, and extraction-model settings.",
							paths: [
								"mnemopi.dbPath",
								"mnemopi.bank",
								"mnemopi.noEmbeddings",
								"mnemopi.embeddingModel",
								"mnemopi.embeddingApiUrl",
								"mnemopi.llmMode",
								"mnemopi.llmBaseUrl",
								"mnemopi.llmModel",
							],
						},
					]
				: []),
			...(selectedBackend === "hindsight"
				? [
						{
							id: "hindsight-connection",
							label: "Connection & memory scope",
							description: "Connect the service and decide how memory banks are shared.",
							paths: ["hindsight.apiUrl", "hindsight.bankId", "hindsight.bankIdPrefix", "hindsight.scoping"],
						},
						{
							id: "hindsight-behavior",
							label: "Recall & retention",
							description: "Control automatic storage, recall depth, and curated knowledge models.",
							paths: [
								"hindsight.autoRecall",
								"hindsight.autoRetain",
								"hindsight.retainMode",
								"hindsight.recallBudget",
								"hindsight.mentalModelsEnabled",
								"hindsight.mentalModelAutoSeed",
							],
						},
					]
				: []),
		].filter(section => section.paths.some(path => settingByPath(path)));
		return (
			<div className="memory-settings-page">
				<section
					className={`memory-status-hero${statusReady ? " is-ready" : ""}${props.memoryStatus?.error ? " has-error" : ""}`}
				>
					<div className="memory-status-copy">
						<span className="memory-status-icon">
							<Database size={21} />
						</span>
						<div>
							<strong>
								{selectedBackend === "off"
									? "Memory is off"
									: statusReady
										? "Memory is ready"
										: "Memory needs attention"}
							</strong>
							<p>
								{props.memoryStatus?.error ??
									props.memoryStatus?.message ??
									"Choose how OMP remembers information across tasks."}
							</p>
						</div>
					</div>
					<div className="memory-capability-list" aria-label="Memory capabilities">
						<span className={props.memoryStatus?.writable ? "is-available" : "is-unavailable"}>
							{props.memoryStatus?.writable ? <Check size={13} /> : <X size={13} />}
							{props.memoryStatus?.writable ? "Remember available" : "Remember unavailable"}
						</span>
						<span className={props.memoryStatus?.searchable ? "is-available" : "is-unavailable"}>
							{props.memoryStatus?.searchable ? <Check size={13} /> : <X size={13} />}
							{props.memoryStatus?.searchable ? "Semantic recall available" : "Semantic recall unavailable"}
						</span>
					</div>
				</section>

				<section className="memory-backend-section">
					<div className="memory-section-heading">
						<div>
							<h3>Choose where memory lives</h3>
							<p>Select a backend to review it. Nothing changes until you activate it.</p>
						</div>
						<span>{backendSetting?.configured ? "Customized" : "Default: Off"}</span>
					</div>
					<div className="memory-backend-grid">
						{MEMORY_BACKENDS.map(backend => {
							const BackendIcon = backend.icon;
							const selected = backend.id === previewBackend;
							const active = backend.id === selectedBackend;
							return (
								<button
									key={backend.id}
									type="button"
									className={`${selected ? "is-selected" : ""}${active ? " is-active" : ""}`}
									aria-pressed={selected}
									disabled={!backendSetting || isSaving("memory.backend")}
									onClick={() => setPreviewMemoryBackend(backend.id)}
								>
									<span className="memory-backend-icon">
										<BackendIcon size={17} />
									</span>
									<span>
										<strong>{backend.label}</strong>
										<small>{backend.description}</small>
										<em>{backend.detail}</em>
									</span>
									{active ? (
										<span className="memory-backend-active-label">
											{statusReady && props.memoryStatus?.backend === backend.id ? "Active" : "Configured"}
										</span>
									) : null}
								</button>
							);
						})}
					</div>
					<div className="memory-backend-detail" aria-live="polite">
						<div className="memory-backend-detail-main">
							<span className="memory-backend-icon">
								<PreviewBackendIcon size={18} />
							</span>
							<div>
								<span className="memory-backend-eyebrow">Backend details</span>
								<h4>{previewDefinition.label}</h4>
								<p>{previewDefinition.detail}</p>
							</div>
						</div>
						<div className="memory-backend-facts">
							<div>
								<span>Storage</span>
								<strong>{previewDefinition.storage}</strong>
							</div>
							<div>
								<span>Privacy</span>
								<strong>{previewDefinition.privacy}</strong>
							</div>
							<div>
								<span>Setup</span>
								<strong>{previewDefinition.setup}</strong>
							</div>
						</div>
						<div className="memory-backend-feature-row">
							<span className={previewDefinition.remembers ? "is-supported" : ""}>
								{previewDefinition.remembers ? <Check size={13} /> : <X size={13} />} Durable memory
							</span>
							<span className={previewDefinition.semanticRecall ? "is-supported" : ""}>
								{previewDefinition.semanticRecall ? <Check size={13} /> : <X size={13} />} Semantic recall
							</span>
						</div>
						{previewBackend === "hindsight" ? (
							<div className="memory-backend-inline-setup">
								<strong>Connection required before activation</strong>
								{renderFriendlySettings(["hindsight.apiUrl"], MEMORY_FRIENDLY_COPY)}
								<small>For authenticated servers, set HINDSIGHT_API_TOKEN in the engine environment.</small>
							</div>
						) : null}
						<div className="memory-backend-activation">
							<div>
								<strong>
									{previewBackend === selectedBackend
										? backendNeedsNewTask
											? "Selected; start a new task to initialize it"
											: "This is the configured backend"
										: `Activate ${previewDefinition.label}`}
								</strong>
								<span>
									{previewDefinition.requiresNewTask
										? "OMP creates its recall and retention state when a task starts."
										: "This change is available in the current task."}
								</span>
							</div>
							{backendNeedsNewTask ? (
								<button type="button" className="settings-primary-button" onClick={props.onStartNewTask}>
									Start new task
								</button>
							) : previewBackend !== selectedBackend ? (
								<button
									type="button"
									className="settings-primary-button"
									disabled={!backendSetting || isSaving("memory.backend")}
									onClick={() => props.onSaveSetting("memory.backend", previewBackend)}
								>
									{isSaving("memory.backend") ? "Activating..." : `Activate ${previewDefinition.label}`}
								</button>
							) : null}
						</div>
					</div>
				</section>

				{selectedBackend !== "off" ? (
					<>
						{props.memoryStatus?.workingCount !== undefined ||
						props.memoryStatus?.episodicCount !== undefined ||
						props.memoryStatus?.tripleCount !== undefined ? (
							<section className="memory-stat-grid" aria-label="Memory statistics">
								<div>
									<strong>{props.memoryStatus?.workingCount ?? 0}</strong>
									<span>Working memories</span>
								</div>
								<div>
									<strong>{props.memoryStatus?.episodicCount ?? 0}</strong>
									<span>Episodes</span>
								</div>
								<div>
									<strong>{props.memoryStatus?.tripleCount ?? 0}</strong>
									<span>Knowledge links</span>
								</div>
							</section>
						) : null}
						<section className="memory-workbench">
							<div className={`memory-task-card${props.memoryStatus?.searchable ? "" : " is-unavailable"}`}>
								<div className="memory-task-title">
									<span>
										<Plus size={16} />
									</span>
									<div>
										<h3>Remember something</h3>
										<p>Store a durable fact, preference, or project decision.</p>
									</div>
								</div>
								<textarea
									className="settings-input"
									aria-label="Memory content"
									value={memoryDraft}
									onChange={event => setMemoryDraft(event.currentTarget.value)}
									placeholder="Example: This project uses Bun for all package scripts."
									disabled={!props.memoryStatus?.writable}
								/>
								<div className="memory-task-actions">
									<span>
										{props.memoryStatus?.writable
											? "Saved to the active backend"
											: "This backend is not writable"}
									</span>
									<button
										type="button"
										disabled={
											!memoryDraft.trim() || !props.memoryStatus?.writable || isSavingPrefix("memory:")
										}
										onClick={() => {
											const content = memoryDraft.trim();
											void props.onSaveMemory(content).then(saved => {
												if (saved) setMemoryDraft(current => (current.trim() === content ? "" : current));
											});
										}}
									>
										Save memory
									</button>
								</div>
							</div>
							<div className="memory-task-card">
								<div className="memory-task-title">
									<span>
										<Search size={16} />
									</span>
									<div>
										<h3>Recall memories</h3>
										<p>Find stored knowledge and add it to the current task.</p>
									</div>
								</div>
								{props.memoryStatus?.searchable ? (
									<div className="memory-search-control">
										<input
											className="settings-input"
											aria-label="Search memory records"
											value={memoryQuery}
											onChange={event => setMemoryQuery(event.currentTarget.value)}
											placeholder="What do you want OMP to remember?"
											disabled={!props.memoryStatus?.searchable}
											onKeyDown={event => {
												if (event.key === "Enter" && memoryQuery.trim())
													props.onSearchMemory(memoryQuery.trim());
											}}
										/>
										<button
											type="button"
											disabled={
												!memoryQuery.trim() || !props.memoryStatus?.searchable || isSaving("memory:search")
											}
											onClick={() => props.onSearchMemory(memoryQuery.trim())}
										>
											Search
										</button>
									</div>
								) : (
									<div className="memory-recall-unavailable">
										<strong>
											{selectedBackend === "local"
												? "Local summaries do not include a search index"
												: "Recall will be available after this backend is initialized"}
										</strong>
										<p>
											{selectedBackend === "local"
												? "Your summaries are still saved locally. Choose Mnemopi for local semantic recall or Hindsight for remote recall."
												: "Start a new task after activating Mnemopi or Hindsight."}
										</p>
										{selectedBackend === "local" ? (
											<div>
												<button type="button" onClick={() => setPreviewMemoryBackend("mnemopi")}>
													Review Mnemopi
												</button>
												<button type="button" onClick={() => setPreviewMemoryBackend("hindsight")}>
													Review Hindsight
												</button>
											</div>
										) : backendNeedsNewTask ? (
											<button type="button" onClick={props.onStartNewTask}>
												Start new task
											</button>
										) : null}
									</div>
								)}
								<span className="memory-task-hint">
									{props.memoryStatus?.searchable
										? "Search uses the active backend's recall engine"
										: selectedBackend === "local"
											? "Local summaries do not support semantic search"
											: "Search is unavailable until the backend connects"}
								</span>
							</div>
						</section>

						{props.memorySearch ? (
							<section className="memory-results">
								<div className="memory-section-heading">
									<div>
										<h3>Recall results</h3>
										<p>
											{props.memorySearch.count} results for “{props.memorySearch.query}”
										</p>
									</div>
									<span>{props.memorySearch.backend}</span>
								</div>
								{props.memorySearch.items.length === 0 ? (
									<div className="memory-results-empty">
										<Search size={20} />
										<strong>No matching memories</strong>
										<span>Try a broader phrase or store a new memory above.</span>
									</div>
								) : (
									props.memorySearch.items
										.filter(item => matchesQuery(item.content, item.source))
										.map(item => (
											<article className="memory-result-card" key={item.id ?? item.content}>
												<div>
													<div className="memory-result-meta">
														<strong>{item.source ?? "Memory record"}</strong>
														{item.score !== undefined ? (
															<span>{Math.round(item.score * 100)}% match</span>
														) : null}
														{item.timestamp ? (
															<time>{new Date(item.timestamp).toLocaleString()}</time>
														) : null}
													</div>
													<p>{item.content}</p>
												</div>
												<button type="button" onClick={() => props.onAddMemoryContext(item)}>
													Add to task context
												</button>
											</article>
										))
								)}
							</section>
						) : null}

						<section className="memory-maintenance">
							<div>
								<strong>Memory maintenance</strong>
								<span>Process pending conversations or remove data from the active backend.</span>
							</div>
							<div>
								<button
									type="button"
									disabled={!props.memoryStatus?.active || isSavingPrefix("memory:")}
									onClick={props.onEnqueueMemory}
								>
									Process pending memories
								</button>
								<button
									type="button"
									className="settings-danger-button"
									disabled={!props.memoryStatus?.active || isSavingPrefix("memory:")}
									onClick={() =>
										confirmAction({
											title: "Clear memory backend?",
											message: "This clears memory state for the active backend and cannot be undone.",
											confirmLabel: "Clear memory",
											onConfirm: props.onClearMemory,
										})
									}
								>
									Clear backend
								</button>
							</div>
						</section>
					</>
				) : (
					<div className="memory-off-message">
						<Database size={24} />
						<strong>Persistent memory is disabled</strong>
						<span>Choose Local summaries, Mnemopi, or Hindsight to remember information across tasks.</span>
					</div>
				)}

				{selectedBackend !== "off" && memorySections.length > 0 ? (
					<section className="settings-feature-advanced memory-advanced">
						<button
							type="button"
							aria-expanded={showMemoryAdvanced}
							onClick={() => setShowMemoryAdvanced(value => !value)}
						>
							<span>
								<strong>Memory behavior & advanced setup</strong>
								<small>
									Automatic learning and settings specific to{" "}
									{MEMORY_BACKENDS.find(item => item.id === selectedBackend)?.label}
								</small>
							</span>
							{showMemoryAdvanced ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
						</button>
						{showMemoryAdvanced ? (
							<div className="settings-guided-sections">
								{memorySections.map(section => {
									const expanded = openMemorySection === section.id;
									return (
										<section className="settings-guided-section" key={section.id}>
											<button
												type="button"
												aria-expanded={expanded}
												onClick={() =>
													setOpenMemorySection(current => (current === section.id ? null : section.id))
												}
											>
												<span>
													<strong>{section.label}</strong>
													<small>{section.description}</small>
												</span>
												{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
											</button>
											{expanded ? (
												<div>{renderFriendlySettings(section.paths, MEMORY_FRIENDLY_COPY)}</div>
											) : null}
										</section>
									);
								})}
							</div>
						) : null}
					</section>
				) : null}
			</div>
		);
	};
	const renderPluginsDashboard = () => {
		const runtimePlugins = (props.snapshot?.plugins ?? []).filter(plugin =>
			matchesQuery(plugin.name, plugin.description, ...plugin.availableFeatures),
		);
		const marketplacePlugins = (props.marketplace?.plugins ?? []).filter(plugin =>
			matchesQuery(plugin.name, plugin.description, plugin.author, plugin.category, ...(plugin.tags ?? [])),
		);
		const installedMarketplacePlugins = marketplacePlugins.filter(plugin => plugin.installations.length > 0);
		const activeRuntimeCount = (props.snapshot?.plugins ?? []).filter(plugin => plugin.enabled).length;
		const marketplaceInstallationCount = (props.marketplace?.plugins ?? []).reduce(
			(total, plugin) => total + plugin.installations.length,
			0,
		);
		const renderMarketplacePlugin = (plugin: MarketplacePluginDescriptor) => (
			<MarketplacePluginRow
				key={plugin.id}
				plugin={plugin}
				busy={props.savingKeys.some(key => key.includes(plugin.id))}
				onInstall={scope => props.onInstallMarketplacePlugin(plugin.name, plugin.marketplace, scope)}
				onUpgrade={scope => props.onUpgradeMarketplacePlugin(plugin.id, scope)}
				onUninstall={scope =>
					confirmAction({
						title: `Uninstall ${plugin.name}?`,
						message: `The ${scope} installation will be removed.`,
						confirmLabel: "Uninstall plugin",
						onConfirm: () => props.onUninstallMarketplacePlugin(plugin.id, scope),
					})
				}
				onEnabled={(scope, enabled) => props.onSetMarketplacePluginEnabled(plugin.id, enabled, scope)}
			/>
		);
		return (
			<div className="plugin-settings-page">
				<section
					className={`plugin-status-hero${activeRuntimeCount > 0 || marketplaceInstallationCount > 0 ? " is-ready" : ""}`}
				>
					<div className="plugin-status-copy">
						<span className="plugin-status-icon">
							<Sparkles size={20} />
						</span>
						<div>
							<strong>
								{activeRuntimeCount === 0 && marketplaceInstallationCount === 0
									? "No plugins installed"
									: `${activeRuntimeCount} runtime plugin${activeRuntimeCount === 1 ? "" : "s"} active`}
							</strong>
							<p>
								{marketplaceInstallationCount} marketplace installation
								{marketplaceInstallationCount === 1 ? "" : "s"} · {props.marketplace?.marketplaces.length ?? 0}{" "}
								catalog sources
							</p>
						</div>
					</div>
					<button type="button" disabled={isSavingPrefix("marketplace:")} onClick={props.onRefreshMarketplace}>
						<RefreshCw size={14} /> Refresh catalogs
					</button>
				</section>

				<section className="plugin-pane-selector">
					<div className="memory-section-heading">
						<div>
							<h3>Choose what to manage</h3>
							<p>Installed extensions, available catalog plugins, or marketplace sources.</p>
						</div>
					</div>
					<div className="plugin-pane-grid" role="group" aria-label="Plugin management views">
						{(
							[
								{
									id: "installed",
									label: "Installed",
									description: "Configure active plugins and direct installations.",
									count: (props.snapshot?.plugins.length ?? 0) + marketplaceInstallationCount,
									icon: Sparkles,
								},
								{
									id: "discover",
									label: "Discover",
									description: "Browse plugins published by your catalogs.",
									count: props.marketplace?.plugins.length ?? 0,
									icon: Cloud,
								},
								{
									id: "sources",
									label: "Sources",
									description: "Manage Git, local, and catalog URL sources.",
									count: props.marketplace?.marketplaces.length ?? 0,
									icon: Settings2,
								},
							] as const
						).map(item => {
							const PaneIcon = item.icon;
							const selected = pluginPane === item.id;
							return (
								<button
									type="button"
									className={selected ? "is-selected" : ""}
									aria-pressed={selected}
									onClick={() => setPluginPane(item.id)}
									key={item.id}
								>
									<span className="plugin-pane-icon">
										<PaneIcon size={16} />
									</span>
									<span>
										<strong>{item.label}</strong>
										<small>{item.description}</small>
									</span>
									<em>{item.count}</em>
									{selected ? <Check size={14} /> : null}
								</button>
							);
						})}
					</div>
				</section>

				{pluginPane === "installed" ? (
					<>
						<section className="plugin-page-section">
							<div className="memory-section-heading">
								<div>
									<h3>Runtime plugins</h3>
									<p>Direct npm, Git, or linked plugins that can provide executable OMP extensions.</p>
								</div>
								<span>{runtimePlugins.length} shown</span>
							</div>
							{runtimePlugins.length > 0 ? (
								<div className="plugin-runtime-list">
									{runtimePlugins.map(plugin => (
										<PluginRow
											key={plugin.name}
											plugin={plugin}
											busy={isSavingPrefix(`plugin:${plugin.name}`)}
											onEnabled={enabled => props.onSetPluginEnabled(plugin.name, enabled)}
											onFeatures={features => props.onSetPluginFeatures(plugin.name, features)}
											onSetting={(key, value) => props.onSetPluginSetting(plugin.name, key, value)}
											onResetSetting={key => props.onDeletePluginSetting(plugin.name, key)}
											onUpdate={() => props.onUpdatePlugin(plugin.name)}
											onUninstall={() =>
												confirmAction({
													title: `Uninstall ${plugin.name}?`,
													message:
														"This removes the plugin's installed files. You can install it again later.",
													confirmLabel: "Uninstall plugin",
													onConfirm: () => props.onUninstallPlugin(plugin.name),
												})
											}
										/>
									))}
								</div>
							) : (
								<div className="plugin-empty-state">
									<Sparkles size={22} />
									<strong>No direct runtime plugins installed</strong>
									<span>Install from npm, Git, or a local path below.</span>
								</div>
							)}
						</section>

						<section className="plugin-direct-install">
							<div>
								<strong>Install directly from a source</strong>
								<span>
									Supports npm packages, GitHub/GitLab/Bitbucket shorthand, Git URLs, and local paths.
								</span>
							</div>
							<div className="settings-control">
								<input
									className="settings-input"
									aria-label="Plugin package or repository"
									value={pluginSpec}
									onChange={event => setPluginSpec(event.currentTarget.value)}
									placeholder="github:owner/repo, npm package, Git URL, or local path"
								/>
								<button
									type="button"
									className="settings-primary-button"
									disabled={!pluginSpec.trim() || isSavingPrefix("plugin:")}
									onClick={() => props.onInstallPlugin(pluginSpec.trim())}
								>
									Install plugin
								</button>
							</div>
						</section>

						{installedMarketplacePlugins.length > 0 ? (
							<section className="plugin-page-section">
								<div className="memory-section-heading">
									<div>
										<h3>Marketplace installations</h3>
										<p>Capability bundles installed for this project or your user profile.</p>
									</div>
								</div>
								<div className="marketplace-plugin-grid">
									{installedMarketplacePlugins.map(renderMarketplacePlugin)}
								</div>
							</section>
						) : null}
					</>
				) : pluginPane === "discover" ? (
					<section className="plugin-page-section">
						<div className="memory-section-heading">
							<div>
								<h3>Discover plugins</h3>
								<p>Browse the catalogs configured under Sources.</p>
							</div>
							<span>{marketplacePlugins.length} shown</span>
						</div>
						<div className="plugin-runtime-note">
							<ShieldCheck size={16} />
							<span>
								Marketplace plugins can provide skills, commands, agents, hooks, tools, MCP, LSP, and DAP
								configuration. Executable extension modules require a direct npm or linked installation.
							</span>
						</div>
						{props.marketplaceError ? (
							<div className="settings-validation-error" role="alert">
								{props.marketplaceError}
							</div>
						) : null}
						{marketplacePlugins.length > 0 ? (
							<div className="marketplace-plugin-grid">{marketplacePlugins.map(renderMarketplacePlugin)}</div>
						) : (
							<div className="plugin-empty-state">
								<Cloud size={22} />
								<strong>No catalog plugins available</strong>
								<span>Add a marketplace source, then return here to browse its plugins.</span>
								<button
									type="button"
									className="settings-primary-button"
									onClick={() => setPluginPane("sources")}
								>
									Manage sources
								</button>
							</div>
						)}
					</section>
				) : (
					<section className="plugin-page-section">
						<div className="memory-section-heading">
							<div>
								<h3>Marketplace sources</h3>
								<p>Git repositories, local directories, or direct marketplace.json catalogs.</p>
							</div>
						</div>
						<div className="plugin-source-add">
							<input
								className="settings-input"
								aria-label="Marketplace source"
								value={marketplaceSource}
								onChange={event => setMarketplaceSource(event.currentTarget.value)}
								placeholder="owner/repo, Git URL, catalog URL, or local path"
							/>
							<button
								type="button"
								className="settings-primary-button"
								disabled={!marketplaceSource.trim() || isSavingPrefix("marketplace:source:")}
								onClick={() => props.onAddMarketplace(marketplaceSource.trim())}
							>
								Add source
							</button>
						</div>
						{props.marketplace?.marketplaces.length ? (
							<div className="marketplace-sources">
								{props.marketplace.marketplaces
									.filter(source => matchesQuery(source.name, source.sourceType))
									.map(source => (
										<div className="marketplace-source" key={source.name}>
											<div>
												<strong>{source.name}</strong>
												<span>
													{source.sourceType} · updated {new Date(source.updatedAt).toLocaleString()}
												</span>
											</div>
											<div className="settings-control">
												<button
													type="button"
													disabled={isSaving(`marketplace:source:update:${source.name}`)}
													onClick={() => props.onUpdateMarketplace(source.name)}
												>
													Update
												</button>
												<button
													type="button"
													className="settings-danger-button"
													disabled={isSaving(`marketplace:source:remove:${source.name}`)}
													onClick={() =>
														confirmAction({
															title: `Remove ${source.name}?`,
															message:
																"Installed plugins remain, but this catalog will no longer be available.",
															confirmLabel: "Remove marketplace",
															onConfirm: () => props.onRemoveMarketplace(source.name),
														})
													}
												>
													Remove
												</button>
											</div>
										</div>
									))}
							</div>
						) : (
							<div className="plugin-empty-state">
								<Cloud size={22} />
								<strong>No marketplace sources configured</strong>
								<span>Add the recommended Claude-compatible catalog or provide your own source.</span>
								<button
									type="button"
									disabled={isSavingPrefix("marketplace:source:")}
									onClick={() => props.onAddMarketplace("anthropics/claude-plugins-official")}
								>
									Add recommended official marketplace
								</button>
							</div>
						)}
						{props.marketplaceError ? (
							<div className="settings-validation-error" role="alert">
								{props.marketplaceError}
							</div>
						) : null}
					</section>
				)}
			</div>
		);
	};
	const renderSkillsDashboard = () => {
		const skillSettings = (props.snapshot?.settings ?? []).filter(setting => setting.category === "skills");
		const skillSetting = (path: string) => skillSettings.find(setting => setting.path === path);
		const enabled = skillSetting("skills.enabled");
		const commands = skillSetting("skills.enableSkillCommands");
		const hiddenCount = props.skillDetails.filter(skill => skill.hidden).length;
		const activeSourceCount = new Set(props.skillDetails.map(skill => `${skill.provider}:${skill.level}`)).size;
		const visibleSkills = props.skillDetails.filter(skill =>
			matchesQuery(skill.name, skill.description, skill.providerName, skill.source, skill.level),
		);
		const sourceGroups = [
			{
				id: "omp",
				label: "OMP native",
				description: "Skills stored in OMP's native user and project directories.",
				paths: [
					["skills.enablePiUser", "User"],
					["skills.enablePiProject", "Project"],
				] as const,
				providers: ["native"],
			},
			{
				id: "agents",
				label: "Agent Skills",
				description: "The .agent and .agents skill locations supported by OMP.",
				paths: [
					["skills.enableAgentsUser", "User"],
					["skills.enableAgentsProject", "Project"],
				] as const,
				providers: ["agents"],
			},
			{
				id: "claude",
				label: "Claude compatible",
				description: "Claude user, project, and compatible plugin skills.",
				paths: [
					["skills.enableClaudeUser", "User"],
					["skills.enableClaudeProject", "Project"],
				] as const,
				providers: ["claude", "claude-plugins"],
			},
			{
				id: "codex",
				label: "OpenAI Codex",
				description: "Skills discovered from the Codex user-level location.",
				paths: [["skills.enableCodexUser", "User"]] as const,
				providers: ["codex"],
			},
			{
				id: "extensions",
				label: "Extensions & managed",
				description: "Plugin, marketplace, custom-directory, GitHub, and auto-learn skills.",
				paths: [] as const,
				providers: ["omp-plugins", "github", "opencode", "omp-managed", "custom"],
			},
		] as const;
		const advancedPaths = ["skills.customDirectories", "skills.includeSkills", "skills.ignoredSkills"];
		return (
			<div className="skill-settings-page">
				<section className={`skill-status-hero${enabled?.value === true ? " is-ready" : ""}`}>
					<div className="skill-status-copy">
						<span className="skill-status-icon">
							<ShieldCheck size={20} />
						</span>
						<div>
							<strong>
								{enabled?.value === true
									? `${props.skillDetails.length} skill${props.skillDetails.length === 1 ? "" : "s"} available`
									: "Skill discovery is off"}
							</strong>
							<p>
								OMP exposes lightweight metadata first and reads SKILL.md content only when the workflow is
								needed.
							</p>
						</div>
					</div>
					<div className="skill-status-actions">
						{renderFeatureSwitch(enabled, enabled?.value === true ? "Enabled" : "Disabled")}
						<button type="button" disabled={isSaving("skill:reload")} onClick={props.onReloadSkills}>
							<RefreshCw size={14} />
							Reload discovery
						</button>
					</div>
				</section>

				<section className="skill-runtime-flow" aria-label="How OMP uses skills">
					<div>
						<span>1</span>
						<strong>Discover</strong>
						<small>Read valid SKILL.md files from enabled sources.</small>
					</div>
					<ChevronRight size={16} />
					<div>
						<span>2</span>
						<strong>Match</strong>
						<small>Show name and description to the model for selection.</small>
					</div>
					<ChevronRight size={16} />
					<div>
						<span>3</span>
						<strong>Load on demand</strong>
						<small>Read content securely through skill:// when required.</small>
					</div>
				</section>

				<section className="skill-page-section">
					<div className="memory-section-heading">
						<div>
							<h3>Discovery sources</h3>
							<p>Control the real user and project locations scanned by the active OMP session.</p>
						</div>
						<span className="memory-section-badge">
							{activeSourceCount} active source{activeSourceCount === 1 ? "" : "s"}
						</span>
					</div>
					<div className="skill-source-grid">
						{sourceGroups.map(source => {
							const count = props.skillDetails.filter(skill =>
								source.providers.some(provider => provider === skill.provider),
							).length;
							return (
								<article className="skill-source-card" key={source.id}>
									<div className="skill-source-head">
										<span>
											<HardDrive size={16} />
										</span>
										<div>
											<strong>{source.label}</strong>
											<small>{source.description}</small>
										</div>
										<em>{count}</em>
									</div>
									{source.paths.length > 0 ? (
										<div className="skill-source-switches">
											{source.paths.map(([path, label]) => {
												const setting = skillSetting(path);
												return (
													<button
														type="button"
														key={path}
														className={setting?.value === true ? "is-on" : ""}
														role="switch"
														aria-checked={setting?.value === true}
														disabled={!setting || enabled?.value !== true || isSaving(path)}
														onClick={() => setting && props.onSaveSetting(path, setting.value !== true)}
													>
														<span aria-hidden="true" />
														{label}
													</button>
												);
											})}
										</div>
									) : (
										<span className="skill-source-managed">Managed by its owning integration</span>
									)}
								</article>
							);
						})}
					</div>
				</section>

				<section className="skill-page-section">
					<div className="memory-section-heading">
						<div>
							<h3>Available skills</h3>
							<p>These are loaded by the runtime now. Disable only removes the matching skill name.</p>
						</div>
						<div className="skill-library-summary">
							{renderFeatureSwitch(
								commands,
								commands?.value === true ? "/skill commands on" : "/skill commands off",
							)}
							{hiddenCount > 0 ? <span>{hiddenCount} hidden</span> : null}
						</div>
					</div>
					{visibleSkills.length > 0 ? (
						<div className="skill-library-list">
							{visibleSkills.map(skill => {
								const expanded = openSkillName === skill.name;
								return (
									<article className={`skill-library-card${expanded ? " is-open" : ""}`} key={skill.filePath}>
										<div className="skill-library-head">
											<button
												type="button"
												aria-expanded={expanded}
												onClick={() =>
													setOpenSkillName(current => (current === skill.name ? null : skill.name))
												}
											>
												<span className="skill-library-icon">
													<Sparkles size={16} />
												</span>
												<span>
													<strong>{skill.name}</strong>
													<small>{skill.description || "No description provided by this skill."}</small>
												</span>
												<em>
													{skill.providerName} · {skill.level}
												</em>
												{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
											</button>
											<button
												type="button"
												disabled={isSaving(`skill:${skill.name}`)}
												onClick={() => props.onSetSkillEnabled(skill.name, false)}
											>
												Disable
											</button>
										</div>
										{expanded ? (
											<div className="skill-library-detail">
												<div>
													<strong>
														{skill.hidden ? "Explicit invocation only" : "Available for model matching"}
													</strong>
													<span>
														{skill.hidden
															? "This skill is loaded but omitted from the model-facing skill list. It remains reachable by skill URL and command."
															: `OMP can load this workflow from skill://${skill.name} when its description matches the task.`}
													</span>
												</div>
												{skill.hidden ? (
													<span className="skill-hidden-badge">
														<EyeOff size={13} /> Hidden
													</span>
												) : null}
												{showTechnicalDetails ? <code>{skill.filePath}</code> : null}
											</div>
										) : null}
									</article>
								);
							})}
						</div>
					) : (
						<div className="plugin-empty-state">
							<ShieldCheck size={22} />
							<strong>{enabled?.value === true ? "No skills discovered" : "Skill discovery is disabled"}</strong>
							<span>
								{enabled?.value === true
									? "Add a valid SKILL.md to an enabled source or review discovery warnings below."
									: "Enable discovery to load skills from the configured sources."}
							</span>
						</div>
					)}
					{ignoredSkills.filter(name => !props.skillDetails.some(skill => skill.name === name)).length > 0 ? (
						<div className="skill-disabled-list">
							<strong>Disabled skills</strong>
							{ignoredSkills
								.filter(name => !props.skillDetails.some(skill => skill.name === name))
								.filter(name => matchesQuery(name))
								.map(name => (
									<div key={name}>
										<span>{name}</span>
										<button
											type="button"
											disabled={isSaving(`skill:${name}`)}
											onClick={() => props.onSetSkillEnabled(name, true)}
										>
											Enable
										</button>
									</div>
								))}
						</div>
					) : null}
				</section>

				{props.skillWarnings.length > 0 ? (
					<section className="skill-warning-section">
						<div className="memory-section-heading">
							<div>
								<h3>Discovery needs attention</h3>
								<p>OMP reported these validation or name-collision problems while reading skill files.</p>
							</div>
							<span className="memory-section-badge is-warning">{props.skillWarnings.length}</span>
						</div>
						{props.skillWarnings.map(warning => (
							<div className="skill-warning-row" key={`${warning.skillPath}:${warning.message}`}>
								<Bug size={15} />
								<span>{warning.message}</span>
								{showTechnicalDetails ? <code>{warning.skillPath}</code> : null}
							</div>
						))}
					</section>
				) : null}

				<section className="settings-feature-advanced skill-advanced">
					<div className="settings-feature-advanced-head">
						<div>
							<strong>Discovery rules</strong>
							<span>Custom directories and optional include or ignore glob patterns.</span>
						</div>
					</div>
					<div className="settings-feature-advanced-content">
						<div className="settings-feature-card">
							{skillSettings
								.filter(setting => advancedPaths.includes(setting.path))
								.map(setting => (
									<SettingRow
										key={setting.path}
										setting={setting}
										savingKey={isSaving(setting.path) ? setting.path : null}
										feedback={props.operationFeedbacks.find(item => item.key === setting.path) ?? null}
										showTechnicalDetails={showTechnicalDetails}
										onSave={value => props.onSaveSetting(setting.path, value)}
									/>
								))}
						</div>
					</div>
				</section>
			</div>
		);
	};
	const renderMcpDashboard = () => {
		const visibleServers = props.mcpServers.filter(server =>
			matchesQuery(
				server.name,
				server.status,
				server.transport,
				server.lastError,
				server.source?.providerName,
				...server.toolNames,
			),
		);
		const connectedCount = props.mcpServers.filter(server => server.enabled && server.status === "connected").length;
		const attentionCount = props.mcpServers.filter(
			server => server.enabled && server.status === "disconnected",
		).length;
		const toolCount = props.mcpServers.reduce((total, server) => total + server.toolCount, 0);
		const resourceCount =
			props.mcpCapabilities?.resources.reduce((total, group) => total + group.resources.length, 0) ?? 0;
		const templateCount =
			props.mcpCapabilities?.resources.reduce((total, group) => total + group.templates.length, 0) ?? 0;
		const promptCount = props.mcpCapabilities?.prompts.reduce((total, group) => total + group.prompts.length, 0) ?? 0;
		const mcpSettingPaths = ["mcp.enableProjectConfig", "mcp.notifications", "mcp.notificationDebounceMs"].filter(
			path => settingByPath(path),
		);
		return (
			<div className="mcp-settings-page">
				<section className={`mcp-overview${attentionCount > 0 ? " has-attention" : ""}`}>
					<div className="mcp-overview-copy">
						<span className="mcp-overview-icon">
							<Plug size={21} />
						</span>
						<div>
							<strong>
								{props.mcpServers.length === 0
									? "No MCP servers discovered"
									: attentionCount > 0
										? `${attentionCount} server${attentionCount === 1 ? " needs" : "s need"} attention`
										: "MCP runtime is healthy"}
							</strong>
							<p>
								{connectedCount} connected · {toolCount} mounted tool{toolCount === 1 ? "" : "s"} ·{" "}
								{props.mcpServers.length} discovered
							</p>
						</div>
					</div>
					<div className="mcp-overview-actions">
						<button
							type="button"
							className="settings-primary-button"
							onClick={() => setShowMcpAdd(value => !value)}
						>
							<Plus size={14} /> Add server
						</button>
						<button type="button" disabled={isSaving("plugin:mcp:reload")} onClick={props.onReloadMcp}>
							<RefreshCw size={14} /> Reload discovery
						</button>
					</div>
				</section>

				{showMcpAdd ? (
					<section className="mcp-add-panel">
						<div className="memory-section-heading">
							<div>
								<h3>Add MCP server</h3>
								<p>The server is validated, written to OMP config, discovered, and connected immediately.</p>
							</div>
							<button type="button" aria-label="Close add MCP server" onClick={() => setShowMcpAdd(false)}>
								<X size={14} />
							</button>
						</div>
						<div className="mcp-add-grid">
							<label>
								<span>Server name</span>
								<input
									className="settings-input"
									value={mcpDraftName}
									onChange={event => setMcpDraftName(event.currentTarget.value)}
									placeholder="github"
								/>
							</label>
							<label>
								<span>Configuration scope</span>
								<select
									className="settings-select"
									value={mcpDraftScope}
									onChange={event => setMcpDraftScope(event.currentTarget.value as "user" | "project")}
								>
									<option value="project">This project</option>
									<option value="user">All projects in this profile</option>
								</select>
							</label>
							<label>
								<span>Transport</span>
								<select
									className="settings-select"
									value={mcpDraftTransport}
									onChange={event => {
										setMcpDraftTransport(event.currentTarget.value as "stdio" | "http" | "sse");
										setMcpDraftEndpoint("");
									}}
								>
									<option value="stdio">Local process (STDIO)</option>
									<option value="http">Remote server (HTTP)</option>
									<option value="sse">Legacy remote server (SSE)</option>
								</select>
							</label>
							<label>
								<span>{mcpDraftTransport === "stdio" ? "Command" : "Server URL"}</span>
								<input
									className="settings-input"
									value={mcpDraftEndpoint}
									onChange={event => setMcpDraftEndpoint(event.currentTarget.value)}
									placeholder={mcpDraftTransport === "stdio" ? "npx" : "https://example.com/mcp"}
								/>
							</label>
						</div>
						{mcpDraftTransport === "stdio" ? (
							<label className="mcp-add-wide">
								<span>
									Arguments <small>one argument per line</small>
								</span>
								<textarea
									className="settings-input"
									value={mcpDraftArgs}
									onChange={event => setMcpDraftArgs(event.currentTarget.value)}
									placeholder={"-y\n@modelcontextprotocol/server-filesystem\nC:\\workspace"}
								/>
							</label>
						) : null}
						<div className="mcp-add-grid">
							<label>
								<span>
									{mcpDraftTransport === "stdio" ? "Environment variables" : "Request headers"}{" "}
									<small>KEY=value, one per line</small>
								</span>
								<textarea
									className="settings-input"
									value={mcpDraftValues}
									onChange={event => setMcpDraftValues(event.currentTarget.value)}
									placeholder={
										mcpDraftTransport === "stdio" ? MCP_ENV_VALUE_EXAMPLE : MCP_HEADER_VALUE_EXAMPLE
									}
								/>
							</label>
							<label>
								<span>
									Timeout <small>milliseconds; empty uses default</small>
								</span>
								<input
									className="settings-input"
									inputMode="numeric"
									value={mcpDraftTimeout}
									onChange={event => setMcpDraftTimeout(event.currentTarget.value)}
									placeholder="30000"
								/>
							</label>
						</div>
						{mcpDraftError ? (
							<div className="mcp-draft-error">
								<Bug size={14} /> {mcpDraftError}
							</div>
						) : null}
						<div className="mcp-add-actions">
							<span>
								{mcpDraftScope === "project"
									? "Writes .omp/mcp.json"
									: "Writes the active profile's agent/mcp.json"}
							</span>
							<button
								type="button"
								className="settings-primary-button"
								disabled={!mcpDraftName.trim() || !mcpDraftEndpoint.trim() || isSavingPrefix("plugin:mcp:add:")}
								onClick={() => {
									try {
										const timeout = mcpDraftTimeout.trim() ? Number(mcpDraftTimeout) : undefined;
										if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0))
											throw new Error("Timeout must be zero or a positive number.");
										const values = parseMcpKeyValueLines(mcpDraftValues);
										const config: McpServerConfigInput =
											mcpDraftTransport === "stdio"
												? {
														type: "stdio",
														command: mcpDraftEndpoint.trim(),
														args: mcpDraftArgs
															.split(/\r?\n/)
															.map(value => value.trim())
															.filter(Boolean),
														...(Object.keys(values).length ? { env: values } : {}),
														...(timeout !== undefined ? { timeout } : {}),
													}
												: {
														type: mcpDraftTransport,
														url: mcpDraftEndpoint.trim(),
														...(Object.keys(values).length ? { headers: values } : {}),
														...(timeout !== undefined ? { timeout } : {}),
													};
										setMcpDraftError(null);
										props.onAddMcpServer(mcpDraftName.trim(), mcpDraftScope, config);
									} catch (error) {
										setMcpDraftError(error instanceof Error ? error.message : String(error));
									}
								}}
							>
								Add and connect
							</button>
						</div>
					</section>
				) : null}

				<section className="mcp-live-inventory" aria-label="Live MCP capability inventory">
					<div className="memory-section-heading">
						<div>
							<h3>Available to OMP right now</h3>
							<p>This is live runtime data, not only saved configuration.</p>
						</div>
						<span>{connectedCount} active</span>
					</div>
					<div className="mcp-live-inventory-grid">
						<div className={toolCount > 0 ? "is-available" : ""}>
							<Wrench size={16} />
							<strong>{toolCount}</strong>
							<span>Agent tools</span>
							<small>Callable by the current OMP session</small>
						</div>
						<div className={resourceCount + templateCount > 0 ? "is-available" : ""}>
							<Database size={16} />
							<strong>{resourceCount + templateCount}</strong>
							<span>Resources</span>
							<small>
								{resourceCount} direct · {templateCount} templates
							</small>
						</div>
						<div className={promptCount > 0 ? "is-available" : ""}>
							<Sparkles size={16} />
							<strong>{promptCount}</strong>
							<span>Server prompts</span>
							<small>Prompt templates reported over MCP</small>
						</div>
						<div className={props.mcpCapabilities?.notifications.enabled ? "is-available" : ""}>
							<Volume2 size={16} />
							<strong>{props.mcpCapabilities?.notifications.enabled ? "On" : "Off"}</strong>
							<span>Live updates</span>
							<small>Resource and tool change notifications</small>
						</div>
					</div>
				</section>

				<section className="mcp-server-section">
					<div className="memory-section-heading">
						<div>
							<h3>Manage servers</h3>
							<p>
								The server needing attention opens automatically. Actions below call the active OMP MCP manager.
							</p>
						</div>
						<span>{visibleServers.length} shown</span>
					</div>
					{visibleServers.length > 0 ? (
						<div className="mcp-server-list">
							{visibleServers.map(server => {
								const expanded = openMcpServer === server.name;
								const busy = props.savingKeys.some(
									key =>
										key === `plugin:mcp:${server.name}` ||
										(key.startsWith("plugin:mcp:") && key.endsWith(`:${server.name}`)),
								);
								const authRequired = server.auth.oauth && !server.auth.credentialAvailable;
								const statusLabel = !server.enabled
									? "Disabled"
									: server.status === "connected"
										? "Connected"
										: server.status === "connecting"
											? "Connecting"
											: authRequired
												? "Authorization required"
												: "Disconnected";
								const authLabel = server.auth.oauth
									? server.auth.credentialAvailable
										? "OAuth authorized"
										: "OAuth not authorized"
									: server.auth.configured
										? "Authentication configured"
										: "No managed authentication";
								const resourceGroup = props.mcpCapabilities?.resources.find(
									group => group.serverName === server.name,
								);
								const promptGroup = props.mcpCapabilities?.prompts.find(
									group => group.serverName === server.name,
								);
								const notificationGroup = props.mcpCapabilities?.notifications.servers.find(
									group => group.serverName === server.name,
								);
								const removable =
									server.source?.provider === "native" &&
									(server.source.level === "user" || server.source.level === "project");
								return (
									<article
										className={`mcp-server-card is-${server.enabled ? server.status : "disabled"}${expanded ? " is-selected" : ""}`}
										key={server.name}
									>
										<button
											type="button"
											className="mcp-server-summary"
											aria-expanded={expanded}
											onClick={() =>
												setOpenMcpServer(current => (current === server.name ? null : server.name))
											}
										>
											<span className="mcp-server-status-dot" />
											<span className="mcp-server-identity">
												<strong>{server.name}</strong>
												<small>
													{server.transport.toUpperCase()} ·{" "}
													{server.source?.providerName ?? "OMP configuration"} ·{" "}
													{server.source?.level ?? "unknown"} scope
												</small>
											</span>
											<span className={`mcp-server-state is-${server.enabled ? server.status : "disabled"}`}>
												{statusLabel}
											</span>
											<span className="mcp-server-tool-count">{server.toolCount} tools</span>
											<span className="mcp-server-manage">{expanded ? "Hide" : "Manage"}</span>
											{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
										</button>
										{expanded ? (
											<div className="mcp-server-details">
												<div className="mcp-server-facts">
													<div>
														<span>Transport</span>
														<strong>
															{server.transport === "sse"
																? "SSE (legacy)"
																: server.transport.toUpperCase()}
														</strong>
													</div>
													<div>
														<span>Authentication</span>
														<strong>{authLabel}</strong>
													</div>
													<div>
														<span>Configuration source</span>
														<strong>
															{server.source
																? `${server.source.providerName} · ${server.source.level}`
																: "Runtime registration"}
														</strong>
													</div>
												</div>
												{server.lastError ? (
													<div className="mcp-server-error">
														<Bug size={15} />
														<div>
															<strong>Connection error</strong>
															<span>{server.lastError}</span>
														</div>
													</div>
												) : null}
												<div className="mcp-mounted-tools">
													<strong>Tools currently mounted in OMP</strong>
													{server.toolNames.length > 0 ? (
														<div>
															{server.toolNames.map(name => (
																<code key={name}>{name}</code>
															))}
														</div>
													) : (
														<span>
															{server.status === "connected"
																? "The server reported no tools."
																: "No tools are mounted while this server is unavailable."}
														</span>
													)}
												</div>
												<div className="mcp-capability-grid">
													<div>
														<strong>Resources</strong>
														<span>
															{resourceGroup?.resources.length ?? 0} resources Â·{" "}
															{resourceGroup?.templates.length ?? 0} templates
														</span>
														{resourceGroup?.resources.slice(0, 4).map(resource => (
															<code key={resource.uri}>{resource.name || resource.uri}</code>
														))}
													</div>
													<div>
														<strong>Prompts</strong>
														<span>{promptGroup?.prompts.length ?? 0} prompts reported</span>
														{promptGroup?.prompts.slice(0, 4).map(prompt => (
															<code key={prompt.name}>
																/{server.name}:{prompt.name}
															</code>
														))}
													</div>
													<div>
														<strong>Notifications</strong>
														<span>
															{notificationGroup
																? [
																		notificationGroup.toolsChanged && "tools",
																		notificationGroup.resourcesChanged && "resources",
																		notificationGroup.promptsChanged && "prompts",
																	]
																		.filter(Boolean)
																		.join(", ") || "No change notifications"
																: "Unavailable while disconnected"}
														</span>
														{notificationGroup?.resourceSubscriptions.map(uri => (
															<code key={uri}>{uri}</code>
														))}
													</div>
												</div>
												<div className="mcp-server-actions">
													<button
														type="button"
														disabled={busy}
														onClick={() => props.onTestMcpServer(server.name)}
													>
														<Check size={13} /> Test connection
													</button>
													{server.enabled && server.status !== "connecting" ? (
														<button
															type="button"
															disabled={busy}
															onClick={() => props.onReconnectMcp(server.name)}
														>
															<RefreshCw size={13} /> Reconnect
														</button>
													) : null}
													{server.auth.oauth ? (
														<button
															type="button"
															disabled={!server.enabled || busy}
															onClick={() => props.onReauthMcp(server.name)}
														>
															<KeyRound size={13} />{" "}
															{server.auth.credentialAvailable ? "Reauthorize" : "Authorize"}
														</button>
													) : null}
													{server.auth.oauth && server.auth.credentialAvailable ? (
														<button
															type="button"
															disabled={busy}
															onClick={() =>
																confirmAction({
																	title: `Sign out of ${server.name}?`,
																	message:
																		"The managed OAuth credential will be removed and the server will disconnect.",
																	confirmLabel: "Sign out",
																	onConfirm: () => props.onUnauthMcp(server.name),
																})
															}
														>
															Sign out
														</button>
													) : null}
													<button
														type="button"
														className={server.enabled ? "" : "settings-primary-button"}
														disabled={busy}
														onClick={() => props.onSetMcpEnabled(server.name, !server.enabled)}
													>
														{server.enabled ? "Disable server" : "Enable server"}
													</button>
													{removable ? (
														<button
															type="button"
															className="settings-danger-button"
															disabled={busy}
															onClick={() =>
																confirmAction({
																	title: `Remove ${server.name}?`,
																	message: `This removes the server from OMP's ${server.source?.level} configuration and reloads MCP discovery.`,
																	confirmLabel: "Remove server",
																	onConfirm: () =>
																		props.onRemoveMcpServer(
																			server.name,
																			server.source?.level as "user" | "project",
																		),
																})
															}
														>
															Remove server
														</button>
													) : null}
												</div>
											</div>
										) : null}
									</article>
								);
							})}
						</div>
					) : (
						<div className="mcp-empty-state">
							<PlugZap size={24} />
							<strong>
								{props.mcpServers.length === 0
									? "No server configuration was discovered"
									: "No servers match your search"}
							</strong>
							{props.mcpServers.length === 0 ? (
								<>
									<span>
										Add OMP-owned servers in .omp/mcp.json for this project or the active profile's
										agent/mcp.json.
									</span>
									<code>{`{ "mcpServers": { "name": { "command": "..." } } }`}</code>
								</>
							) : null}
						</div>
					)}
				</section>

				{mcpSettingPaths.length > 0 ? (
					<section className="settings-feature-advanced mcp-behavior">
						<button
							type="button"
							aria-expanded={showMcpBehavior}
							onClick={() => setShowMcpBehavior(value => !value)}
						>
							<span>
								<strong>Discovery & resource update behavior</strong>
								<small>Controls how OMP finds project servers and reacts to MCP resource notifications.</small>
							</span>
							{showMcpBehavior ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
						</button>
						{showMcpBehavior ? <div>{renderFriendlySettings(mcpSettingPaths, MCP_FRIENDLY_COPY)}</div> : null}
					</section>
				) : null}
			</div>
		);
	};
	const addHostTool = () => {
		const name = hostToolName.trim();
		if (!name || props.hostTools.some(tool => tool.name === name)) return;
		props.onHostToolsChange([
			...props.hostTools,
			{
				name,
				label: selectedHostAction.label,
				description: selectedHostAction.description,
				parameters: {
					type: "object",
					properties: { [selectedHostAction.argument]: { type: "string" } },
					required: [selectedHostAction.argument],
					additionalProperties: false,
				},
				loadMode: "discoverable",
				action: selectedHostAction.action,
				requiresApproval: true,
			},
		]);
	};
	const CategoryIcon = selectedCategory.icon;
	const confirmAction = (confirmation: PendingConfirmation) => {
		confirmationTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		setConfirmation(confirmation);
	};
	if (!props.open) return null;
	return (
		<div className="settings-layer">
			<div className="settings-backdrop" aria-hidden="true" onClick={props.onClose} />
			<section
				ref={panelRef}
				className="settings-panel"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				aria-describedby={descriptionId}
				tabIndex={-1}
			>
				<header className="settings-panel-head">
					<div className="settings-title-block">
						<span id={titleId} className="settings-title">
							<Settings2 size={18} /> Settings
						</span>
						<span id={descriptionId} className="settings-subtitle">
							Configure OMP for this workspace
						</span>
					</div>
					<div className="settings-head-actions">
						{latestFeedback ? (
							<span
								className={`settings-operation settings-operation--${latestFeedback.state}`}
								role={latestFeedback.state === "error" ? "alert" : "status"}
							>
								{latestFeedback.state === "saving"
									? (latestFeedback.message ?? "Saving…")
									: latestFeedback.state === "saved"
										? (latestFeedback.message ?? "Saved")
										: (latestFeedback.message ?? "Could not save")}
							</span>
						) : null}
						<button
							type="button"
							className="top-icon-button"
							disabled={props.loading}
							onClick={props.onRefresh}
							aria-label="Refresh settings"
						>
							<RefreshCw size={16} className={props.loading ? "settings-spin" : undefined} />
						</button>
						<button
							type="button"
							className="top-icon-button"
							onClick={props.onOpenDiagnostics}
							aria-label="Open diagnostics"
						>
							<Bug size={16} />
						</button>
						<button type="button" className="top-icon-button" onClick={props.onClose} aria-label="Close settings">
							<X size={16} />
						</button>
					</div>
				</header>
				<div className="settings-layout">
					<nav className="settings-nav" aria-label="Settings categories">
						<label className="settings-search">
							<Search size={15} aria-hidden="true" />
							<input
								ref={searchRef}
								type="search"
								value={query}
								onChange={event => setQuery(event.currentTarget.value)}
								placeholder="Search settings"
								aria-label="Search settings"
							/>
							{query ? (
								<button type="button" onClick={() => setQuery("")} aria-label="Clear settings search">
									<X size={13} />
								</button>
							) : null}
						</label>
						{(["Core", "Agent behavior", "Integrations"] as const).map(section => {
							const items = visibleCategories.filter(item => item.section === section);
							if (items.length === 0) return null;
							return (
								<div className="settings-nav-group" key={section}>
									<span>{section}</span>
									{items.map(item => {
										const Icon = item.icon;
										return (
											<button
												type="button"
												key={item.id}
												className={category === item.id ? "active" : ""}
												aria-current={category === item.id ? "page" : undefined}
												onClick={() => setCategory(item.id)}
											>
												<Icon size={15} aria-hidden="true" />
												{item.label}
											</button>
										);
									})}
								</div>
							);
						})}
						<div className="settings-nav-group settings-nav-advanced">
							<button
								type="button"
								className="settings-advanced-toggle"
								aria-expanded={showTechnicalDetails}
								onClick={() => setShowTechnicalDetails(value => !value)}
							>
								{showTechnicalDetails ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
								Advanced
							</button>
							{showTechnicalDetails || category === "tools"
								? visibleCategories
										.filter(item => item.section === "Advanced")
										.map(item => (
											<button
												type="button"
												key={item.id}
												className={category === item.id ? "active" : ""}
												aria-current={category === item.id ? "page" : undefined}
												onClick={() => setCategory(item.id)}
											>
												<Wrench size={15} /> {item.label}
											</button>
										))
								: null}
						</div>
						{props.loading && !props.snapshot ? (
							<div className="settings-loading" role="status">
								<RefreshCw size={20} className="settings-spin" aria-hidden="true" />
								<span>Loading configuration…</span>
							</div>
						) : normalizedQuery && visibleCategories.length === 0 ? (
							<div className="settings-nav-empty">No settings match “{query.trim()}”.</div>
						) : null}
					</nav>
					<div className="settings-content">
						<div className="settings-content-head">
							<div>
								<span className="settings-category-icon">
									<CategoryIcon size={17} />
								</span>
								<div>
									<h2>{selectedCategory.label}</h2>
									<p>{selectedCategory.description}</p>
								</div>
							</div>
						</div>
						{normalizedQuery && visibleCategories.length === 0 ? (
							<div className="settings-search-empty">
								<Search size={24} aria-hidden="true" />
								<strong>No matching settings</strong>
								<span>Try another name, description, integration, or configuration path.</span>
								<button type="button" onClick={() => setQuery("")}>
									Clear search
								</button>
							</div>
						) : category === "providers" ? (
							renderProviderDashboard()
						) : category === "retry" ? (
							renderRetryDashboard()
						) : category === "compaction" ? (
							renderCompactionDashboard()
						) : category === "memory" ? (
							renderMemoryDashboard()
						) : category === "plugins" ? (
							renderPluginsDashboard()
						) : category === "mcp" ? (
							renderMcpDashboard()
						) : category === "skills" ? (
							renderSkillsDashboard()
						) : category === "tools" ? (
							<>
								<div className="settings-config-row">
									<div className="settings-config-copy">
										<strong>Electron host registry</strong>
										<span>Expose explicit desktop actions to OMP through the host-tool bridge.</span>
										<code>Every action is validated; approval is enabled by default.</code>
									</div>
									<div className="settings-control settings-host-control">
										<select
											className="settings-select"
											aria-label="Desktop host action"
											value={hostAction}
											disabled={hostBusy}
											onChange={event => {
												const action = event.currentTarget.value as HostToolAction;
												setHostAction(action);
												const definition = HOST_ACTIONS.find(item => item.action === action);
												if (definition) setHostToolName(definition.defaultName);
											}}
										>
											{HOST_ACTIONS.map(item => (
												<option key={item.action} value={item.action}>
													{item.label}
												</option>
											))}
										</select>
										<input
											className="settings-input"
											aria-label="Host tool name"
											value={hostToolName}
											disabled={hostBusy}
											onChange={event => setHostToolName(event.currentTarget.value)}
											placeholder="Unique tool name"
										/>
										<button type="button" disabled={hostBusy || !hostToolName.trim()} onClick={addHostTool}>
											Register
										</button>
									</div>
								</div>
								{props.hostTools
									.filter(tool => matchesQuery(tool.name, tool.description, tool.action))
									.map(tool => (
										<div className="settings-config-row" key={tool.name}>
											<div className="settings-config-copy">
												<strong>{tool.name}</strong>
												<span>{tool.description}</span>
												<code>{tool.action}</code>
											</div>
											<div className="settings-control">
												<label>
													<input
														type="checkbox"
														checked={tool.requiresApproval}
														disabled={hostBusy}
														onChange={event =>
															props.onHostToolsChange(
																props.hostTools.map(item =>
																	item.name === tool.name
																		? { ...item, requiresApproval: event.currentTarget.checked }
																		: item,
																),
															)
														}
													/>
													Ask approval
												</label>
												<button
													type="button"
													disabled={hostBusy}
													onClick={() =>
														confirmAction({
															title: `Remove ${tool.name}?`,
															message: "OMP will no longer be able to invoke this desktop host action.",
															confirmLabel: "Remove host tool",
															onConfirm: () =>
																props.onHostToolsChange(
																	props.hostTools.filter(item => item.name !== tool.name),
																),
														})
													}
												>
													Remove
												</button>
											</div>
										</div>
									))}
								<div className="settings-config-row">
									<div className="settings-config-copy">
										<strong>workspace:// URI</strong>
										<span>Allow OMP read tools to resolve workspace files through the Electron host.</span>
										<code>Read-only; workspace containment and binary/size guards remain enforced.</code>
									</div>
									<div className="settings-control">
										<input
											type="checkbox"
											aria-label="Enable workspace URI access"
											checked={props.workspaceUriEnabled}
											disabled={hostBusy}
											onChange={event => props.onWorkspaceUriEnabledChange(event.currentTarget.checked)}
										/>
									</div>
								</div>
								{renderSettingRows()}
							</>
						) : (
							renderSettingRows()
						)}
						{props.loading && props.snapshot ? (
							<div className="settings-refreshing" role="status">
								<RefreshCw size={12} className="settings-spin" /> Refreshing…
							</div>
						) : null}
						{props.error ? (
							<div className="settings-validation-error settings-panel-error" role="alert">
								{props.error}
							</div>
						) : null}
						{!props.loading &&
						!props.error &&
						settings.length === 0 &&
						(category === "providers" || category === "retry" || category === "compaction") ? (
							<div className="settings-empty">No {category} settings were returned by the OMP core.</div>
						) : null}
					</div>
				</div>
				{confirmation ? (
					<div className="settings-confirm-layer">
						<div
							className="settings-confirm-dialog"
							role="alertdialog"
							aria-modal="true"
							aria-labelledby={`${titleId}-confirmation-title`}
							aria-describedby={`${titleId}-confirmation-message`}
						>
							<div className="settings-confirm-icon" aria-hidden="true">
								<ShieldCheck size={20} />
							</div>
							<h2 id={`${titleId}-confirmation-title`}>{confirmation.title}</h2>
							<p id={`${titleId}-confirmation-message`}>{confirmation.message}</p>
							<div className="settings-confirm-actions">
								<button type="button" autoFocus onClick={() => setConfirmation(null)}>
									Cancel
								</button>
								<button
									type="button"
									className="settings-danger-button settings-danger-button--solid"
									onClick={() => {
										confirmation.onConfirm();
										setConfirmation(null);
									}}
								>
									{confirmation.confirmLabel}
								</button>
							</div>
						</div>
					</div>
				) : null}
			</section>
		</div>
	);
}
