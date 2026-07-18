import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AppShell, type SessionInfo } from "./components/AppShell";
import type { AuthPrompt } from "./components/AuthDialog";
import type { BrowserActivity } from "./components/BrowserPanel";
import type { ComposerInjection } from "./components/Composer";
import { composePromptWithContext, type StagedContextItem } from "./components/ContextInspector";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel";
import type { WidgetEntry } from "./components/ExtensionWidgets";
import { HostApprovalDialog } from "./components/HostApprovalDialog";
import { SettingsPanel } from "./components/SettingsPanel";
import type { SideChatMessage } from "./components/SideChatPanel";
import type { Toast } from "./components/Toasts";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { WorktreeManager } from "./components/WorktreeManager";
import type { DiagnosticsSnapshot } from "./lib/desktop-bridge";
import {
	collectDiagnostics,
	exportDiagnosticsBundle,
	listScheduledTasks,
	onScheduledTasksChanged,
	onWorkspaceFilesChanged,
	openExternalUrl,
	openNewWindow,
	pickWorkspaceFolder,
	removeScheduledTask,
	revealItem,
	runScheduledTaskNow,
	sideEngineTransport,
	startWorkspaceWatcher,
	stopWorkspaceWatcher,
	upsertScheduledTask,
	writeClipboardText,
} from "./lib/desktop-bridge";
import {
	executeDesktopHostTool,
	hostResult,
	parseDesktopHostRegistry,
	resolveWorkspaceHostUri,
} from "./lib/host-registry";
import {
	appendStderr,
	appendUserMessage,
	engineInterrupted,
	initialViewModel,
	reduce,
	seedMessages,
	type ViewModel,
} from "./lib/reducer";
import { DesktopRpcClient, type EngineStatus, RpcError, RpcTransportError } from "./lib/rpc-client";
import type {
	ApprovalMode,
	ArtifactContent,
	AvailableCommand,
	BrowserTab,
	ContextBreakdown,
	ContextSnapshot,
	ContextUsage,
	DesktopHostToolConfig,
	EngineEvent,
	ExtensionError,
	ExtensionUIRequest,
	ExtensionUIResponse,
	GitStatus,
	GoalModeState,
	HostToolCallRequest,
	HostUriRequest,
	HunkSelection,
	ImageContent,
	LoginProvider,
	MarketplaceSnapshot,
	McpServerStatus,
	MemorySearchResult,
	MemoryStatus,
	ModelInfo,
	PlanModeState,
	RpcSettingCategory,
	RpcSettingsSnapshot,
	ScheduledTask,
	ScheduledTaskInput,
	SessionMessage,
	SessionStats,
	SessionSummary,
	SubagentMessagesSnapshot,
	SubagentSnapshot,
	ThinkingLevel,
	WorkspaceEntry,
	WorkspaceFileChange,
	WorkspaceFileContent,
	Worktree,
} from "./lib/rpc-protocol";
import { mergeSubagentTranscript } from "./lib/subagent-transcript";
import { checkForUpdate, installUpdate, type UpdateHandle, type UpdateInfo } from "./lib/updater";

type Action =
	| { kind: "event"; event: EngineEvent }
	| { kind: "user"; text: string; images?: ImageContent[] }
	| { kind: "streaming"; value: boolean }
	| { kind: "stderr"; line: string }
	| { kind: "seed"; messages: SessionMessage[] }
	| { kind: "interrupted"; reason: string }
	| { kind: "reset" };

function rootReducer(state: ViewModel, action: Action): ViewModel {
	switch (action.kind) {
		case "event":
			return reduce(state, action.event);
		case "user":
			return appendUserMessage(state, action.text, action.images);
		case "streaming":
			// Optimistic streaming flag: flipped on send so the UI shows the agent is
			// working before the engine's `agent_start` arrives. `agent_start`/`agent_end`
			// (and `interrupted`) remain the source of truth afterwards.
			return state.streaming === action.value ? state : { ...state, streaming: action.value };
		case "stderr":
			return appendStderr(state, action.line);
		case "seed":
			return seedMessages(action.messages);
		case "interrupted":
			return engineInterrupted(state, action.reason);
		case "reset":
			return initialViewModel;
	}
}

const EMPTY_SESSION: SessionInfo = { messageCount: 0 };
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const LAST_WORKSPACE_KEY = "omp.desktop.lastWorkspace";

function loadLastWorkspace(): string | null {
	try {
		return window.localStorage.getItem(LAST_WORKSPACE_KEY);
	} catch {
		return null;
	}
}

function saveLastWorkspace(workspace: string): void {
	try {
		window.localStorage.setItem(LAST_WORKSPACE_KEY, workspace);
	} catch {
		return;
	}
}

function modelLabel(provider?: string, id?: string): string | undefined {
	if (!id) return undefined;
	return provider ? `${provider}/${id}` : id;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				typeof part === "object" &&
				part !== null &&
				"type" in part &&
				part.type === "text" &&
				"text" in part &&
				typeof part.text === "string",
		)
		.map(part => part.text)
		.join("");
}

/** Events after which session metadata (model/thinking/name/count) may have changed. */
const REFRESH_EVENTS = new Set(["agent_end", "auto_compaction_end", "thinking_level_changed", "goal_updated"]);

export function App() {
	const [workspace, setWorkspace] = useState<string | null>(() => loadLastWorkspace());
	const [vm, dispatch] = useReducer(rootReducer, initialViewModel);
	const [status, setStatus] = useState<EngineStatus>("idle");
	const [statusDetail, setStatusDetail] = useState<string | undefined>();
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [session, setSession] = useState<SessionInfo>(EMPTY_SESSION);
	const [subagents, setSubagents] = useState<SubagentSnapshot[]>([]);
	const [selectedSubagent, setSelectedSubagent] = useState<SubagentSnapshot | null>(null);
	const [subagentTranscript, setSubagentTranscript] = useState<SubagentMessagesSnapshot | null>(null);
	const [subagentTranscriptLoading, setSubagentTranscriptLoading] = useState(false);
	const [subagentArtifact, setSubagentArtifact] = useState<ArtifactContent | null>(null);
	const [subagentArtifactLoading, setSubagentArtifactLoading] = useState(false);
	const selectedSubagentRef = useRef<SubagentSnapshot | null>(null);
	const subagentTranscriptRef = useRef<SubagentMessagesSnapshot | null>(null);
	selectedSubagentRef.current = selectedSubagent;
	subagentTranscriptRef.current = subagentTranscript;
	const [dialogQueue, setDialogQueue] = useState<ExtensionUIRequest[]>([]);
	const [toasts, setToasts] = useState<Toast[]>([]);
	const [loginProviders, setLoginProviders] = useState<LoginProvider[]>([]);
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [historyLoading, setHistoryLoading] = useState(false);
	// True from the instant a history session is clicked until its messages are
	// seeded. Drives an immediate "opening…" indicator so the switch never looks
	// frozen while the engine tears down the in-flight turn (serial RPC dispatch).
	const [switching, setSwitching] = useState(false);
	// True from the instant Stop is clicked until the turn actually ends. The
	// engine's `abort` awaits the in-flight turn tearing down (`waitForIdle`), so
	// without this the Stop button sits unchanged for seconds and invites repeat
	// clicks. Reset below when streaming clears (agent_end or engine-stopped).
	const [aborting, setAborting] = useState(false);
	const [changes, setChanges] = useState<WorkspaceFileChange[]>([]);
	const [gitStatus, setGitStatus] = useState<GitStatus>({ branch: null, staged: 0, unstaged: 0, untracked: 0 });
	const [worktrees, setWorktrees] = useState<Worktree[]>([]);
	const [worktreeManagerOpen, setWorktreeManagerOpen] = useState(false);
	const [worktreesLoading, setWorktreesLoading] = useState(false);
	const [worktreeMutatingPath, setWorktreeMutatingPath] = useState<string | null>(null);
	const [workspaceEntries, setWorkspaceEntries] = useState<WorkspaceEntry[]>([]);
	const [workspaceFileContent, setWorkspaceFileContent] = useState<WorkspaceFileContent | null>(null);
	const [selectedWorkspacePath, setSelectedWorkspacePath] = useState<string | null>(null);
	const selectedWorkspacePathRef = useRef<string | null>(null);
	selectedWorkspacePathRef.current = selectedWorkspacePath;
	const [workspaceFilesLoading, setWorkspaceFilesLoading] = useState(false);
	const [workspaceFilesTruncated, setWorkspaceFilesTruncated] = useState(false);
	const [contextItems, setContextItems] = useState<StagedContextItem[]>([]);
	const [contextImages, setContextImages] = useState<ImageContent[]>([]);
	const [contextSkills, setContextSkills] = useState<string[]>([]);
	const [contextSkillDetails, setContextSkillDetails] = useState<ContextSnapshot["skillDetails"]>([]);
	const [contextSkillWarnings, setContextSkillWarnings] = useState<ContextSnapshot["skillWarnings"]>([]);
	const [contextMemoryBackend, setContextMemoryBackend] = useState<string | null>(null);
	const [contextUsage, setContextUsage] = useState<ContextUsage | undefined>();
	const [contextBreakdown, setContextBreakdown] = useState<ContextBreakdown | undefined>();
	const [browserUrl, setBrowserUrl] = useState("");
	const [browserSnapshot, setBrowserSnapshot] = useState("");
	const [browserBusy, setBrowserBusy] = useState(false);
	const [browserTabs, setBrowserTabs] = useState<BrowserTab[]>([]);
	const [browserActiveTab, setBrowserActiveTab] = useState("main");
	const [browserActivity, setBrowserActivity] = useState<BrowserActivity[]>([]);
	const [browserDownloadPolicy, setBrowserDownloadPolicy] = useState<"deny">("deny");
	const [sideChatReady, setSideChatReady] = useState(false);
	const [sideChatStarting, setSideChatStarting] = useState(false);
	const [sideChatMessages, setSideChatMessages] = useState<SideChatMessage[]>([]);
	const [sideChatWorktreePath, setSideChatWorktreePath] = useState<string | null>(null);
	const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([]);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [settingsCategory, setSettingsCategory] = useState<RpcSettingCategory>("providers");
	const [settingsSnapshot, setSettingsSnapshot] = useState<RpcSettingsSnapshot | null>(null);
	const [settingsLoading, setSettingsLoading] = useState(false);
	const [settingsError, setSettingsError] = useState<string | null>(null);
	const [savingSetting, setSavingSetting] = useState<string | null>(null);
	const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
	const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null);
	const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
	const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
	const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([]);
	const [marketplace, setMarketplace] = useState<MarketplaceSnapshot | null>(null);
	const [marketplaceError, setMarketplaceError] = useState<string | null>(null);
	const [memoryStatus, setMemoryStatus] = useState<MemoryStatus | null>(null);
	const [memorySearch, setMemorySearch] = useState<MemorySearchResult | null>(null);
	const [hostTools, setHostTools] = useState<DesktopHostToolConfig[]>(() => {
		try {
			return parseDesktopHostRegistry(JSON.parse(localStorage.getItem("omp.desktop.host-registry.v1") ?? "null"))
				.tools;
		} catch {
			return [];
		}
	});
	const [workspaceUriEnabled, setWorkspaceUriEnabled] = useState(() => {
		try {
			return parseDesktopHostRegistry(JSON.parse(localStorage.getItem("omp.desktop.host-registry.v1") ?? "null"))
				.workspaceUriEnabled;
		} catch {
			return false;
		}
	});
	const [hostApprovals, setHostApprovals] = useState<HostToolCallRequest[]>([]);
	const [availableCommands, setAvailableCommands] = useState<AvailableCommand[]>([]);
	const [update, setUpdate] = useState<{ info: UpdateInfo; update: UpdateHandle } | null>(null);
	const [updateInstalling, setUpdateInstalling] = useState(false);
	const [injection, setInjection] = useState<ComposerInjection | undefined>();
	const [authPrompt, setAuthPrompt] = useState<AuthPrompt | null>(null);
	const [statuses, setStatuses] = useState<Record<string, string>>({});
	const [widgets, setWidgets] = useState<Record<string, WidgetEntry>>({});
	const [docTitle, setDocTitle] = useState<string | undefined>();
	const [planMode, setPlanMode] = useState<PlanModeState | undefined>();
	const [goalMode, setGoalMode] = useState<GoalModeState | undefined>();
	// Mirror of planMode read synchronously in the optimistic toggle, so a failed
	// `set_plan_mode` reverts to the exact prior snapshot without a stale closure.
	const planModeRef = useRef<PlanModeState | undefined>(undefined);
	planModeRef.current = planMode;
	const clientRef = useRef<DesktopRpcClient | null>(null);
	const sideClientRef = useRef<DesktopRpcClient | null>(null);
	const injectNonce = useRef(0);
	const loginProviderRef = useRef<string | undefined>(undefined);
	// Latest workspace the engine should boot against. Set imperatively before the
	// boot effect runs so the (once-only) engine start reads the correct directory
	// without re-subscribing on every project switch.
	const workspaceRef = useRef<string | null>(workspace);
	// Set while the app intentionally reaps the engine (unmount / update install) so
	// the in-flight requests it rejects don't surface as "Login failed" style toasts.
	const userStoppingRef = useRef(false);
	const hostToolsRef = useRef<DesktopHostToolConfig[]>([]);
	const workspaceUriEnabledRef = useRef(false);
	const hostApprovalResolversRef = useRef(new Map<string, (approved: boolean) => void>());
	const hostControllersRef = useRef(new Map<string, AbortController>());
	hostToolsRef.current = hostTools;
	workspaceUriEnabledRef.current = workspaceUriEnabled;

	useEffect(() => {
		localStorage.setItem("omp.desktop.host-registry.v1", JSON.stringify({ tools: hostTools, workspaceUriEnabled }));
	}, [hostTools, workspaceUriEnabled]);

	useEffect(() => {
		return () => {
			const client = sideClientRef.current;
			sideClientRef.current = null;
			if (client) void client.stop();
		};
	}, [workspace]);

	useEffect(() => {
		return () => {
			for (const controller of hostControllersRef.current.values()) controller.abort();
			for (const resolve of hostApprovalResolversRef.current.values()) resolve(false);
			hostControllersRef.current.clear();
			hostApprovalResolversRef.current.clear();
		};
	}, []);

	const refreshState = useCallback(async () => {
		const client = clientRef.current;
		if (!client) return;
		try {
			const state = await client.getState();
			setSession({
				model: modelLabel(state.model?.provider, state.model?.id),
				thinkingLevel: state.configuredThinkingLevel ?? state.thinkingLevel,
				sessionName: state.sessionName,
				messageCount: state.messageCount,
				approvalMode: state.approvalMode,
				steeringMode: state.steeringMode,
				followUpMode: state.followUpMode,
				interruptMode: state.interruptMode,
				autoCompactionEnabled: state.autoCompactionEnabled,
				autoRetryEnabled: state.autoRetryEnabled,
				queuedMessageCount: state.queuedMessageCount,
			});
			setPlanMode(state.planMode);
			setGoalMode(state.goalMode);
			setContextUsage(state.contextUsage);
			setContextBreakdown(state.contextBreakdown);
		} catch {
			// transient; ignore
		}
	}, []);

	const refreshSubagents = useCallback(async () => {
		const client = clientRef.current;
		if (!client) return;
		try {
			setSubagents(await client.getSubagents());
		} catch {
			// transient; ignore
		}
	}, []);

	const refreshSelectedSubagentTranscript = useCallback(async () => {
		const client = clientRef.current;
		const agent = selectedSubagentRef.current;
		if (!client || !agent) return;
		const current = subagentTranscriptRef.current;
		try {
			const next = await client.getSubagentMessages({
				subagentId: agent.id,
				...(current ? { fromByte: current.nextByte } : {}),
			});
			setSubagentTranscript(previous => mergeSubagentTranscript(previous, next));
		} catch (error) {
			dispatch({
				kind: "stderr",
				line: `subagent transcript refresh: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}, []);

	const refreshLoginProviders = useCallback(async () => {
		const client = clientRef.current;
		if (!client) return;
		try {
			setLoginProviders(await client.getLoginProviders());
		} catch {
			// transient; ignore
		}
	}, []);

	const refreshSessions = useCallback(async () => {
		const client = clientRef.current;
		if (!client) return;
		setHistoryLoading(true);
		try {
			setSessions(await client.listSessions());
		} catch {
			// transient; ignore
		} finally {
			setHistoryLoading(false);
		}
	}, []);

	const refreshWorkspaceDiff = useCallback(async () => {
		const client = clientRef.current;
		if (!client) return;
		try {
			setChanges(await client.getWorkspaceDiff());
		} catch {
			// transient; ignore
		}
	}, []);

	const refreshGitStatus = useCallback(async () => {
		const client = clientRef.current;
		if (!client) return;
		try {
			setGitStatus(await client.getGitStatus());
		} catch {
			setGitStatus({ branch: null, staged: 0, unstaged: 0, untracked: 0 });
		}
	}, []);

	const refreshWorkspaceFiles = useCallback(async (query?: string) => {
		const client = clientRef.current;
		if (!client) return;
		setWorkspaceFilesLoading(true);
		try {
			const result = await client.listWorkspaceFiles(query);
			setWorkspaceEntries(result.entries);
			setWorkspaceFilesTruncated(result.truncated);
		} catch (err) {
			dispatch({ kind: "stderr", line: `files: ${err instanceof Error ? err.message : String(err)}` });
		} finally {
			setWorkspaceFilesLoading(false);
		}
	}, []);

	useEffect(() => {
		if (!workspace) return;
		let disposed = false;
		let unlisten: () => void = () => {};
		void onWorkspaceFilesChanged(change => {
			if (disposed) return;
			void refreshWorkspaceFiles();
			void refreshWorkspaceDiff();
			void refreshGitStatus();
			const selected = selectedWorkspacePathRef.current;
			if (selected && (change.paths.length === 0 || change.paths.includes(selected))) {
				void clientRef.current
					?.readWorkspaceFile(selected)
					.then(setWorkspaceFileContent)
					.catch(() => setWorkspaceFileContent(null));
			}
		}).then(remove => {
			if (disposed) remove();
			else unlisten = remove;
		});
		void startWorkspaceWatcher(workspace).catch(error => {
			if (!disposed)
				dispatch({
					kind: "stderr",
					line: `file watcher: ${error instanceof Error ? error.message : String(error)}`,
				});
		});
		return () => {
			disposed = true;
			unlisten();
			void stopWorkspaceWatcher();
		};
	}, [workspace, refreshWorkspaceDiff, refreshGitStatus, refreshWorkspaceFiles]);

	const openWorkspaceFile = useCallback(async (filePath: string) => {
		const client = clientRef.current;
		if (!client) return;
		setSelectedWorkspacePath(filePath);
		try {
			setWorkspaceFileContent(await client.readWorkspaceFile(filePath));
		} catch (err) {
			dispatch({ kind: "stderr", line: `file preview: ${err instanceof Error ? err.message : String(err)}` });
		}
	}, []);

	const addWorkspaceContext = useCallback((filePath: string, selection?: string) => {
		setContextItems(items => {
			const id = `${filePath}:${selection ? "selection" : "file"}`;
			if (items.some(item => item.id === id)) return items;
			return [...items, { id, path: filePath, kind: selection ? "selection" : "file", content: selection }];
		});
	}, []);

	const runBrowser = useCallback(
		async (
			label: string,
			operation: (client: DesktopRpcClient) => Promise<unknown>,
			onResult: (value: unknown) => void,
		) => {
			const client = clientRef.current;
			if (!client) return;
			const activityId = `browser-ui-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			setBrowserActivity(items => [...items, { id: activityId, label, status: "running", timestamp: Date.now() }]);
			setBrowserBusy(true);
			try {
				onResult(await operation(client));
				setBrowserActivity(items =>
					items.map(item => (item.id === activityId ? { ...item, status: "done", timestamp: Date.now() } : item)),
				);
			} catch (err) {
				setBrowserActivity(items =>
					items.map(item => (item.id === activityId ? { ...item, status: "error", timestamp: Date.now() } : item)),
				);
				dispatch({ kind: "stderr", line: `browser: ${err instanceof Error ? err.message : String(err)}` });
			} finally {
				setBrowserBusy(false);
			}
		},
		[],
	);
	const refreshBrowserTabs = useCallback(async () => {
		const client = clientRef.current;
		if (!client) return;
		try {
			const state = await client.browserState();
			setBrowserTabs(state.tabs);
			setBrowserDownloadPolicy(state.downloadPolicy);
		} catch (err) {
			dispatch({ kind: "stderr", line: `browser tabs: ${err instanceof Error ? err.message : String(err)}` });
		}
	}, []);

	const browserNavigate = useCallback(
		(url: string) =>
			void runBrowser(
				`Navigate ${url}`,
				client =>
					browserTabs.some(tab => tab.name === browserActiveTab)
						? client.browserNavigate(url, browserActiveTab)
						: client.browserOpen(url, browserActiveTab),
				value => {
					const result = value as { url?: string; text?: string };
					setBrowserUrl(result.url ?? url);
					setBrowserSnapshot(result.text ?? "");
					void refreshBrowserTabs();
				},
			),
		[runBrowser, browserTabs, browserActiveTab, refreshBrowserTabs],
	);
	const browserHistory = useCallback(
		(direction: "back" | "forward" | "reload") =>
			void runBrowser(
				`${direction} ${browserActiveTab}`,
				client => client.browserHistory(direction, browserActiveTab),
				value => {
					const result = value as { url?: string; text?: string };
					setBrowserUrl(result.url ?? browserUrl);
					setBrowserSnapshot(result.text ?? "");
				},
			),
		[runBrowser, browserUrl, browserActiveTab],
	);
	const browserSnapshotRefresh = useCallback(
		() =>
			void runBrowser(
				`Snapshot ${browserActiveTab}`,
				client => client.browserSnapshot(browserActiveTab),
				value => {
					const result = value as { url?: string; snapshot?: string };
					setBrowserUrl(result.url ?? browserUrl);
					setBrowserSnapshot(result.snapshot ?? "");
				},
			),
		[runBrowser, browserUrl, browserActiveTab],
	);
	const newBrowserTab = useCallback(() => {
		setBrowserActiveTab(`tab-${Date.now()}`);
		setBrowserUrl("");
		setBrowserSnapshot("");
	}, []);
	const selectBrowserTab = useCallback((tab: BrowserTab) => {
		setBrowserActiveTab(tab.name);
		setBrowserUrl(tab.url);
		setBrowserSnapshot("");
	}, []);
	const closeBrowserTab = useCallback(
		(name: string) => {
			const client = clientRef.current;
			if (!client) return;
			void client
				.browserClose(name)
				.then(async () => {
					if (name === browserActiveTab) {
						setBrowserActiveTab("main");
						setBrowserUrl("");
						setBrowserSnapshot("");
					}
					await refreshBrowserTabs();
				})
				.catch(err =>
					dispatch({ kind: "stderr", line: `browser close: ${err instanceof Error ? err.message : String(err)}` }),
				);
		},
		[browserActiveTab, refreshBrowserTabs],
	);

	const refreshSettings = useCallback(async () => {
		const client = clientRef.current;
		if (!client) return;
		setSettingsLoading(true);
		try {
			setSettingsSnapshot(await client.getSettings());
			setSettingsError(null);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setSettingsError(message);
			dispatch({ kind: "stderr", line: `settings: ${message}` });
		} finally {
			setSettingsLoading(false);
		}
	}, []);
	const saveSetting = useCallback(
		async (path: string, value: unknown) => {
			const client = clientRef.current;
			if (!client) return;
			setSavingSetting(path);
			try {
				await client.setSetting(path, value);
				await refreshSettings();
			} catch (err) {
				dispatch({ kind: "stderr", line: `setting ${path}: ${err instanceof Error ? err.message : String(err)}` });
			} finally {
				setSavingSetting(null);
			}
		},
		[refreshSettings],
	);
	const runPluginAction = useCallback(
		async (key: string, action: (client: DesktopRpcClient) => Promise<unknown>) => {
			const client = clientRef.current;
			if (!client) return;
			setSavingSetting(`plugin:${key}`);
			try {
				await action(client);
				await refreshSettings();
			} catch (err) {
				dispatch({ kind: "stderr", line: `plugin ${key}: ${err instanceof Error ? err.message : String(err)}` });
			} finally {
				setSavingSetting(null);
			}
		},
		[refreshSettings],
	);
	const refreshMarketplace = useCallback(async () => {
		const client = clientRef.current;
		if (!client) return;
		try {
			setMarketplace(await client.getMarketplace());
			setMarketplaceError(null);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setMarketplaceError(message);
			dispatch({ kind: "stderr", line: `marketplace: ${message}` });
		}
	}, []);
	const runMarketplaceAction = useCallback(
		async (key: string, action: (client: DesktopRpcClient) => Promise<MarketplaceSnapshot>) => {
			const client = clientRef.current;
			if (!client) return;
			setSavingSetting(`marketplace:${key}`);
			setMarketplaceError(null);
			try {
				setMarketplace(await action(client));
				await refreshSettings();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				setMarketplaceError(message);
				dispatch({
					kind: "stderr",
					line: `marketplace ${key}: ${message}`,
				});
			} finally {
				setSavingSetting(null);
			}
		},
		[refreshSettings],
	);
	const refreshMcp = useCallback(async () => {
		const client = clientRef.current;
		if (client) setMcpServers(await client.getMcpStatus().catch(() => []));
	}, []);
	const refreshMemory = useCallback(async () => {
		const client = clientRef.current;
		if (client) setMemoryStatus(await client.getMemoryStatus().catch(() => null));
	}, []);
	const searchMemory = useCallback(async (query: string) => {
		const client = clientRef.current;
		if (client) setMemorySearch(await client.searchMemory(query).catch(() => null));
	}, []);
	const runMemoryAction = useCallback(
		async (key: string, action: (client: DesktopRpcClient) => Promise<unknown>) => {
			const client = clientRef.current;
			if (!client) return;
			setSavingSetting(`memory:${key}`);
			try {
				await action(client);
				await refreshMemory();
			} catch (err) {
				dispatch({ kind: "stderr", line: `memory ${key}: ${err instanceof Error ? err.message : String(err)}` });
			} finally {
				setSavingSetting(null);
			}
		},
		[refreshMemory],
	);

	const refreshContextSnapshot = useCallback(async () => {
		const client = clientRef.current;
		if (!client) return;
		try {
			const snapshot = await client.getContextSnapshot();
			setContextSkills(snapshot.skills);
			setContextSkillDetails(snapshot.skillDetails);
			setContextSkillWarnings(snapshot.skillWarnings);
			setContextMemoryBackend(snapshot.memoryBackend);
		} catch {
			setContextSkills([]);
			setContextSkillDetails([]);
			setContextSkillWarnings([]);
			setContextMemoryBackend(null);
		}
	}, []);

	const runSkillAction = useCallback(
		async (key: string, action: (client: DesktopRpcClient) => Promise<unknown>) => {
			const client = clientRef.current;
			if (!client) return;
			setSavingSetting(`skill:${key}`);
			try {
				await action(client);
				await Promise.all([refreshSettings(), refreshContextSnapshot()]);
			} catch (err) {
				dispatch({ kind: "stderr", line: `skill ${key}: ${err instanceof Error ? err.message : String(err)}` });
			} finally {
				setSavingSetting(null);
			}
		},
		[refreshSettings, refreshContextSnapshot],
	);

	const dismissToast = useCallback((id: string) => {
		setToasts(list => list.filter(toast => toast.id !== id));
	}, []);

	const addToast = useCallback((message: string, type: Toast["type"]) => {
		const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2)}`;
		setToasts(list => [...list, { id, message, type }]);
		setTimeout(() => setToasts(list => list.filter(toast => toast.id !== id)), 6000);
	}, []);

	const openSubagentTranscript = useCallback(
		async (agent: SubagentSnapshot) => {
			setSelectedSubagent(agent);
			setSubagentTranscript(null);
			setSubagentArtifact(null);
			setSubagentTranscriptLoading(true);
			try {
				const client = clientRef.current;
				if (!client) throw new Error("Engine is not ready");
				setSubagentTranscript(await client.getSubagentMessages({ subagentId: agent.id }));
			} catch (error) {
				addToast(`Subagent transcript failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				setSubagentTranscriptLoading(false);
			}
		},
		[addToast],
	);

	const closeSubagentTranscript = useCallback(() => {
		setSelectedSubagent(null);
		setSubagentTranscript(null);
		setSubagentArtifact(null);
	}, []);

	const openSubagentArtifact = useCallback(
		async (artifactId: string) => {
			setSubagentArtifact(null);
			setSubagentArtifactLoading(true);
			try {
				const client = clientRef.current;
				if (!client) throw new Error("Engine is not ready");
				setSubagentArtifact(await client.readArtifact(artifactId));
			} catch (error) {
				addToast(`Artifact preview failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				setSubagentArtifactLoading(false);
			}
		},
		[addToast],
	);

	const handleExtensionUI = useCallback(
		(request: ExtensionUIRequest) => {
			switch (request.method) {
				case "select":
				case "confirm":
				case "input":
				case "editor":
					setDialogQueue(queue => [...queue, request]);
					return;
				case "cancel":
					setDialogQueue(queue => queue.filter(dialog => dialog.id !== request.targetId));
					return;
				case "notify":
					addToast(request.message, request.notifyType ?? "info");
					return;
				case "open_url":
					// Surface a persistent, actionable dialog (URL + open/copy) so login is
					// usable and debuggable even if the auto-open below fails silently.
					setAuthPrompt({
						provider: loginProviderRef.current,
						url: request.url,
						copyUrl: request.launchUrl,
						instructions: request.instructions,
					});
					void openExternalUrl(request.url).catch(() => {});
					return;
				case "set_editor_text":
					injectNonce.current += 1;
					setInjection({ text: request.text, nonce: injectNonce.current });
					return;
				case "setStatus":
					setStatuses(prev => {
						const next = { ...prev };
						if (!request.statusText) delete next[request.statusKey];
						else next[request.statusKey] = request.statusText;
						return next;
					});
					return;
				case "setWidget":
					setWidgets(prev => {
						const next = { ...prev };
						if (request.widgetLines === undefined) delete next[request.widgetKey];
						else
							next[request.widgetKey] = {
								lines: request.widgetLines,
								placement: request.widgetPlacement ?? "aboveEditor",
							};
						return next;
					});
					return;
				case "setTitle":
					setDocTitle(request.title);
					return;
				default:
					// Unknown/unsupported method — ignore.
					return;
			}
		},
		[addToast],
	);

	const handleExtensionError = useCallback(
		(error: ExtensionError) => {
			const extensionName = error.extensionPath?.split(/[\\/]/).at(-1);
			const source = extensionName ? ` (${extensionName})` : "";
			addToast(`Extension error${source}: ${error.error}`, "error");
			dispatch({ kind: "stderr", line: `extension_error${source}: ${error.error}` });
		},
		[addToast],
	);

	const requestHostApproval = useCallback((request: HostToolCallRequest): Promise<boolean> => {
		const { promise, resolve } = Promise.withResolvers<boolean>();
		hostApprovalResolversRef.current.set(request.id, resolve);
		setHostApprovals(queue => [...queue, request]);
		return promise;
	}, []);

	const decideHostApproval = useCallback((requestId: string, approved: boolean) => {
		const resolve = hostApprovalResolversRef.current.get(requestId);
		hostApprovalResolversRef.current.delete(requestId);
		setHostApprovals(queue => queue.filter(request => request.id !== requestId));
		resolve?.(approved);
	}, []);

	const executeHostToolCall = useCallback(
		async (client: DesktopRpcClient, request: HostToolCallRequest): Promise<void> => {
			const config = hostToolsRef.current.find(tool => tool.name === request.toolName);
			if (!config) {
				await client.sendHostToolResult(
					request.id,
					hostResult(`Unknown desktop host tool: ${request.toolName}`, true),
					true,
				);
				return;
			}

			const controller = new AbortController();
			hostControllersRef.current.set(request.id, controller);
			try {
				if (config.requiresApproval && !(await requestHostApproval(request))) {
					throw new Error(`Host tool "${request.toolName}" was denied`);
				}
				if (controller.signal.aborted) throw new Error(`Host tool "${request.toolName}" was cancelled`);

				const result = await executeDesktopHostTool(config, request, {
					openExternalUrl,
					revealItem,
					writeClipboardText,
					readWorkspaceFile: path => client.readWorkspaceFile(path),
				});
				await client.sendHostToolResult(request.id, result);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await client.sendHostToolResult(request.id, hostResult(message, true), true).catch(() => {});
			} finally {
				hostControllersRef.current.delete(request.id);
				hostApprovalResolversRef.current.delete(request.id);
				setHostApprovals(queue => queue.filter(item => item.id !== request.id));
			}
		},
		[requestHostApproval],
	);

	const handleHostToolCall = useCallback(
		(request: HostToolCallRequest) => {
			const client = clientRef.current;
			return client ? executeHostToolCall(client, request) : Promise.resolve();
		},
		[executeHostToolCall],
	);

	const handleHostToolCancel = useCallback(
		(targetId: string) => {
			hostControllersRef.current.get(targetId)?.abort();
			decideHostApproval(targetId, false);
		},
		[decideHostApproval],
	);

	const resolveHostUriForClient = useCallback(
		async (client: DesktopRpcClient, request: HostUriRequest): Promise<void> => {
			try {
				if (!workspaceUriEnabledRef.current) throw new Error("workspace:// is not enabled in Desktop settings");
				const result = await resolveWorkspaceHostUri(request, path => client.readWorkspaceFile(path));
				await client.sendHostUriResult(request.id, result);
			} catch (error) {
				await client
					.sendHostUriResult(request.id, {
						isError: true,
						error: error instanceof Error ? error.message : String(error),
					})
					.catch(() => {});
			}
		},
		[],
	);

	const handleHostUriRequest = useCallback(
		(request: HostUriRequest) => {
			const client = clientRef.current;
			return client ? resolveHostUriForClient(client, request) : Promise.resolve();
		},
		[resolveHostUriForClient],
	);

	const syncHostRegistry = useCallback(async (nextTools: DesktopHostToolConfig[], enableWorkspaceUri: boolean) => {
		const client = clientRef.current;
		if (!client) return;
		const definitions = nextTools.map(
			({ action: _action, requiresApproval: _requiresApproval, ...definition }) => definition,
		);
		await client.setHostTools(definitions);
		await client.setHostUriSchemes(
			enableWorkspaceUri
				? [{ scheme: "workspace", description: "Read workspace files through the Electron host", immutable: false }]
				: [],
		);
	}, []);

	const updateHostTools = useCallback(
		(nextTools: DesktopHostToolConfig[]) => {
			setHostTools(nextTools);
			hostToolsRef.current = nextTools;
			void syncHostRegistry(nextTools, workspaceUriEnabledRef.current).catch(error =>
				addToast(`Host registry failed: ${error instanceof Error ? error.message : String(error)}`, "error"),
			);
		},
		[addToast, syncHostRegistry],
	);

	const updateWorkspaceUri = useCallback(
		(enabled: boolean) => {
			setWorkspaceUriEnabled(enabled);
			workspaceUriEnabledRef.current = enabled;
			void syncHostRegistry(hostToolsRef.current, enabled).catch(error =>
				addToast(
					`Host URI registration failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				),
			);
		},
		[addToast, syncHostRegistry],
	);

	const respondDialog = useCallback((response: ExtensionUIResponse) => {
		clientRef.current?.respondExtensionUI(response).catch(() => {});
		setDialogQueue(queue => queue.filter(dialog => dialog.id !== response.id));
	}, []);

	useEffect(() => {
		document.title = docTitle ? `${docTitle} — OMP` : "OMP";
	}, [docTitle]);

	useEffect(() => {
		let active = true;
		let unlisten: (() => void) | undefined;
		void listScheduledTasks()
			.then(tasks => {
				if (active) setScheduledTasks(tasks);
			})
			.catch(() => {});
		void onScheduledTasksChanged(tasks => {
			if (active) setScheduledTasks(tasks);
		}).then(dispose => {
			if (active) unlisten = dispose;
			else dispose();
		});
		return () => {
			active = false;
			unlisten?.();
		};
	}, []);

	// Check for an app update once on mount. The check is best-effort (no-ops in
	// dev / offline); when an update exists we surface a banner and let the user
	// choose to install — we never relaunch mid-session without consent.
	useEffect(() => {
		let cancelled = false;
		void checkForUpdate().then(result => {
			if (!cancelled && result) setUpdate(result);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	// Boot the engine exactly ONCE, when a workspace first exists. Switching
	// projects afterwards re-roots the live engine over RPC (see `openFolder`)
	// instead of tearing this client down — so the process, credentials, and RPC
	// stream survive, matching how Codex/Claude keep running across project
	// switches. The effect keys off a boolean, not the path, so folder→folder
	// changes never re-run it.
	const engineShouldRun = workspace !== null;
	useEffect(() => {
		if (!engineShouldRun) return;
		let cancelled = false;
		let starting = false;
		let restartTimer: ReturnType<typeof setTimeout> | undefined;
		let restartAttempts = 0;
		let bootstrap: () => Promise<void>;

		const client = new DesktopRpcClient({
			onEvent: event => {
				dispatch({ kind: "event", event });
				if (event.type === "available_commands_update") setAvailableCommands(event.commands);
				if (event.type === "tool_execution_start" && event.toolName === "browser") {
					setBrowserActivity(items => [
						...items.filter(item => item.id !== event.toolCallId),
						{
							id: event.toolCallId,
							label: event.intent || "OMP browser tool",
							status: "running",
							timestamp: Date.now(),
						},
					]);
				}
				if (event.type === "tool_execution_end" && event.toolName === "browser") {
					setBrowserActivity(items =>
						items.map(item =>
							item.id === event.toolCallId
								? { ...item, status: event.isError ? "error" : "done", timestamp: Date.now() }
								: item,
						),
					);
					void refreshBrowserTabs();
				}
				if (event.type === "plan_mode_changed") {
					setPlanMode(event.planMode);
				}
				if (event.type === "goal_updated") {
					setGoalMode(event.state);
				}
				if (REFRESH_EVENTS.has(event.type)) {
					void refreshState();
					void refreshWorkspaceDiff();
					void refreshGitStatus();
					void refreshWorkspaceFiles();
				}
			},
			onStatus: (next, detail) => {
				if (cancelled) return;
				setStatus(next);
				setStatusDetail(detail);
				// Engine died mid-turn without an agent_end: clear the streaming
				// spinner and finalize any running tool cards as interrupted.
				if (next === "stopped" || next === "error") {
					dispatch({ kind: "interrupted", reason: detail ? `Engine stopped: ${detail}` : "Engine stopped" });
				}
				if (next === "stopped" && !userStoppingRef.current && restartAttempts < 3 && !restartTimer) {
					const attempt = restartAttempts++;
					const delay = 1_000 * 2 ** attempt;
					setStatusDetail(`Engine exited; restarting (${attempt + 1}/3)…`);
					restartTimer = setTimeout(() => {
						restartTimer = undefined;
						void bootstrap();
					}, delay);
				}
			},
			onStderr: line => dispatch({ kind: "stderr", line }),
			onSubagentUpdate: () => {
				void refreshSubagents();
				void refreshSelectedSubagentTranscript();
			},
			onExtensionUI: request => handleExtensionUI(request),
			onExtensionError: error => handleExtensionError(error),
			onHostToolCall: request => handleHostToolCall(request),
			onHostToolCancel: request => handleHostToolCancel(request.targetId),
			onHostUriRequest: request => handleHostUriRequest(request),
		});
		clientRef.current = client;

		bootstrap = async () => {
			if (cancelled || starting) return;
			starting = true;
			try {
				await client.start(workspaceRef.current ?? undefined);
				if (cancelled) return;
				restartAttempts = 0;
				const [availableModels] = await Promise.all([
					client.getAvailableModels(),
					client.getAvailableCommands().then(setAvailableCommands),
					refreshState(),
					refreshLoginProviders(),
					refreshSessions(),
					refreshContextSnapshot(),
					refreshBrowserTabs(),
					refreshGitStatus(),
				]);
				if (cancelled) return;
				setModels(availableModels);
				await client.setSubagentSubscription("progress").catch(() => {});
				await syncHostRegistry(hostToolsRef.current, workspaceUriEnabledRef.current).catch(error =>
					addToast(`Host registry failed: ${error instanceof Error ? error.message : String(error)}`, "error"),
				);
				// Workspace diff can be slow on large repos; run it after the core
				// state is live so a slow scan never delays models/account/history.
				void refreshWorkspaceDiff();
			} catch {
				// status/detail already surfaced via onStatus("error", …). A failed
				// initial boot or restart gets the same bounded recovery policy.
				if (!cancelled && !userStoppingRef.current && restartAttempts < 3 && !restartTimer) {
					const attempt = restartAttempts++;
					const delay = 1_000 * 2 ** attempt;
					setStatusDetail(`Engine unavailable; retrying (${attempt + 1}/3)…`);
					restartTimer = setTimeout(() => {
						restartTimer = undefined;
						void bootstrap();
					}, delay);
				}
			} finally {
				starting = false;
			}
		};
		void bootstrap();

		return () => {
			cancelled = true;
			if (restartTimer) clearTimeout(restartTimer);
			clientRef.current = null;
			void client.stop();
		};
	}, [
		engineShouldRun,
		refreshState,
		refreshSubagents,
		refreshLoginProviders,
		refreshSessions,
		refreshWorkspaceDiff,
		refreshGitStatus,
		refreshWorkspaceFiles,
		refreshContextSnapshot,
		refreshBrowserTabs,
		handleExtensionUI,
		handleExtensionError,
		handleHostToolCall,
		handleHostToolCancel,
		handleHostUriRequest,
		syncHostRegistry,
		addToast,
	]);

	const reportError = useCallback((label: string, err: unknown) => {
		// Classify RPC failures so recovery hints differ: transport failures point
		// at the engine, timeouts suggest a retry, engine errors carry a message.
		const detail =
			err instanceof RpcError
				? `${err.message} (${err.kind}${err.kind === "transport" ? " — try restarting the engine" : ""})`
				: err instanceof Error
					? err.message
					: String(err);
		dispatch({ kind: "stderr", line: `${label}: ${detail}` });
	}, []);

	const refreshDiagnostics = useCallback(async () => {
		setDiagnosticsLoading(true);
		try {
			const client = clientRef.current;
			const [snapshot, stats] = await Promise.all([
				collectDiagnostics(),
				client ? client.getSessionStats().catch(() => null) : Promise.resolve(null),
			]);
			setDiagnostics(snapshot);
			setSessionStats(stats);
		} catch (err) {
			reportError("collect diagnostics failed", err);
		} finally {
			setDiagnosticsLoading(false);
		}
	}, [reportError]);

	const exportDiagnostics = useCallback(async () => {
		try {
			const outputPath = await exportDiagnosticsBundle();
			addToast(`Diagnostics bundle exported: ${outputPath}`, "info");
		} catch (err) {
			reportError("export diagnostics failed", err);
		}
	}, [addToast, reportError]);

	// A transport failure while the app is intentionally reaping the engine
	// (update install / unmount) is user-initiated, not an engine fault — stay
	// silent per "im lặng khi do người dùng chủ động". Genuine engine errors and
	// timeouts still surface.
	const isUserInitiatedStop = useCallback(
		(err: unknown) => userStoppingRef.current && err instanceof RpcTransportError,
		[],
	);

	const onInstallUpdate = useCallback(async () => {
		if (!update) return;
		setUpdateInstalling(true);
		try {
			// Reap the engine before the installer swaps binaries; relaunch happens
			// inside installUpdate. Flag the stop as user-initiated so the in-flight
			// requests it rejects stay silent (no false "…failed" toasts).
			userStoppingRef.current = true;
			await clientRef.current?.stop().catch(() => {});
			await installUpdate(update.update);
		} catch (err) {
			setUpdateInstalling(false);
			reportError("update failed", err);
		}
	}, [update, reportError]);

	const onRevertFiles = useCallback(
		async (files: string[]) => {
			const client = clientRef.current;
			if (!client || files.length === 0) return;
			if (!window.confirm("Revert selected tracked changes? This permanently discards local edits.")) return;
			try {
				await client.revertFiles(files);
				await Promise.all([refreshWorkspaceDiff(), refreshGitStatus()]);
				addToast("Changes reverted", "info");
			} catch (err) {
				reportError("revert failed", err);
				addToast(err instanceof Error ? err.message : "Could not revert changes", "error");
			}
		},
		[addToast, refreshGitStatus, refreshWorkspaceDiff, reportError],
	);

	const onCommit = useCallback(async () => {
		const client = clientRef.current;
		if (!client || gitStatus.staged === 0) return;
		const message = window.prompt("Commit message")?.trim();
		if (!message) return;
		if (!window.confirm(`Commit ${gitStatus.staged} staged file${gitStatus.staged === 1 ? "" : "s"}?`)) return;
		try {
			const result = await client.commit(message);
			await Promise.all([refreshWorkspaceDiff(), refreshGitStatus()]);
			addToast(result.stdout.trim() || "Commit created", "info");
		} catch (err) {
			reportError("commit failed", err);
			addToast(err instanceof Error ? err.message : "Could not create commit", "error");
		}
	}, [addToast, gitStatus.staged, refreshGitStatus, refreshWorkspaceDiff, reportError]);

	const onPush = useCallback(async () => {
		const client = clientRef.current;
		if (!client || !gitStatus.branch) return;
		if (!window.confirm(`Push branch ${gitStatus.branch} to its configured remote? This publishes local commits.`))
			return;
		try {
			await client.push();
			addToast(`Pushed ${gitStatus.branch}`, "info");
		} catch (err) {
			reportError("push failed", err);
			const detail = err instanceof Error ? err.message : String(err);
			addToast(/auth|credential|login|network|remote/i.test(detail) ? `Push failed: ${detail}` : detail, "error");
		}
	}, [addToast, gitStatus.branch, reportError]);

	const onCreatePullRequest = useCallback(async () => {
		const client = clientRef.current;
		if (!client || !gitStatus.branch) return;
		const title = window.prompt("Pull request title")?.trim();
		if (!title) return;
		const body = window.prompt("Pull request description", "") ?? "";
		if (!window.confirm(`Create a GitHub pull request from ${gitStatus.branch}?`)) return;
		try {
			const url = await client.createPullRequest(title, body);
			addToast("Pull request created", "info");
			if (url) await openExternalUrl(url);
		} catch (err) {
			reportError("create pull request failed", err);
			const detail = err instanceof Error ? err.message : String(err);
			addToast(
				/auth|credential|login/i.test(detail) ? `GitHub authentication required: ${detail}` : detail,
				"error",
			);
		}
	}, [addToast, gitStatus.branch, reportError]);

	const onStageHunks = useCallback(
		async (selections: HunkSelection[]) => {
			const client = clientRef.current;
			if (!client) return;
			try {
				await client.stageHunks(selections);
				await Promise.all([refreshWorkspaceDiff(), refreshGitStatus()]);
			} catch (err) {
				reportError("stage failed", err);
			}
		},
		[refreshGitStatus, refreshWorkspaceDiff, reportError],
	);

	const onUnstage = useCallback(
		async (files?: string[]) => {
			const client = clientRef.current;
			if (!client) return;
			try {
				await client.unstage(files);
				await Promise.all([refreshWorkspaceDiff(), refreshGitStatus()]);
			} catch (err) {
				reportError("unstage failed", err);
			}
		},
		[refreshGitStatus, refreshWorkspaceDiff, reportError],
	);

	const openFolder = useCallback(async () => {
		const folder = await pickWorkspaceFolder();
		if (!folder) return;

		// Clear per-workspace UI so the destination project starts on a fresh task.
		// Transcript/subagents/dialogs/injection reset either way; account (login
		// providers) and models are re-fetched below since credentials are shared
		// but availability can differ per project settings.
		dispatch({ kind: "reset" });
		setModels([]);
		setSession(EMPTY_SESSION);
		setSubagents([]);
		setDialogQueue([]);
		setToasts([]);
		setLoginProviders([]);
		setSessions([]);
		setChanges([]);
		setGitStatus({ branch: null, staged: 0, unstaged: 0, untracked: 0 });
		setWorkspaceEntries([]);
		setWorkspaceFileContent(null);
		setSelectedWorkspacePath(null);
		setContextItems([]);
		setContextImages([]);
		setContextSkills([]);
		setContextSkillDetails([]);
		setContextSkillWarnings([]);
		setContextMemoryBackend(null);
		setBrowserUrl("");
		setBrowserSnapshot("");
		setBrowserTabs([]);
		setBrowserActiveTab("main");
		setBrowserActivity([]);
		setSideChatReady(false);
		setSideChatStarting(false);
		setSideChatMessages([]);
		setSideChatWorktreePath(null);
		setInjection(undefined);
		setAuthPrompt(null);
		setStatuses({});
		setWidgets({});
		setDocTitle(undefined);
		setPlanMode(undefined);
		loginProviderRef.current = undefined;

		const client = clientRef.current;
		workspaceRef.current = folder;
		saveLastWorkspace(folder);
		setWorkspace(folder);

		// Engine already running: re-root it in place (no respawn, no "Waiting for
		// engine…"), then refresh state for the new project. Only the first-ever
		// open (no client yet) falls through to the boot effect via setWorkspace.
		if (client) {
			try {
				await client.setWorkspace(folder);
				await Promise.all([
					refreshState(),
					refreshSessions(),
					refreshLoginProviders(),
					refreshWorkspaceDiff(),
					refreshGitStatus(),
					refreshWorkspaceFiles(),
					refreshContextSnapshot(),
				]);
				setModels(await client.getAvailableModels().catch(() => []));
			} catch (err) {
				reportError("switch workspace failed", err);
			}
		} else {
			setStatus("idle");
			setStatusDetail(undefined);
		}
	}, [
		refreshState,
		refreshSessions,
		refreshLoginProviders,
		refreshWorkspaceDiff,
		refreshGitStatus,
		refreshWorkspaceFiles,
		refreshContextSnapshot,
		reportError,
	]);

	const refreshWorktrees = useCallback(async () => {
		const client = clientRef.current;
		if (!client) return;
		setWorktreesLoading(true);
		try {
			setWorktrees(await client.listWorktrees());
		} catch (err) {
			reportError("list worktrees failed", err);
			addToast("Could not load worktrees", "error");
		} finally {
			setWorktreesLoading(false);
		}
	}, [addToast, reportError]);

	const onManageWorktrees = useCallback(() => {
		setWorktreeManagerOpen(true);
		void refreshWorktrees();
	}, [refreshWorktrees]);

	const onCreateWorktree = useCallback(async () => {
		const client = clientRef.current;
		if (!client || !workspace) return;
		const ref = window.prompt("Git ref for the new worktree", gitStatus.branch ?? "HEAD")?.trim();
		if (!ref) return;
		const worktreePath = window.prompt("Absolute worktree path", `${workspace}-worktree`)?.trim();
		if (!worktreePath) return;
		if (!window.confirm(`Create permanent worktree at ${worktreePath} from ${ref}?`)) return;
		setWorktreeMutatingPath(worktreePath);
		try {
			await client.createWorktree(worktreePath, ref);
			await refreshWorktrees();
			addToast(`Worktree created: ${worktreePath}`, "info");
		} catch (err) {
			reportError("create worktree failed", err);
			addToast(err instanceof Error ? err.message : "Could not create worktree", "error");
		} finally {
			setWorktreeMutatingPath(null);
		}
	}, [addToast, gitStatus.branch, refreshWorktrees, reportError, workspace]);

	const onOpenWorktree = useCallback(
		async (worktreePath: string) => {
			const client = clientRef.current;
			if (!client) return;
			setWorktreeMutatingPath(worktreePath);
			try {
				await client.setWorkspace(worktreePath);
				workspaceRef.current = worktreePath;
				saveLastWorkspace(worktreePath);
				setWorkspace(worktreePath);
				dispatch({ kind: "reset" });
				setWorktreeManagerOpen(false);
				await Promise.all([
					refreshState(),
					refreshSessions(),
					refreshWorkspaceDiff(),
					refreshGitStatus(),
					refreshWorkspaceFiles(),
					refreshContextSnapshot(),
				]);
				setModels(await client.getAvailableModels().catch(() => []));
			} catch (err) {
				reportError("open worktree failed", err);
				addToast(err instanceof Error ? err.message : "Could not open worktree", "error");
			} finally {
				setWorktreeMutatingPath(null);
			}
		},
		[
			addToast,
			refreshContextSnapshot,
			refreshGitStatus,
			refreshSessions,
			refreshState,
			refreshWorkspaceDiff,
			refreshWorkspaceFiles,
			reportError,
		],
	);

	const onRemoveWorktree = useCallback(
		async (worktreePath: string, force: boolean) => {
			const client = clientRef.current;
			if (!client) return;
			const warning = force
				? `Force-remove ${worktreePath}? Uncommitted changes in that worktree will be lost.`
				: `Remove worktree ${worktreePath}? Git will refuse if it contains uncommitted changes.`;
			if (!window.confirm(warning)) return;
			setWorktreeMutatingPath(worktreePath);
			try {
				await client.removeWorktree(worktreePath, force);
				await refreshWorktrees();
				addToast("Worktree removed", "info");
			} catch (err) {
				reportError("remove worktree failed", err);
				addToast(
					force ? "Force-remove failed" : "Safe removal failed. Review the worktree or choose Force remove.",
					"error",
				);
			} finally {
				setWorktreeMutatingPath(null);
			}
		},
		[addToast, refreshWorktrees, reportError],
	);

	const onEnsureSideChat = useCallback(async () => {
		if (sideClientRef.current || !workspace || sideChatStarting) return;
		setSideChatStarting(true);
		const client = new DesktopRpcClient(
			{
				onEvent: event => {
					if (event.type !== "message_end" || event.message.role !== "assistant") return;
					const text = messageText(event.message.content) || event.message.errorMessage || "";
					if (text) setSideChatMessages(messages => [...messages, { role: "assistant", text }]);
				},
				onStatus: next => {
					setSideChatReady(next === "ready");
					if (next === "stopped" || next === "error") {
						const deadClient = sideClientRef.current;
						sideClientRef.current = null;
						void deadClient?.stop();
					}
				},
				onStderr: line => setSideChatMessages(messages => [...messages, { role: "system", text: line }]),
				onHostToolCall: request => {
					const side = sideClientRef.current;
					return side ? executeHostToolCall(side, request) : Promise.resolve();
				},
				onHostToolCancel: request => handleHostToolCancel(request.targetId),
				onHostUriRequest: request => {
					const side = sideClientRef.current;
					return side ? resolveHostUriForClient(side, request) : Promise.resolve();
				},
			},
			sideEngineTransport,
		);
		sideClientRef.current = client;
		try {
			await client.start(sideChatWorktreePath ?? workspace);
			await client.setHostTools(
				hostToolsRef.current.map(
					({ action: _action, requiresApproval: _requiresApproval, ...definition }) => definition,
				),
			);
			await client.setHostUriSchemes(
				workspaceUriEnabledRef.current
					? [
							{
								scheme: "workspace",
								description: "Read workspace files through the Electron host",
								immutable: false,
							},
						]
					: [],
			);
			setSideChatReady(true);
		} catch (err) {
			await client.stop().catch(() => {});
			sideClientRef.current = null;
			setSideChatReady(false);
			reportError("side chat start failed", err);
			addToast("Could not start isolated side chat", "error");
		} finally {
			setSideChatStarting(false);
		}
	}, [
		addToast,
		executeHostToolCall,
		handleHostToolCancel,
		resolveHostUriForClient,
		reportError,
		sideChatStarting,
		sideChatWorktreePath,
		workspace,
	]);

	const onSendSideChat = useCallback(
		async (text: string) => {
			const client = sideClientRef.current;
			if (!client || !sideChatReady) return;
			setSideChatMessages(messages => [...messages, { role: "user", text }]);
			try {
				await client.prompt(text);
			} catch (err) {
				reportError("side chat send failed", err);
				setSideChatMessages(messages => [
					...messages,
					{ role: "system", text: err instanceof Error ? err.message : String(err) },
				]);
			}
		},
		[reportError, sideChatReady],
	);

	const onForkSideChat = useCallback(async () => {
		const main = clientRef.current;
		const side = sideClientRef.current;
		if (!main || !side || !sideChatReady) return;
		try {
			const mainState = await main.getState();
			const transcript = (await main.getMessages())
				.filter(message => message.role === "user" || message.role === "assistant")
				.slice(-12)
				.map(message => `${message.role}: ${messageText(message.content)}`)
				.filter(line => !line.endsWith(": "))
				.join("\n\n");
			if (!transcript) {
				addToast("Main task has no transcript to fork", "warning");
				return;
			}
			const { cancelled } = await side.newSession(mainState.sessionFile);
			if (cancelled) {
				addToast("Side Chat fork was cancelled by an OMP extension", "info");
				return;
			}
			setSideChatMessages(messages => [
				...messages,
				{
					role: "system",
					text: mainState.sessionFile
						? "Forking recent main-task context with structured session lineage…"
						: "Forking recent main-task context…",
				},
			]);
			await side.prompt(transcript);
		} catch (err) {
			reportError("side chat fork failed", err);
			addToast("Could not fork main context", "error");
		}
	}, [addToast, reportError, sideChatReady]);

	const onAddSideChatResult = useCallback(() => {
		const result = [...sideChatMessages].reverse().find(message => message.role === "assistant");
		if (!result) return;
		addWorkspaceContext("side-chat://response", result.text);
		addToast("Side Chat response added to main context", "info");
	}, [addToast, addWorkspaceContext, sideChatMessages]);

	const stopSideChat = useCallback(async () => {
		const client = sideClientRef.current;
		sideClientRef.current = null;
		setSideChatReady(false);
		setSideChatStarting(false);
		if (client) await client.stop();
	}, []);

	const onToggleSideChatWorktree = useCallback(async () => {
		const main = clientRef.current;
		if (!main || !workspace) return;
		if (sideChatWorktreePath) {
			if (!window.confirm(`Remove isolated worktree at ${sideChatWorktreePath}? Git will refuse if it is dirty.`))
				return;
			try {
				await stopSideChat();
				await main.removeWorktree(sideChatWorktreePath, false);
				setSideChatWorktreePath(null);
				addToast("Isolated worktree removed", "info");
			} catch (err) {
				reportError("remove side chat worktree failed", err);
				addToast("Worktree is dirty; review it in Worktree Manager before removing", "error");
			}
			return;
		}
		const defaultPath = `${workspace.replace(/[\\/]+$/, "")}-side-chat`;
		const requestedPath = window.prompt("Absolute path for Side Chat worktree", defaultPath)?.trim();
		if (!requestedPath || !gitStatus.branch) return;
		if (!window.confirm(`Create isolated Side Chat worktree at ${requestedPath}?`)) return;
		try {
			await stopSideChat();
			await main.createWorktree(requestedPath, gitStatus.branch);
			setSideChatWorktreePath(requestedPath);
			addToast("Side Chat will use the isolated worktree", "info");
		} catch (err) {
			reportError("create side chat worktree failed", err);
			addToast("Could not create isolated worktree", "error");
		}
	}, [addToast, gitStatus.branch, reportError, sideChatWorktreePath, stopSideChat, workspace]);

	const onSaveScheduledTask = useCallback(
		async (input: ScheduledTaskInput) => {
			try {
				await upsertScheduledTask(input);
				addToast("Scheduled task saved", "info");
			} catch (err) {
				reportError("save scheduled task failed", err);
				addToast(err instanceof Error ? err.message : "Could not save scheduled task", "error");
			}
		},
		[addToast, reportError],
	);

	const onRemoveScheduledTask = useCallback(
		async (id: string) => {
			if (!window.confirm("Remove this scheduled task?")) return;
			try {
				await removeScheduledTask(id);
				addToast("Scheduled task removed", "info");
			} catch (err) {
				reportError("remove scheduled task failed", err);
				addToast(err instanceof Error ? err.message : "Could not remove scheduled task", "error");
			}
		},
		[addToast, reportError],
	);

	const onRunScheduledTask = useCallback(
		async (id: string) => {
			if (!window.confirm("Run this scheduled task now?")) return;
			try {
				await runScheduledTaskNow(id);
				addToast("Scheduled task started", "info");
			} catch (err) {
				reportError("run scheduled task failed", err);
				addToast(err instanceof Error ? err.message : "Could not run scheduled task", "error");
			}
		},
		[addToast, reportError],
	);

	const onSend = useCallback(
		(text: string, images: ImageContent[], streamingBehavior?: "steer" | "followUp") => {
			dispatch({ kind: "user", text, images });
			// Flip the streaming flag optimistically so the composer shows Stop and the
			// transcript shows a working indicator immediately, without waiting for the
			// engine's `agent_start` to round-trip. The real `agent_start`/`agent_end`
			// events reconcile it afterwards; if the prompt resolved without invoking the
			// agent (a local-only slash command) or the send failed, clear it back.
			dispatch({ kind: "streaming", value: true });
			const client = clientRef.current;
			if (!client) {
				dispatch({ kind: "streaming", value: false });
				return;
			}
			const stagedContext = contextItems;
			const message = composePromptWithContext(text, stagedContext);
			setContextItems([]);
			client
				.prompt(message, images, streamingBehavior)
				.then(result => {
					if (result?.agentInvoked === false) dispatch({ kind: "streaming", value: false });
				})
				.catch(err => {
					dispatch({ kind: "streaming", value: false });
					setContextItems(current => [
						...stagedContext.filter(item => !current.some(candidate => candidate.id === item.id)),
						...current,
					]);
					reportError("send failed", err);
				});
		},
		[contextItems, reportError],
	);

	const onAbort = useCallback(() => {
		// Reflect the stop request immediately (button → "Stopping…", disabled) so a
		// slow turn teardown doesn't look unresponsive. The `aborting` effect clears
		// this once streaming ends via agent_end / engine-stopped.
		setAborting(true);
		clientRef.current?.abort().catch(() => {});
	}, []);

	// Clear the optimistic aborting flag whenever the turn is no longer streaming.
	// Covers both graceful (agent_end) and transport (engine stopped) endings, and
	// self-heals if abort() never produces a terminal event.
	useEffect(() => {
		if (aborting && !vm.streaming) setAborting(false);
	}, [aborting, vm.streaming]);

	const onSelectModel = useCallback(
		(provider: string, id: string) => {
			clientRef.current
				?.setModel(provider, id)
				.then(refreshState)
				.catch(err => reportError("set model failed", err));
		},
		[refreshState, reportError],
	);
	const onSelectApprovalMode = useCallback(
		(mode: ApprovalMode) => {
			clientRef.current
				?.setApprovalMode(mode)
				.then(refreshState)
				.catch(err => reportError("set approval mode failed", err));
		},
		[refreshState, reportError],
	);
	const onSelectThinking = useCallback(
		(level: ThinkingLevel) => {
			clientRef.current
				?.setThinkingLevel(level)
				.then(refreshState)
				.catch(err => reportError("set thinking failed", err));
		},
		[refreshState, reportError],
	);
	const onSetSteeringMode = useCallback(
		(mode: "all" | "one-at-a-time") => {
			clientRef.current
				?.setSteeringMode(mode)
				.then(refreshState)
				.catch(err => reportError("set steering mode failed", err));
		},
		[refreshState, reportError],
	);
	const onSetFollowUpMode = useCallback(
		(mode: "all" | "one-at-a-time") => {
			clientRef.current
				?.setFollowUpMode(mode)
				.then(refreshState)
				.catch(err => reportError("set follow-up mode failed", err));
		},
		[refreshState, reportError],
	);
	const onSetInterruptMode = useCallback(
		(mode: "immediate" | "wait") => {
			clientRef.current
				?.setInterruptMode(mode)
				.then(refreshState)
				.catch(err => reportError("set interrupt mode failed", err));
		},
		[refreshState, reportError],
	);
	const onSetAutoCompaction = useCallback(
		(enabled: boolean) => {
			clientRef.current
				?.setAutoCompaction(enabled)
				.then(refreshState)
				.catch(err => reportError("set auto compaction failed", err));
		},
		[refreshState, reportError],
	);
	const onSetAutoRetry = useCallback(
		(enabled: boolean) => {
			clientRef.current
				?.setAutoRetry(enabled)
				.then(refreshState)
				.catch(err => reportError("set auto retry failed", err));
		},
		[refreshState, reportError],
	);
	const onCompact = useCallback(() => {
		clientRef.current
			?.compact()
			.then(() => {
				void refreshState();
				addToast("Context compacted", "info");
			})
			.catch(err => reportError("compact failed", err));
	}, [addToast, refreshState, reportError]);
	const onAbortRetry = useCallback(() => {
		clientRef.current
			?.abortRetry()
			.then(refreshState)
			.catch(err => reportError("abort retry failed", err));
	}, [refreshState, reportError]);

	const onTogglePlanMode = useCallback(
		(enabled: boolean) => {
			const client = clientRef.current;
			if (!client) return;
			// Optimistic: flip the toggle immediately so the button responds without
			// waiting for the engine's `plan_mode_changed` to round-trip (which can queue
			// behind a streaming turn). The authoritative event reconciles the full state
			// (planFilePath/workflow) when it arrives; on failure we revert.
			const previous = planModeRef.current;
			setPlanMode(prev => ({
				planFilePath: prev?.planFilePath ?? "",
				workflow: prev?.workflow,
				enabled,
			}));
			client.setPlanMode(enabled).catch(err => {
				setPlanMode(previous);
				reportError("set plan mode failed", err);
			});
		},
		[reportError],
	);

	const onCreateGoal = useCallback(() => {
		const client = clientRef.current;
		if (!client) return;
		const objective = window.prompt("Goal objective:", "");
		if (!objective?.trim()) return;
		const budgetInput = window.prompt("Optional positive token budget (leave blank for none):", "");
		if (budgetInput === null) return;
		const tokenBudget = budgetInput.trim() ? Number.parseInt(budgetInput.trim(), 10) : undefined;
		if (tokenBudget !== undefined && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) {
			addToast("Goal token budget must be a positive integer.", "error");
			return;
		}
		void client
			.createGoal(objective.trim(), tokenBudget)
			.then(result => {
				setGoalMode(result.state ?? undefined);
				addToast("Goal mode started.", "info");
			})
			.catch(error => reportError("create goal failed", error));
	}, [addToast, reportError]);

	const onPauseGoal = useCallback(() => {
		void clientRef.current
			?.pauseGoal()
			.then(result => {
				setGoalMode(result.state ?? undefined);
				addToast("Goal mode paused.", "info");
			})
			.catch(error => reportError("pause goal failed", error));
	}, [addToast, reportError]);

	const onResumeGoal = useCallback(() => {
		void clientRef.current
			?.resumeGoal()
			.then(result => {
				setGoalMode(result.state ?? undefined);
				addToast("Goal mode resumed.", "info");
			})
			.catch(error => reportError("resume goal failed", error));
	}, [addToast, reportError]);

	const onDropGoal = useCallback(() => {
		if (!window.confirm("Drop the current goal? Its progress remains in the session transcript.")) return;
		void clientRef.current
			?.dropGoal()
			.then(() => {
				setGoalMode(undefined);
				addToast("Goal dropped.", "info");
			})
			.catch(error => reportError("drop goal failed", error));
	}, [addToast, reportError]);

	const onNewSession = useCallback(() => {
		const client = clientRef.current;
		if (!client) return;
		// Reset the view to the home screen immediately — the engine's
		// `new_session` `await`s the in-flight turn's teardown (serial RPC
		// dispatch), so waiting for the round-trip would leave the UI frozen on
		// the old transcript for seconds. Refreshers run in the background; the
		// engine's own events reconcile state once the switch lands.
		dispatch({ kind: "reset" });
		setSubagents([]);
		void (async () => {
			try {
				const { cancelled } = await client.newSession();
				if (cancelled) {
					dispatch({ kind: "seed", messages: await client.getMessages() });
					addToast("New task was cancelled by an OMP extension", "info");
					return;
				}
				await Promise.all([refreshState(), refreshSessions(), refreshWorkspaceDiff()]);
			} catch (err) {
				reportError("new session failed", err);
			}
		})();
	}, [addToast, refreshState, refreshSessions, refreshWorkspaceDiff, reportError]);

	const onRenameSession = useCallback(
		(name: string) => {
			clientRef.current
				?.setSessionName(name)
				.then(refreshState)
				.catch(err => reportError("rename failed", err));
		},
		[refreshState, reportError],
	);

	const onSelectSession = useCallback(
		(session: SessionSummary) => {
			const client = clientRef.current;
			if (!client || session.active) return;
			// Show the loading state instantly: clear the old transcript and flag
			// the switch before the round-trip. `switch_session` `await`s the
			// in-flight turn's teardown, so the UI would otherwise sit frozen on the
			// previous session's messages until the engine settles.
			dispatch({ kind: "reset" });
			setSubagents([]);
			setSwitching(true);
			void (async () => {
				try {
					const { cancelled } = await client.switchSession(session.path);
					if (cancelled) {
						// A hook vetoed the switch — the engine stayed on the current
						// session. Re-seed its transcript so the optimistic reset above
						// doesn't strand the UI on a blank screen.
						dispatch({ kind: "seed", messages: await client.getMessages() });
						return;
					}
					const messages = await client.getMessages();
					dispatch({ kind: "seed", messages });
					await Promise.all([refreshState(), refreshSessions()]);
				} catch (err) {
					reportError("switch session failed", err);
				} finally {
					setSwitching(false);
				}
			})();
		},
		[refreshState, refreshSessions, reportError],
	);

	const onBranchSession = useCallback(() => {
		const client = clientRef.current;
		if (!client) return;
		void (async () => {
			try {
				const messages = await client.getBranchMessages();
				if (messages.length === 0) {
					addToast("This session has no branchable user messages.", "info");
					return;
				}
				const visible = messages.slice(-20);
				const choices = visible
					.map((message, index) => `${index + 1}. ${message.text.replace(/\s+/g, " ").slice(0, 100)}`)
					.join("\n");
				const selected = window.prompt(`Branch from which message? Enter 1-${visible.length}:\n\n${choices}`);
				if (selected === null) return;
				const index = Number.parseInt(selected.trim(), 10) - 1;
				const target = visible[index];
				if (!target) {
					addToast("Invalid branch message selection.", "error");
					return;
				}
				setSwitching(true);
				const result = await client.branch(target.entryId);
				if (result.cancelled) {
					addToast("Branch was cancelled by an OMP extension.", "info");
					return;
				}
				dispatch({ kind: "seed", messages: await client.getMessages() });
				setSubagents([]);
				await Promise.all([refreshState(), refreshSessions()]);
				addToast("Session branched from the selected message.", "info");
			} catch (error) {
				reportError("branch session failed", error);
			} finally {
				setSwitching(false);
			}
		})();
	}, [addToast, refreshSessions, refreshState, reportError]);

	const onExportSession = useCallback(() => {
		const client = clientRef.current;
		if (!client) return;
		void client
			.exportHtml()
			.then(async outputPath => {
				addToast(`Session exported to ${outputPath}`, "info");
				await revealItem(outputPath);
			})
			.catch(error => reportError("export session failed", error));
	}, [addToast, reportError]);

	const onHandoffSession = useCallback(() => {
		const client = clientRef.current;
		if (!client) return;
		const instructions = window.prompt("Optional handoff instructions for the next session:", "");
		if (instructions === null) return;
		setSwitching(true);
		void client
			.handoff(instructions.trim() || undefined)
			.then(async result => {
				if (!result) {
					addToast("OMP did not create a handoff.", "info");
					return;
				}
				dispatch({ kind: "seed", messages: await client.getMessages() });
				setSubagents([]);
				await Promise.all([refreshState(), refreshSessions()]);
				addToast("Handoff created and a fresh session is ready.", "info");
				if (result.savedPath) await revealItem(result.savedPath);
			})
			.catch(error => reportError("handoff failed", error))
			.finally(() => setSwitching(false));
	}, [addToast, refreshSessions, refreshState, reportError]);

	const refreshAuth = useCallback(async () => {
		await Promise.all([refreshLoginProviders(), refreshState()]);
		const client = clientRef.current;
		if (!client) return;
		// Swallow transient model-refresh failures like the sibling refreshers above.
		// A slow/failed getAvailableModels() after a *successful* login must not
		// reject refreshAuth() — otherwise the login handler's .catch fires and shows
		// a false "Login failed" toast even though the credential was stored.
		try {
			setModels(await client.getAvailableModels());
		} catch {
			// transient; ignore — providers/state already refreshed above
		}
	}, [refreshLoginProviders, refreshState]);

	const onLogin = useCallback(
		(providerId: string) => {
			loginProviderRef.current = providerId;
			addToast(`Signing in to ${providerId}…`, "info");
			clientRef.current
				?.login(providerId)
				.then(async () => {
					addToast(`Signed in to ${providerId}`, "info");
					await refreshAuth();
				})
				.catch(err => {
					if (isUserInitiatedStop(err)) return;
					reportError("login failed", err);
					addToast(`Login failed: ${err instanceof Error ? err.message : String(err)}`, "error");
				})
				.finally(() => {
					setAuthPrompt(null);
					loginProviderRef.current = undefined;
				});
		},
		[addToast, refreshAuth, reportError, isUserInitiatedStop],
	);

	const onSetApiKey = useCallback(
		(providerId: string, apiKey: string) => {
			addToast(`Saving API key for ${providerId}…`, "info");
			clientRef.current
				?.setApiKey(providerId, apiKey)
				.then(async () => {
					addToast(`API key saved for ${providerId}`, "info");
					await refreshAuth();
				})
				.catch(err => {
					if (isUserInitiatedStop(err)) return;
					reportError("set api key failed", err);
					addToast(`API key failed: ${err instanceof Error ? err.message : String(err)}`, "error");
				});
		},
		[addToast, refreshAuth, reportError, isUserInitiatedStop],
	);

	const onLogout = useCallback(
		(providerId: string) => {
			clientRef.current
				?.logout(providerId)
				.then(async () => {
					addToast(`Signed out of ${providerId}`, "info");
					await refreshAuth();
				})
				.catch(err => {
					reportError("logout failed", err);
					addToast(`Logout failed: ${err instanceof Error ? err.message : String(err)}`, "error");
				});
		},
		[addToast, refreshAuth, reportError],
	);

	const onAuthOpen = useCallback(
		(url: string) => {
			void openExternalUrl(url).catch(() =>
				addToast("Could not open the browser — copy the link instead.", "warning"),
			);
		},
		[addToast],
	);

	const onAuthCancel = useCallback(() => {
		setAuthPrompt(null);
		loginProviderRef.current = undefined;
	}, []);

	if (!workspace) {
		return <WelcomeScreen onOpenFolder={openFolder} error={status === "error" ? statusDetail : undefined} />;
	}

	return (
		<>
			<AppShell
				vm={vm}
				status={status}
				statusDetail={statusDetail}
				workspace={workspace}
				models={models}
				session={session}
				subagents={subagents}
				selectedSubagent={selectedSubagent}
				subagentTranscript={subagentTranscript}
				subagentTranscriptLoading={subagentTranscriptLoading}
				subagentArtifact={subagentArtifact}
				subagentArtifactLoading={subagentArtifactLoading}
				onSelectSubagent={openSubagentTranscript}
				onOpenSubagentArtifact={artifactId => void openSubagentArtifact(artifactId)}
				onCloseSubagentTranscript={closeSubagentTranscript}
				loginProviders={loginProviders}
				availableCommands={availableCommands}
				sessions={sessions}
				statuses={statuses}
				widgets={widgets}
				planMode={planMode}
				onTogglePlanMode={onTogglePlanMode}
				goalMode={goalMode}
				onCreateGoal={onCreateGoal}
				onPauseGoal={onPauseGoal}
				onResumeGoal={onResumeGoal}
				onDropGoal={onDropGoal}
				changes={changes}
				gitStatus={gitStatus}
				workspaceEntries={workspaceEntries}
				workspaceFileContent={workspaceFileContent}
				selectedWorkspacePath={selectedWorkspacePath}
				workspaceFilesLoading={workspaceFilesLoading}
				workspaceFilesTruncated={workspaceFilesTruncated}
				onRefreshWorkspaceFiles={refreshWorkspaceFiles}
				onOpenWorkspaceFile={openWorkspaceFile}
				onRevealWorkspaceFile={async filePath => {
					if (!workspace) return;
					await revealItem(`${workspace}/${filePath}`).catch(err => reportError("reveal file", err));
				}}
				onAddWorkspaceContext={addWorkspaceContext}
				contextItems={contextItems}
				contextImages={contextImages}
				contextSkills={contextSkills}
				contextMemoryBackend={contextMemoryBackend}
				contextUsage={contextUsage}
				contextBreakdown={contextBreakdown}
				onContextImagesChange={setContextImages}
				onRemoveContextItem={id => setContextItems(items => items.filter(item => item.id !== id))}
				onRemoveContextImage={index => setContextImages(images => images.filter((_, i) => i !== index))}
				onClearContext={() => {
					setContextItems([]);
					setContextImages([]);
				}}
				browserUrl={browserUrl}
				browserSnapshot={browserSnapshot}
				browserBusy={browserBusy}
				browserTabs={browserTabs}
				browserActiveTab={browserActiveTab}
				browserActivity={browserActivity}
				browserDownloadPolicy={browserDownloadPolicy}
				onBrowserOpen={browserNavigate}
				onBrowserNewTab={newBrowserTab}
				onBrowserSelectTab={selectBrowserTab}
				onBrowserCloseTab={closeBrowserTab}
				onBrowserRefreshTabs={() => void refreshBrowserTabs()}
				onBrowserHistory={browserHistory}
				onBrowserSnapshot={browserSnapshotRefresh}
				onBrowserAddContext={() => addWorkspaceContext("browser://snapshot", browserSnapshot)}
				onBrowserExternal={url => void openExternalUrl(url)}
				onOpenSettings={category => {
					setSettingsCategory(category);
					setSettingsOpen(true);
				}}
				onManageWorktrees={onManageWorktrees}
				onOpenNewWindow={() => void openNewWindow().catch(err => reportError("open new window failed", err))}
				onRefreshChanges={refreshWorkspaceDiff}
				onStageHunks={onStageHunks}
				onUnstage={onUnstage}
				onRevertFiles={onRevertFiles}
				onCommit={onCommit}
				onPush={onPush}
				onCreatePullRequest={onCreatePullRequest}
				onTerminalRun={async command => {
					const client = clientRef.current;
					if (!client) throw new Error("OMP engine is not ready");
					return await client.bash(command);
				}}
				onTerminalAbort={async () => {
					await clientRef.current?.abortBash();
				}}
				sideChatReady={sideChatReady}
				sideChatStarting={sideChatStarting}
				sideChatMessages={sideChatMessages}
				sideChatWorktreePath={sideChatWorktreePath}
				onEnsureSideChat={() => void onEnsureSideChat()}
				onForkSideChat={() => void onForkSideChat()}
				onAddSideChatResult={onAddSideChatResult}
				onToggleSideChatWorktree={() => void onToggleSideChatWorktree()}
				onSendSideChat={text => void onSendSideChat(text)}
				onCloseSideChat={() => void stopSideChat()}
				scheduledTasks={scheduledTasks}
				onSaveScheduledTask={input => void onSaveScheduledTask(input)}
				onRemoveScheduledTask={id => void onRemoveScheduledTask(id)}
				onRunScheduledTask={id => void onRunScheduledTask(id)}
				updateVersion={update?.info.version ?? null}
				updateInstalling={updateInstalling}
				onInstallUpdate={onInstallUpdate}
				historyLoading={historyLoading}
				switching={switching}
				dialog={dialogQueue.find(d => DIALOG_METHODS.has(d.method)) ?? null}
				toasts={toasts}
				injection={injection}
				onSend={onSend}
				onAbort={onAbort}
				aborting={aborting}
				onChangeFolder={openFolder}
				authPrompt={authPrompt}
				onSelectModel={onSelectModel}
				onSelectThinking={onSelectThinking}
				onSelectApprovalMode={onSelectApprovalMode}
				onSetSteeringMode={onSetSteeringMode}
				onSetFollowUpMode={onSetFollowUpMode}
				onSetInterruptMode={onSetInterruptMode}
				onSetAutoCompaction={onSetAutoCompaction}
				onSetAutoRetry={onSetAutoRetry}
				onCompact={onCompact}
				onAbortRetry={onAbortRetry}
				onNewSession={onNewSession}
				onRenameSession={onRenameSession}
				onSelectSession={onSelectSession}
				onBranchSession={onBranchSession}
				onExportSession={onExportSession}
				onHandoffSession={onHandoffSession}
				onLogin={onLogin}
				onSetApiKey={onSetApiKey}
				onLogout={onLogout}
				onAuthOpen={onAuthOpen}
				onAuthCancel={onAuthCancel}
				onDialogRespond={respondDialog}
				onDismissToast={dismissToast}
			/>
			<SettingsPanel
				open={settingsOpen}
				initialCategory={settingsCategory}
				snapshot={settingsSnapshot}
				loading={settingsLoading}
				error={settingsError}
				savingKey={savingSetting}
				mcpServers={mcpServers}
				memoryStatus={memoryStatus}
				memorySearch={memorySearch}
				marketplace={marketplace}
				marketplaceError={marketplaceError}
				skillDetails={contextSkillDetails}
				skillWarnings={contextSkillWarnings}
				hostTools={hostTools}
				workspaceUriEnabled={workspaceUriEnabled}
				onRefresh={refreshSettings}
				onOpenDiagnostics={() => {
					setDiagnosticsOpen(true);
					void refreshDiagnostics();
				}}
				onSaveSetting={saveSetting}
				onSetPluginEnabled={(name, enabled) =>
					void runPluginAction(name, client => client.setPluginEnabled(name, enabled))
				}
				onSetPluginFeatures={(name, features) =>
					void runPluginAction(`${name}:features`, client => client.setPluginFeatures(name, features))
				}
				onInstallPlugin={spec => void runPluginAction(spec, client => client.installPlugin(spec))}
				onUpdatePlugin={name => void runPluginAction(name, client => client.updatePlugin(name))}
				onUninstallPlugin={name => {
					if (window.confirm(`Uninstall plugin ${name}? This removes its installed files.`))
						void runPluginAction(name, client => client.uninstallPlugin(name));
				}}
				onRefreshMarketplace={refreshMarketplace}
				onAddMarketplace={source =>
					void runMarketplaceAction(`source:add:${source}`, client => client.addMarketplace(source))
				}
				onUpdateMarketplace={name =>
					void runMarketplaceAction(`source:update:${name}`, client => client.updateMarketplace(name))
				}
				onRemoveMarketplace={name => {
					if (!window.confirm(`Remove marketplace "${name}"? Installed plugins are not removed.`)) return;
					void runMarketplaceAction(`source:remove:${name}`, client => client.removeMarketplace(name));
				}}
				onInstallMarketplacePlugin={(name, source, scope) =>
					void runMarketplaceAction(`${name}:${scope}`, client =>
						client.installMarketplacePlugin(name, source, scope),
					)
				}
				onUpgradeMarketplacePlugin={(pluginId, scope) =>
					void runMarketplaceAction(`${pluginId}:${scope}:update`, client =>
						client.upgradeMarketplacePlugin(pluginId, scope),
					)
				}
				onUninstallMarketplacePlugin={(pluginId, scope) => {
					if (!window.confirm(`Uninstall marketplace plugin "${pluginId}" from ${scope} scope?`)) return;
					void runMarketplaceAction(`${pluginId}:${scope}:uninstall`, client =>
						client.uninstallMarketplacePlugin(pluginId, scope),
					);
				}}
				onSetMarketplacePluginEnabled={(pluginId, enabled, scope) =>
					void runMarketplaceAction(`${pluginId}:${scope}:enabled`, client =>
						client.setMarketplacePluginEnabled(pluginId, enabled, scope),
					)
				}
				onRefreshMcp={refreshMcp}
				onReconnectMcp={name =>
					void runPluginAction(`mcp:${name}`, async client => {
						await client.reconnectMcp(name);
						await refreshMcp();
					})
				}
				onSetMcpEnabled={(name, enabled) =>
					void runPluginAction(`mcp:${name}`, async client => {
						await client.setMcpEnabled(name, enabled);
						await refreshMcp();
					})
				}
				onUnauthMcp={name => {
					if (!window.confirm(`Sign out of MCP server "${name}" and remove its managed OAuth credential?`)) return;
					void runPluginAction(`mcp:${name}:unauth`, async client => {
						await client.unauthMcp(name);
						await refreshMcp();
					});
				}}
				onReauthMcp={name =>
					void runPluginAction(`mcp:${name}:reauth`, async client => {
						await client.reauthMcp(name);
						await refreshMcp();
					})
				}
				onRefreshMemory={refreshMemory}
				onSearchMemory={searchMemory}
				onSaveMemory={content => void runMemoryAction("save", client => client.saveMemory(content))}
				onEnqueueMemory={() => void runMemoryAction("enqueue", client => client.enqueueMemory())}
				onClearMemory={() => {
					if (
						!window.confirm(
							"Clear memory state for the active backend? Hindsight only clears its local recall cache.",
						)
					)
						return;
					void runMemoryAction("clear", async client => {
						await client.clearMemory();
						setMemorySearch(null);
					});
				}}
				onAddMemoryContext={item =>
					addWorkspaceContext(`memory://${item.id ?? item.source ?? "record"}`, item.content)
				}
				onReloadSkills={() => void runSkillAction("reload", client => client.reloadSkills())}
				onSetSkillEnabled={(name, enabled) =>
					void runSkillAction(name, client => client.setSkillEnabled(name, enabled))
				}
				onHostToolsChange={updateHostTools}
				onWorkspaceUriEnabledChange={updateWorkspaceUri}
				onClose={() => setSettingsOpen(false)}
			/>
			<HostApprovalDialog
				request={hostApprovals[0] ?? null}
				label={hostTools.find(tool => tool.name === hostApprovals[0]?.toolName)?.label}
				onDecision={approved => {
					const request = hostApprovals[0];
					if (request) decideHostApproval(request.id, approved);
				}}
			/>
			<DiagnosticsPanel
				open={diagnosticsOpen}
				snapshot={diagnostics}
				sessionStats={sessionStats}
				loading={diagnosticsLoading}
				onRefresh={() => void refreshDiagnostics()}
				onExport={() => void exportDiagnostics()}
				onClose={() => setDiagnosticsOpen(false)}
			/>
			<WorktreeManager
				open={worktreeManagerOpen}
				workspace={workspace}
				worktrees={worktrees}
				loading={worktreesLoading}
				mutatingPath={worktreeMutatingPath}
				onClose={() => setWorktreeManagerOpen(false)}
				onRefresh={refreshWorktrees}
				onCreate={onCreateWorktree}
				onOpen={onOpenWorktree}
				onRemove={onRemoveWorktree}
			/>
		</>
	);
}
