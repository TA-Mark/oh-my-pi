import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AppShell, type SessionInfo } from "./components/AppShell";
import type { AuthPrompt } from "./components/AuthDialog";
import type { ComposerInjection } from "./components/Composer";
import type { StagedContextItem } from "./components/ContextInspector";
import type { WidgetEntry } from "./components/ExtensionWidgets";
import type { ScheduledTaskView } from "./components/ScheduledTasksPanel";
import type { SideChatMessage } from "./components/SideChatPanel";
import type { Toast } from "./components/Toasts";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { WorktreeManager } from "./components/WorktreeManager";
import {
	collectDiagnostics,
	confirmPermission,
	openExternalUrl,
	pickWorkspaceFolder,
	revealItem,
	sideEngineTransport,
	writeClipboardText,
} from "./lib/desktop-bridge";
import { validateClipboardText, validateExternalUrl, validateHostArguments } from "./lib/host-policy";
import {
	appendStderr,
	appendUserMessage,
	engineInterrupted,
	initialViewModel,
	reduce,
	seedMessages,
	type ViewModel,
} from "./lib/reducer";
import {
	DesktopRpcClient,
	type EngineReadyInfo,
	type EngineStatus,
	RpcError,
	RpcTransportError,
	supportsCapability,
} from "./lib/rpc-client";
import type {
	ApprovalMode,
	AvailableCommand,
	BashResult,
	BranchMessage,
	EngineEvent,
	ExtensionUIRequest,
	ExtensionUIResponse,
	GitStatus,
	HostToolCallRequest,
	HostToolDefinition,
	HunkSelection,
	ImageContent,
	LoginProvider,
	McpServerStatus,
	MemorySearchResult,
	MemoryStatus,
	ModelInfo,
	PlanModeState,
	PluginDescriptor,
	SessionMessage,
	SessionStats,
	SessionSummary,
	SettingDescriptor,
	SettingsSnapshot,
	SubagentMessage,
	SubagentSnapshot,
	ThinkingLevel,
	WorkspaceEntry,
	WorkspaceFileChange,
	WorkspaceFileContent,
	WorktreeInfo,
} from "./lib/rpc-protocol";
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

const HOST_TOOL_DEFINITIONS: HostToolDefinition[] = [
	{
		name: "desktop_open_external",
		description: "Open an https URL in the system browser.",
		parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
	},
	{
		name: "desktop_reveal_item",
		description: "Reveal a file or folder in the system file manager.",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
	{
		name: "desktop_clipboard_write",
		description: "Copy text to the system clipboard.",
		parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	},
];
const cancelledHostRequests = new Set<string>();

function hostTextResult(text: string): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text", text }] };
}

function stringArgument(args: Record<string, unknown>, key: string): string | null {
	return typeof args[key] === "string" && args[key].length > 0 ? args[key] : null;
}

async function handleHostToolCall(client: DesktopRpcClient, request: HostToolCallRequest): Promise<void> {
	try {
		cancelledHostRequests.delete(request.id);
		const argumentError = validateHostArguments(request.arguments);
		if (argumentError) throw new Error(argumentError);
		switch (request.toolName) {
			case "desktop_open_external": {
				const value = stringArgument(request.arguments, "url");
				if (!value) throw new Error("url is required");
				const urlError = validateExternalUrl(value);
				if (urlError) throw new Error(urlError);
				if (!(await confirmPermission(`Allow OMP to open this URL?\n\n${value}`)))
					throw new Error("Permission denied");
				if (cancelledHostRequests.has(request.id)) throw new Error("Host tool request cancelled");
				await openExternalUrl(value);
				await client.respondHostTool(request, hostTextResult("URL opened"));
				return;
			}
			case "desktop_reveal_item": {
				const value = stringArgument(request.arguments, "path");
				if (!value) throw new Error("path is required");
				if (!(await confirmPermission(`Allow OMP to reveal this item?\n\n${value}`)))
					throw new Error("Permission denied");
				if (cancelledHostRequests.has(request.id)) throw new Error("Host tool request cancelled");
				await revealItem(value);
				await client.respondHostTool(request, hostTextResult("Item revealed"));
				return;
			}
			case "desktop_clipboard_write": {
				const value = stringArgument(request.arguments, "text");
				if (value === null) throw new Error("text is required");
				const clipboardError = validateClipboardText(value);
				if (clipboardError) throw new Error(clipboardError);
				if (!(await confirmPermission("Allow OMP to write text to the system clipboard?")))
					throw new Error("Permission denied");
				if (cancelledHostRequests.has(request.id)) throw new Error("Host tool request cancelled");
				await writeClipboardText(value);
				await client.respondHostTool(request, hostTextResult("Clipboard updated"));
				return;
			}
			default:
				throw new Error(`Host tool is not allowlisted: ${request.toolName}`);
		}
	} catch (error) {
		await client
			.respondHostTool(request, hostTextResult(error instanceof Error ? error.message : String(error)), true)
			.catch(() => {});
	} finally {
		cancelledHostRequests.delete(request.id);
	}
}

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

/** Events after which session metadata (model/thinking/name/count) may have changed. */
const REFRESH_EVENTS = new Set([
	"agent_end",
	"auto_compaction_end",
	"todo_reminder",
	"todo_auto_clear",
	"thinking_level_changed",
	"goal_updated",
]);

function compactionStatus(action: "context-full" | "handoff" | "shake" | "snapcompact", reason: string): string {
	const label =
		action === "handoff"
			? "handoff"
			: action === "shake"
				? "shake"
				: action === "snapcompact"
					? "snapcompact"
					: "context";
	return `Auto-${label} (${reason})…`;
}

export function App() {
	const [workspace, setWorkspace] = useState<string | null>(() => loadLastWorkspace());
	const [vm, dispatch] = useReducer(rootReducer, initialViewModel);
	const [status, setStatus] = useState<EngineStatus>("idle");
	const [statusDetail, setStatusDetail] = useState<string | undefined>();
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [session, setSession] = useState<SessionInfo>(EMPTY_SESSION);
	const [subagents, setSubagents] = useState<SubagentSnapshot[]>([]);
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
	const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
	const [worktreeManagerOpen, setWorktreeManagerOpen] = useState(false);
	const [worktreesLoading, setWorktreesLoading] = useState(false);
	const [worktreeMutatingPath, setWorktreeMutatingPath] = useState<string | null>(null);
	const [workspaceEntries, setWorkspaceEntries] = useState<WorkspaceEntry[]>([]);
	const [workspaceFileContent, setWorkspaceFileContent] = useState<WorkspaceFileContent | null>(null);
	const [selectedWorkspacePath, setSelectedWorkspacePath] = useState<string | null>(null);
	const [workspaceFilesLoading, setWorkspaceFilesLoading] = useState(false);
	const [workspaceFilesTruncated, setWorkspaceFilesTruncated] = useState(false);
	const [contextItems, setContextItems] = useState<StagedContextItem[]>([]);
	const [composerImages, setComposerImages] = useState<ImageContent[]>([]);
	const [contextSkills, setContextSkills] = useState<string[]>([]);
	const [contextMemoryBackend, setContextMemoryBackend] = useState<string | null>(null);
	const [contextSkillDetails, setContextSkillDetails] = useState<
		Array<{ name: string; description: string; filePath: string; source: string; hidden?: boolean }>
	>([]);
	const [contextSkillWarnings, setContextSkillWarnings] = useState<Array<{ skillPath: string; message: string }>>([]);
	const [browserUrl, setBrowserUrl] = useState("");
	const [browserSnapshot, setBrowserSnapshot] = useState("");
	const [browserBusy, setBrowserBusy] = useState(false);
	const sideClientRef = useRef<DesktopRpcClient | null>(null);
	const [sideChatReady, setSideChatReady] = useState(false);
	const [sideChatStarting, setSideChatStarting] = useState(false);
	const [sideChatMessages, setSideChatMessages] = useState<SideChatMessage[]>([]);
	const [sideChatWorktreePath, setSideChatWorktreePath] = useState<string | null>(null);
	const [scheduledTasks, setScheduledTasks] = useState<ScheduledTaskView[]>([]);
	const workspaceFilesRequestRef = useRef(false);
	const selectedWorkspacePathRef = useRef<string | null>(null);
	const [update, setUpdate] = useState<{ info: UpdateInfo; update: UpdateHandle } | null>(null);
	const [updateInstalling, setUpdateInstalling] = useState(false);
	const [injection, setInjection] = useState<ComposerInjection | undefined>();
	const [authPrompt, setAuthPrompt] = useState<AuthPrompt | null>(null);
	const [statuses, setStatuses] = useState<Record<string, string>>({});
	useEffect(() => {
		if (!window.desktop) return;
		let active = true;
		void window.desktop.listScheduledTasks().then(value => {
			if (active) setScheduledTasks(value as ScheduledTaskView[]);
		});
		const unlisten = window.desktop.onScheduledTasksChanged(value => setScheduledTasks(value as ScheduledTaskView[]));
		return () => {
			active = false;
			unlisten();
		};
	}, []);
	const [widgets, setWidgets] = useState<Record<string, WidgetEntry>>({});
	const [engineCapabilities, setEngineCapabilities] = useState<readonly string[]>([]);
	const engineCapabilitiesRef = useRef<readonly string[]>([]);
	const [bashOutput, setBashOutput] = useState("");
	const [bashRunning, setBashRunning] = useState(false);
	const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
	const [statsLoading, setStatsLoading] = useState(false);
	const [compacting, setCompacting] = useState(false);
	const [autoRetry, setAutoRetry] = useState(true);
	const [branchMessages, setBranchMessages] = useState<BranchMessage[]>([]);
	const [sessionActionRunning, setSessionActionRunning] = useState(false);
	const [availableCommands, setAvailableCommands] = useState<AvailableCommand[]>([]);
	const [subagentMessages, setSubagentMessages] = useState<Record<string, SubagentMessage[]>>({});
	const [docTitle, setDocTitle] = useState<string | undefined>();
	const [planMode, setPlanMode] = useState<PlanModeState | undefined>();
	const [settingsSnapshot, setSettingsSnapshot] = useState<SettingsSnapshot | null>(null);
	const [settingsLoading, setSettingsLoading] = useState(false);
	const [settingsSavingKey, setSettingsSavingKey] = useState<string | null>(null);
	const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([]);
	const [mcpLoading, setMcpLoading] = useState(false);
	const [memoryStatus, setMemoryStatus] = useState<MemoryStatus | null>(null);
	const [memorySearch, setMemorySearch] = useState<MemorySearchResult | null>(null);
	const [memoryLoading, setMemoryLoading] = useState(false);
	// Mirror of planMode read synchronously in the optimistic toggle, so a failed
	// `set_plan_mode` reverts to the exact prior snapshot without a stale closure.
	const planModeRef = useRef<PlanModeState | undefined>(undefined);
	planModeRef.current = planMode;
	const clientRef = useRef<DesktopRpcClient | null>(null);
	const injectNonce = useRef(0);
	const loginProviderRef = useRef<string | undefined>(undefined);
	// Latest workspace the engine should boot against. Set imperatively before the
	// boot effect runs so the (once-only) engine start reads the correct directory
	// without re-subscribing on every project switch.
	const workspaceRef = useRef<string | null>(workspace);
	// Set while the app intentionally reaps the engine (unmount / update install) so
	// the in-flight requests it rejects don't surface as "Login failed" style toasts.
	const userStoppingRef = useRef(false);

	const refreshState = useCallback(async () => {
		const client = clientRef.current;
		if (!client) return;
		try {
			const state = await client.getState();
			setSession({
				model: modelLabel(state.model?.provider, state.model?.id),
				thinkingLevel: state.thinkingLevel,
				sessionName: state.sessionName,
				messageCount: state.messageCount,
				approvalMode: state.approvalMode,
				autoCompactionEnabled: state.autoCompactionEnabled,
				steeringMode: state.steeringMode,
				followUpMode: state.followUpMode,
				interruptMode: state.interruptMode,
				todoPhases: state.todoPhases,
			});
			setPlanMode(state.planMode);
			if (typeof state.autoRetryEnabled === "boolean") setAutoRetry(state.autoRetryEnabled);
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
		if (!client || !supportsCapability(engineCapabilitiesRef.current, "get_workspace_diff")) return;
		try {
			setChanges(await client.getWorkspaceDiff());
		} catch {
			// transient; ignore
		}
	}, []);

	const refreshGitStatus = useCallback(async () => {
		const client = clientRef.current;
		if (!client || !supportsCapability(engineCapabilitiesRef.current, "get_git_status")) return;
		try {
			setGitStatus(await client.getGitStatus());
		} catch {
			// Keep the last status while a workspace mutation settles.
		}
	}, []);

	const refreshWorkspaceFiles = useCallback(async (query?: string) => {
		const client = clientRef.current;
		if (
			!client ||
			workspaceFilesRequestRef.current ||
			!supportsCapability(engineCapabilitiesRef.current, "list_workspace_files")
		)
			return;
		workspaceFilesRequestRef.current = true;
		setWorkspaceFilesLoading(true);
		try {
			const result = await client.listWorkspaceFiles(query, 5000);
			setWorkspaceEntries(result.entries);
			setWorkspaceFilesTruncated(result.truncated);
			const selectedPath = selectedWorkspacePathRef.current;
			if (selectedPath && supportsCapability(engineCapabilitiesRef.current, "read_workspace_file")) {
				setWorkspaceFileContent(await client.readWorkspaceFile(selectedPath).catch(() => null));
			}
		} catch {
			// Preserve the last successful tree while the filesystem is changing.
		} finally {
			workspaceFilesRequestRef.current = false;
			setWorkspaceFilesLoading(false);
		}
	}, []);

	const refreshContextSnapshot = useCallback(async () => {
		const client = clientRef.current;
		if (!client || !supportsCapability(engineCapabilitiesRef.current, "get_context_snapshot")) return;
		try {
			const snapshot = await client.getContextSnapshot();
			setContextSkills(snapshot.skills);
			setContextMemoryBackend(snapshot.memoryBackend);
			setContextSkillDetails(snapshot.skillDetails ?? []);
			setContextSkillWarnings(snapshot.skillWarnings ?? []);
		} catch {
			// Context metadata is supplementary; retain the last snapshot.
		}
	}, []);

	const refreshSessionStats = useCallback(async () => {
		const client = clientRef.current;
		if (!client || !supportsCapability(engineCapabilitiesRef.current, "get_session_stats")) return;
		setStatsLoading(true);
		try {
			setSessionStats(await client.getSessionStats());
		} catch {
			// transient; keep the previous snapshot
		} finally {
			setStatsLoading(false);
		}
	}, []);

	const refreshBranchMessages = useCallback(async () => {
		const client = clientRef.current;
		if (!client || !supportsCapability(engineCapabilitiesRef.current, "get_branch_messages")) return;
		try {
			setBranchMessages(await client.getBranchMessages());
		} catch {
			// transient; keep the previous choices
		}
	}, []);

	const refreshAvailableCommands = useCallback(async () => {
		const client = clientRef.current;
		if (!client || !supportsCapability(engineCapabilitiesRef.current, "get_available_commands")) return;
		try {
			setAvailableCommands(await client.getAvailableCommands());
		} catch {
			// transient; keep current command palette entries
		}
	}, []);

	const refreshSettings = useCallback(async () => {
		const client = clientRef.current;
		if (!client || !supportsCapability(engineCapabilitiesRef.current, "get_settings")) return;
		setSettingsLoading(true);
		try {
			setSettingsSnapshot(await client.getSettings());
		} catch {
			// Keep the previous snapshot; the panel exposes an explicit retry action.
		} finally {
			setSettingsLoading(false);
		}
	}, []);

	const refreshMcpStatus = useCallback(async () => {
		const client = clientRef.current;
		if (!client || !supportsCapability(engineCapabilitiesRef.current, "get_mcp_status")) return;
		setMcpLoading(true);
		try {
			setMcpServers(await client.getMcpStatus());
		} catch {
			// Keep the previous snapshot while the engine is restarting.
		} finally {
			setMcpLoading(false);
		}
	}, []);

	const refreshMemoryStatus = useCallback(async () => {
		const client = clientRef.current;
		if (!client || !supportsCapability(engineCapabilitiesRef.current, "get_memory_status")) return;
		setMemoryLoading(true);
		try {
			setMemoryStatus(await client.getMemoryStatus());
		} finally {
			setMemoryLoading(false);
		}
	}, []);

	const dismissToast = useCallback((id: string) => {
		setToasts(list => list.filter(toast => toast.id !== id));
	}, []);

	const addToast = useCallback((message: string, type: Toast["type"]) => {
		const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2)}`;
		setToasts(list => [...list, { id, message, type }]);
		setTimeout(() => setToasts(list => list.filter(toast => toast.id !== id)), 6000);
	}, []);

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

	const respondDialog = useCallback((response: ExtensionUIResponse) => {
		clientRef.current?.respondExtensionUI(response).catch(() => {});
		setDialogQueue(queue => queue.filter(dialog => dialog.id !== response.id));
	}, []);

	useEffect(() => {
		document.title = docTitle ? `${docTitle} — OMP` : "OMP";
	}, [docTitle]);

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

		const client = new DesktopRpcClient({
			onCommandOutput: frame => dispatch({ kind: "event", event: { type: "notice", text: frame.text } }),
			onAvailableCommandsUpdate: frame => setAvailableCommands(frame.commands),
			onSessionInfoUpdate: frame => {
				setSession(current => ({ ...current, sessionName: frame.title ?? current.sessionName }));
				void refreshSessions();
			},
			onConfigUpdate: frame => {
				setSession(current => ({
					...current,
					model: frame.model ? modelLabel(frame.model.provider, frame.model.id) : current.model,
					thinkingLevel: frame.thinkingLevel ?? current.thinkingLevel,
				}));
				void refreshState();
			},
			onExtensionError: frame => {
				const source = frame.extensionPath ? ` (${frame.extensionPath})` : "";
				dispatch({ kind: "stderr", line: `extension error${source}: ${frame.error}` });
				addToast(`Extension error${source}: ${frame.error}`, "error");
			},
			onHostToolCancel: request => {
				cancelledHostRequests.add(request.targetId);
				void client
					.respondHostToolById(request.targetId, hostTextResult("Host tool request cancelled"), true)
					.catch(() => {});
			},
			onHostToolUpdate: frame => {
				setStatuses(current => ({ ...current, [`host:${frame.id}`]: "updating" }));
			},
			onPromptResult: frame => {
				if (!frame.agentInvoked)
					dispatch({ kind: "event", event: { type: "notice", text: "Local command completed" } });
			},
			onHostUriCancel: request =>
				void client
					.respondHostUriById(request.targetId, { isError: true, content: "Host URI request cancelled" })
					.catch(() => {}),
			onEventGap: (expected, received) => {
				addToast(`Engine event gap detected (${expected}–${received}). Refreshing state…`, "warning");
				void Promise.all([
					refreshState(),
					refreshSubagents(),
					refreshSessions(),
					refreshSessionStats(),
					refreshBranchMessages(),
					refreshAvailableCommands(),
					refreshSettings(),
					refreshMcpStatus(),
				]);
			},
			onHostToolCall: request => void handleHostToolCall(client, request),
			onHostUriRequest: request =>
				void client
					.respondHostUri(request, { isError: true, content: "No host URI schemes are enabled" })
					.catch(() => {}),
			onReady: (info: EngineReadyInfo) => {
				if (cancelled) return;
				engineCapabilitiesRef.current = info.capabilities;
				setEngineCapabilities(info.capabilities);
			},
			onEvent: event => {
				dispatch({ kind: "event", event });
				switch (event.type) {
					case "auto_compaction_start":
						setStatuses(current => ({
							...current,
							"omp.maintenance": compactionStatus(event.action, event.reason),
						}));
						break;
					case "auto_compaction_end":
						setStatuses(current => {
							const next = { ...current };
							delete next["omp.maintenance"];
							return next;
						});
						break;
					case "auto_retry_start":
						setStatuses(current => ({
							...current,
							"omp.retry": `Retry ${event.attempt}/${event.maxAttempts} in ${Math.round(event.delayMs / 1000)}s…`,
						}));
						break;
					case "auto_retry_end":
						setStatuses(current => {
							const next = { ...current };
							delete next["omp.retry"];
							return next;
						});
						break;
					case "ttsr_triggered":
						addToast(
							`TTSR triggered${event.rules.length ? `: ${event.rules.map(rule => rule.name).join(", ")}` : ""}`,
							"warning",
						);
						break;
					case "todo_reminder":
						addToast(`Todo reminder ${event.attempt}/${event.maxAttempts}`, "warning");
						break;
				}
				if (event.type === "plan_mode_changed") {
					setPlanMode(event.planMode);
				}
				if (REFRESH_EVENTS.has(event.type)) {
					void refreshState();
					void refreshWorkspaceDiff();
					void refreshGitStatus();
					void refreshSessionStats();
					void refreshBranchMessages();
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
			},
			onStderr: line => dispatch({ kind: "stderr", line }),
			onSubagentUpdate: () => void refreshSubagents(),
			onExtensionUI: request => handleExtensionUI(request),
		});
		clientRef.current = client;

		void (async () => {
			try {
				await client.start(workspaceRef.current ?? undefined);
				if (cancelled) return;
				await client.setHostTools(HOST_TOOL_DEFINITIONS).catch(() => []);
				await client.setHostUriSchemes([]).catch(() => []);
				const [availableModels] = await Promise.all([
					client.getAvailableModels(),
					refreshState(),
					refreshLoginProviders(),
					refreshSessions(),
				]);
				if (cancelled) return;
				setModels(availableModels);
				await client.setSubagentSubscription("progress").catch(() => {});
				// Workspace diff can be slow on large repos; run it after the core
				// state is live so a slow scan never delays models/account/history.
				void refreshWorkspaceDiff();
				void refreshGitStatus();
				void refreshSessionStats();
				void refreshBranchMessages();
				void refreshAvailableCommands();
				void refreshSettings();
				void refreshContextSnapshot();
			} catch {
				// status/detail already surfaced via onStatus("error", …)
			}
		})();

		return () => {
			cancelled = true;
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
		refreshSessionStats,
		refreshBranchMessages,
		refreshAvailableCommands,
		refreshSettings,
		refreshContextSnapshot,
		addToast,
		handleExtensionUI,
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

	const onLoadSubagentMessages = useCallback(
		async (agent: SubagentSnapshot) => {
			const client = clientRef.current;
			if (!client || !supportsCapability(engineCapabilitiesRef.current, "get_subagent_messages")) return;
			try {
				const result = await client.getSubagentMessages({ subagentId: agent.id, sessionFile: agent.sessionFile });
				setSubagentMessages(current => ({ ...current, [agent.id]: result.messages }));
			} catch (err) {
				reportError("load subagent messages failed", err);
			}
		},
		[reportError],
	);

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

	const onStageHunks = useCallback(
		async (selections: HunkSelection[]) => {
			const client = clientRef.current;
			if (!client || !supportsCapability(engineCapabilities, "stage_hunks")) return;
			try {
				await client.stageHunks(selections);
				await Promise.all([refreshWorkspaceDiff(), refreshGitStatus()]);
			} catch (err) {
				reportError("stage failed", err);
			}
		},
		[engineCapabilities, refreshGitStatus, refreshWorkspaceDiff, reportError],
	);

	const onUnstage = useCallback(
		async (files?: string[]) => {
			const client = clientRef.current;
			if (!client || !supportsCapability(engineCapabilities, "unstage")) return;
			try {
				await client.unstage(files);
				await Promise.all([refreshWorkspaceDiff(), refreshGitStatus()]);
			} catch (err) {
				reportError("unstage failed", err);
			}
		},
		[engineCapabilities, refreshGitStatus, refreshWorkspaceDiff, reportError],
	);

	const onRevertFiles = useCallback(
		async (files: string[]) => {
			const client = clientRef.current;
			if (!client || files.length === 0 || !supportsCapability(engineCapabilities, "revert_files")) return;
			if (!(await confirmPermission("Revert selected tracked changes? This discards local edits."))) return;
			try {
				await client.revertFiles(files);
				await Promise.all([refreshWorkspaceDiff(), refreshGitStatus()]);
				addToast("Changes reverted", "info");
			} catch (err) {
				reportError("revert failed", err);
				addToast("Could not revert changes", "error");
			}
		},
		[addToast, engineCapabilities, refreshGitStatus, refreshWorkspaceDiff, reportError],
	);

	const onCommit = useCallback(async () => {
		const client = clientRef.current;
		if (!client || !supportsCapability(engineCapabilities, "commit") || gitStatus.staged === 0) return;
		const message = window.prompt("Commit message")?.trim();
		if (!message) return;
		if (!(await confirmPermission(`Commit ${gitStatus.staged} staged file${gitStatus.staged === 1 ? "" : "s"}?`)))
			return;
		try {
			const result = await client.commit(message);
			await Promise.all([refreshWorkspaceDiff(), refreshGitStatus()]);
			addToast(result.stdout.trim() || "Commit created", "info");
		} catch (err) {
			reportError("commit failed", err);
			addToast("Could not create commit", "error");
		}
	}, [addToast, engineCapabilities, gitStatus.staged, refreshGitStatus, refreshWorkspaceDiff, reportError]);

	const onPush = useCallback(async () => {
		const client = clientRef.current;
		if (!client || !supportsCapability(engineCapabilities, "push") || !gitStatus.branch) return;
		if (
			!(await confirmPermission(
				`Push branch ${gitStatus.branch} to its configured remote? This publishes local commits.`,
			))
		)
			return;
		try {
			await client.push();
			addToast(`Pushed ${gitStatus.branch}`, "info");
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			const category = /auth|credential|permission denied|403|401/i.test(detail)
				? "Authentication failed"
				: /network|timed? out|resolve host|connection|offline/i.test(detail)
					? "Network error"
					: "Push failed";
			reportError("push failed", err);
			addToast(`${category}: ${detail}`, "error");
		}
	}, [addToast, engineCapabilities, gitStatus.branch, reportError]);

	const onCreateWorktree = useCallback(async () => {
		const client = clientRef.current;
		if (!client || !workspace || !supportsCapability(engineCapabilities, "create_worktree")) return;
		const ref = window.prompt("Git ref for the new worktree", gitStatus.branch ?? "HEAD")?.trim();
		if (!ref) return;
		const worktreePath = window.prompt("Absolute worktree path", `${workspace}-worktree`)?.trim();
		if (!worktreePath) return;
		if (!(await confirmPermission(`Create permanent worktree at ${worktreePath} from ${ref}?`))) return;
		try {
			await client.createWorktree(worktreePath, ref);
			addToast(`Worktree created: ${worktreePath}`, "info");
		} catch (err) {
			reportError("create worktree failed", err);
			addToast(err instanceof Error ? err.message : "Could not create worktree", "error");
		}
	}, [addToast, engineCapabilities, gitStatus.branch, reportError, workspace]);

	const onCreatePullRequest = useCallback(async () => {
		const client = clientRef.current;
		if (!client || !gitStatus.branch || !supportsCapability(engineCapabilities, "create_pull_request")) return;
		const title = window.prompt("Pull request title")?.trim();
		if (!title) return;
		const body = window.prompt("Pull request description", "") ?? "";
		if (!(await confirmPermission(`Create a GitHub pull request from ${gitStatus.branch}?`))) return;
		try {
			const url = await client.createPullRequest(title, body);
			addToast("Pull request created", "info");
			if (url) await openExternalUrl(url);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			reportError("create pull request failed", err);
			addToast(/auth|not logged/i.test(detail) ? `GitHub authentication required: ${detail}` : detail, "error");
		}
	}, [addToast, engineCapabilities, gitStatus.branch, reportError]);

	const onRunBash = useCallback(
		(command: string) => {
			const client = clientRef.current;
			if (!client || bashRunning || !supportsCapability(engineCapabilities, "bash")) return;
			setBashRunning(true);
			setBashOutput(`$ ${command}\n`);
			void client
				.bash(command)
				.then((result: BashResult) => {
					setBashOutput(`$ ${command}\n${result.output}\n\n[exit ${result.exitCode ?? "cancelled"}]`);
				})
				.catch(err => reportError("bash failed", err))
				.finally(() => setBashRunning(false));
		},
		[bashRunning, engineCapabilities, reportError],
	);

	const onAbortBash = useCallback(() => {
		if (!bashRunning || !supportsCapability(engineCapabilities, "abort_bash")) return;
		void clientRef.current?.abortBash().catch(err => reportError("abort bash failed", err));
	}, [bashRunning, engineCapabilities, reportError]);

	const onCompact = useCallback(() => {
		const client = clientRef.current;
		if (!client || compacting || !supportsCapability(engineCapabilities, "compact")) return;
		if (!window.confirm("Compact this session context? The current transcript remains saved.")) return;
		setCompacting(true);
		void client
			.compact()
			.then(() => Promise.all([refreshState(), refreshSessionStats()]))
			.catch(err => reportError("compact failed", err))
			.finally(() => setCompacting(false));
	}, [compacting, engineCapabilities, refreshSessionStats, refreshState, reportError]);

	const onSetAutoRetry = useCallback(
		(enabled: boolean) => {
			const client = clientRef.current;
			if (!client || !supportsCapability(engineCapabilities, "set_auto_retry")) return;
			const previous = autoRetry;
			setAutoRetry(enabled);
			void client.setAutoRetry(enabled).catch(err => {
				setAutoRetry(previous);
				reportError("set auto retry failed", err);
			});
		},
		[autoRetry, engineCapabilities, reportError],
	);

	const onAbortRetry = useCallback(() => {
		if (!supportsCapability(engineCapabilities, "abort_retry")) return;
		void clientRef.current?.abortRetry().catch(err => reportError("abort retry failed", err));
	}, [engineCapabilities, reportError]);

	const onBranch = useCallback(
		(entryId: string) => {
			const client = clientRef.current;
			if (!client || sessionActionRunning || !supportsCapability(engineCapabilities, "branch")) return;
			if (!window.confirm("Create a new branch from this message?")) return;
			setSessionActionRunning(true);
			void client
				.branch(entryId)
				.then(async result => {
					if (result.cancelled) return;
					dispatch({ kind: "seed", messages: await client.getMessages() });
					await Promise.all([refreshState(), refreshSessions(), refreshSessionStats(), refreshBranchMessages()]);
				})
				.catch(err => reportError("branch failed", err))
				.finally(() => setSessionActionRunning(false));
		},
		[
			engineCapabilities,
			refreshBranchMessages,
			refreshSessionStats,
			refreshSessions,
			refreshState,
			reportError,
			sessionActionRunning,
		],
	);

	const onCopyLast = useCallback(() => {
		const client = clientRef.current;
		if (!client || sessionActionRunning || !supportsCapability(engineCapabilities, "get_last_assistant_text")) return;
		setSessionActionRunning(true);
		void client
			.getLastAssistantText()
			.then(async text => {
				if (!text) {
					addToast("No assistant response to copy.", "info");
					return;
				}
				await writeClipboardText(text);
				addToast("Copied the last response.", "info");
			})
			.catch(err => reportError("copy last response failed", err))
			.finally(() => setSessionActionRunning(false));
	}, [addToast, engineCapabilities, reportError, sessionActionRunning]);

	const onExport = useCallback(() => {
		const client = clientRef.current;
		if (!client || sessionActionRunning || !supportsCapability(engineCapabilities, "export_html")) return;
		setSessionActionRunning(true);
		void client
			.exportHtml()
			.then(async path => {
				await revealItem(path);
				addToast(`Exported session to ${path}`, "info");
			})
			.catch(err => reportError("export failed", err))
			.finally(() => setSessionActionRunning(false));
	}, [addToast, engineCapabilities, reportError, sessionActionRunning]);

	const onOpenWorkspaceFile = useCallback(
		async (filePath: string) => {
			const client = clientRef.current;
			if (!client || !supportsCapability(engineCapabilities, "read_workspace_file")) return;
			setSelectedWorkspacePath(filePath);
			selectedWorkspacePathRef.current = filePath;
			try {
				setWorkspaceFileContent(await client.readWorkspaceFile(filePath));
			} catch (err) {
				setWorkspaceFileContent(null);
				reportError("read workspace file failed", err);
				addToast(err instanceof Error ? err.message : "Could not preview file", "error");
			}
		},
		[addToast, engineCapabilities, reportError],
	);

	const onRevealWorkspaceFile = useCallback(
		(filePath: string) => {
			if (!workspace) return;
			const absolute = `${workspace.replace(/[\\/]+$/, "")}/${filePath}`;
			void revealItem(absolute).catch(err => reportError("reveal workspace file failed", err));
		},
		[reportError, workspace],
	);

	const onAddWorkspaceContext = useCallback(
		(filePath: string, selection?: string) => {
			const boundedSelection = selection?.slice(0, 32 * 1024);
			const item: StagedContextItem = {
				id: `context_${Date.now()}_${Math.random().toString(36).slice(2)}`,
				kind: boundedSelection ? "selection" : "file",
				path: filePath,
				content: boundedSelection,
			};
			setContextItems(current => [
				...current.filter(existing => !(existing.kind === item.kind && existing.path === filePath)),
				item,
			]);
			addToast(boundedSelection ? "Selected code staged in context" : "File staged in context", "info");
		},
		[addToast],
	);

	const onBrowserOpen = useCallback(
		async (url: string) => {
			const client = clientRef.current;
			if (!client || !supportsCapability(engineCapabilities, "browser_open")) return;
			try {
				setBrowserBusy(true);
				const result = await client.browserOpen(url);
				setBrowserUrl(result.url);
				setBrowserSnapshot("");
			} catch (err) {
				reportError("browser open failed", err);
				addToast(err instanceof Error ? err.message : "Could not open URL", "error");
			} finally {
				setBrowserBusy(false);
			}
		},
		[addToast, engineCapabilities, reportError],
	);

	const onBrowserHistory = useCallback(
		async (direction: "back" | "forward" | "reload") => {
			const client = clientRef.current;
			if (!client || !supportsCapability(engineCapabilities, "browser_history")) return;
			try {
				setBrowserBusy(true);
				const result = await client.browserHistory(direction);
				setBrowserUrl(result.url);
				setBrowserSnapshot("");
			} catch (err) {
				reportError("browser navigation failed", err);
			} finally {
				setBrowserBusy(false);
			}
		},
		[engineCapabilities, reportError],
	);

	const onBrowserSnapshot = useCallback(async () => {
		const client = clientRef.current;
		if (!client || !supportsCapability(engineCapabilities, "browser_snapshot")) return;
		try {
			setBrowserBusy(true);
			const result = await client.browserSnapshot();
			setBrowserUrl(result.url || browserUrl);
			setBrowserSnapshot(result.snapshot);
		} catch (err) {
			reportError("browser snapshot failed", err);
		} finally {
			setBrowserBusy(false);
		}
	}, [browserUrl, engineCapabilities, reportError]);

	const onBrowserAddContext = useCallback(() => {
		if (browserSnapshot) onAddWorkspaceContext(`browser:${browserUrl}`, browserSnapshot);
	}, [browserSnapshot, browserUrl, onAddWorkspaceContext]);

	const onBrowserExternal = useCallback(
		(url: string) => {
			if (validateExternalUrl(url))
				void openExternalUrl(url).catch(err => reportError("open browser URL failed", err));
		},
		[reportError],
	);

	const onSaveScheduledTask = useCallback(
		async (
			input: Omit<ScheduledTaskView, "id" | "nextRunAt" | "lastRunAt" | "lastStatus" | "lastError" | "runs"> & {
				id?: string;
			},
		) => {
			try {
				await window.desktop.upsertScheduledTask(input);
				addToast("Scheduled task saved", "info");
			} catch (err) {
				reportError("save scheduled task failed", err);
				addToast("Could not save scheduled task", "error");
			}
		},
		[addToast, reportError],
	);

	const onRemoveScheduledTask = useCallback(
		async (id: string) => {
			if (!window.confirm("Remove this scheduled task?")) return;
			try {
				await window.desktop.removeScheduledTask(id);
				addToast("Scheduled task removed", "info");
			} catch (err) {
				reportError("remove scheduled task failed", err);
				addToast("Could not remove scheduled task", "error");
			}
		},
		[addToast, reportError],
	);

	const onRunScheduledTask = useCallback(
		async (id: string) => {
			if (!window.confirm("Run this scheduled task now?")) return;
			try {
				await window.desktop.runScheduledTaskNow(id);
				addToast("Scheduled task started", "info");
			} catch (err) {
				reportError("run scheduled task failed", err);
				addToast(err instanceof Error ? err.message : "Could not run scheduled task", "error");
			}
		},
		[addToast, reportError],
	);

	const onEnsureSideChat = useCallback(async () => {
		if (sideClientRef.current || !workspace || sideChatStarting) return;
		setSideChatStarting(true);
		const client = new DesktopRpcClient(
			{
				onReady: () => setSideChatReady(true),
				onStatus: status => {
					if (status === "stopped" || status === "error") setSideChatReady(false);
				},
				onStderr: line => setSideChatMessages(messages => [...messages, { role: "system", text: line }]),
			},
			sideEngineTransport,
		);
		sideClientRef.current = client;
		try {
			await client.start(sideChatWorktreePath ?? workspace);
			setSideChatMessages([]);
		} catch (err) {
			sideClientRef.current = null;
			setSideChatReady(false);
			reportError("side chat start failed", err);
			addToast("Could not start isolated side chat", "error");
		} finally {
			setSideChatStarting(false);
		}
	}, [addToast, reportError, sideChatStarting, sideChatWorktreePath, workspace]);

	const onSendSideChat = useCallback(
		async (text: string) => {
			const client = sideClientRef.current;
			if (!client || !sideChatReady) return;
			setSideChatMessages(messages => [...messages, { role: "user", text }]);
			try {
				await client.prompt(text);
				const messages = await client.getMessages();
				setSideChatMessages(
					messages
						.filter(message => message.role === "user" || message.role === "assistant")
						.map(message => ({
							role: message.role === "user" ? "user" : "assistant",
							text:
								typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
						})),
				);
			} catch (err) {
				reportError("side chat prompt failed", err);
				setSideChatMessages(messages => [
					...messages,
					{ role: "system", text: err instanceof Error ? err.message : String(err) },
				]);
			}
		},
		[reportError, sideChatReady],
	);

	const onForkSideChat = useCallback(async () => {
		const client = sideClientRef.current;
		if (!client || !sideChatReady) return;
		if (contextItems.length === 0) {
			addToast("No staged context to fork", "info");
			return;
		}
		const contextText = contextItems
			.map(item =>
				item.kind === "selection" ? `Selected code from @${item.path}:\n${item.content ?? ""}` : `@${item.path}`,
			)
			.join("\n\n");
		try {
			await client.prompt(
				`Use this forked context:\n\n${contextText}\n\nAcknowledge the context and wait for the next request.`,
			);
			const messages = await client.getMessages();
			setSideChatMessages(
				messages
					.filter(message => message.role === "user" || message.role === "assistant")
					.map(message => ({
						role: message.role === "user" ? "user" : "assistant",
						text: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
					})),
			);
			addToast("Context forked into Side Chat", "info");
		} catch (err) {
			reportError("side chat fork failed", err);
		}
	}, [addToast, contextItems, reportError, sideChatReady]);

	const onAddSideChatResult = useCallback(() => {
		const last = [...sideChatMessages].reverse().find(message => message.role === "assistant");
		if (!last) return;
		const item: StagedContextItem = {
			id: `context_side_${Date.now()}`,
			kind: "selection",
			path: "side-chat",
			content: last.text.slice(0, 32 * 1024),
		};
		setContextItems(items => [...items.filter(existing => existing.path !== "side-chat"), item]);
		addToast("Side Chat response staged in main context", "info");
	}, [addToast, sideChatMessages]);

	const onToggleSideChatWorktree = useCallback(async () => {
		const mainClient = clientRef.current;
		if (!workspace || !mainClient || !supportsCapability(engineCapabilities, "create_worktree")) return;
		if (sideChatWorktreePath) {
			if (!window.confirm(`Remove isolated worktree at ${sideChatWorktreePath}? Dirty files will be preserved.`))
				return;
			try {
				const sideClient = sideClientRef.current;
				sideClientRef.current = null;
				setSideChatReady(false);
				if (sideClient) await sideClient.stop();
				await mainClient.removeWorktree(sideChatWorktreePath, false);
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
		if (!(await confirmPermission(`Create isolated Side Chat worktree at ${requestedPath}?`))) return;
		try {
			await mainClient.createWorktree(requestedPath, gitStatus.branch);
			const sideClient = sideClientRef.current;
			if (sideClient) {
				sideClientRef.current = null;
				setSideChatReady(false);
				await sideClient.stop();
			}
			setSideChatWorktreePath(requestedPath);
			addToast("Side Chat will use the isolated worktree", "info");
		} catch (err) {
			reportError("create side chat worktree failed", err);
			addToast("Could not create isolated worktree", "error");
		}
	}, [addToast, engineCapabilities, gitStatus.branch, reportError, sideChatWorktreePath, workspace]);

	const onCloseSideChat = useCallback(async () => {
		const client = sideClientRef.current;
		sideClientRef.current = null;
		setSideChatReady(false);
		setSideChatStarting(false);
		setSideChatMessages([]);
		void client?.stop();
		if (sideChatWorktreePath && clientRef.current) {
			try {
				await clientRef.current.removeWorktree(sideChatWorktreePath, false);
				setSideChatWorktreePath(null);
			} catch (err) {
				reportError("cleanup side chat worktree failed", err);
				addToast("Side worktree retained because it is dirty", "error");
			}
		}
	}, [addToast, reportError, sideChatWorktreePath]);

	const onHandoff = useCallback(() => {
		const client = clientRef.current;
		if (!client || sessionActionRunning || vm.streaming || !supportsCapability(engineCapabilities, "handoff")) return;
		if (!window.confirm("Create a handoff summary and start a fresh session?")) return;
		setSessionActionRunning(true);
		void client
			.handoff()
			.then(async result => {
				if (!result) return;
				dispatch({ kind: "seed", messages: await client.getMessages() });
				await Promise.all([refreshState(), refreshSessions(), refreshSessionStats(), refreshBranchMessages()]);
				addToast("Handoff completed.", "info");
			})
			.catch(err => reportError("handoff failed", err))
			.finally(() => setSessionActionRunning(false));
	}, [
		addToast,
		engineCapabilities,
		refreshBranchMessages,
		refreshSessionStats,
		refreshSessions,
		refreshState,
		reportError,
		sessionActionRunning,
		vm.streaming,
	]);

	const onCycleThinking = useCallback(() => {
		if (!supportsCapability(engineCapabilities, "cycle_thinking_level")) return;
		void clientRef.current
			?.cycleThinkingLevel()
			.then(refreshState)
			.catch(err => reportError("cycle thinking failed", err));
	}, [engineCapabilities, refreshState, reportError]);

	const onSetSteering = useCallback(
		(mode: "all" | "one-at-a-time") => {
			if (!supportsCapability(engineCapabilities, "set_steering_mode")) return;
			void clientRef.current
				?.setSteeringMode(mode)
				.then(refreshState)
				.catch(err => reportError("set steering mode failed", err));
		},
		[engineCapabilities, refreshState, reportError],
	);

	const onSetFollowUp = useCallback(
		(mode: "all" | "one-at-a-time") => {
			if (!supportsCapability(engineCapabilities, "set_follow_up_mode")) return;
			void clientRef.current
				?.setFollowUpMode(mode)
				.then(refreshState)
				.catch(err => reportError("set follow-up mode failed", err));
		},
		[engineCapabilities, refreshState, reportError],
	);

	const onSetInterrupt = useCallback(
		(mode: "immediate" | "wait") => {
			if (!supportsCapability(engineCapabilities, "set_interrupt_mode")) return;
			void clientRef.current
				?.setInterruptMode(mode)
				.then(refreshState)
				.catch(err => reportError("set interrupt mode failed", err));
		},
		[engineCapabilities, refreshState, reportError],
	);

	const onSetAutoCompaction = useCallback(
		(enabled: boolean) => {
			if (!supportsCapability(engineCapabilities, "set_auto_compaction")) return;
			void clientRef.current
				?.setAutoCompaction(enabled)
				.then(refreshState)
				.catch(err => reportError("set auto compaction failed", err));
		},
		[engineCapabilities, refreshState, reportError],
	);

	const switchWorkspaceTo = useCallback(
		async (folder: string) => {
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
			setWorkspaceEntries([]);
			setWorkspaceFileContent(null);
			setSelectedWorkspacePath(null);
			selectedWorkspacePathRef.current = null;
			setWorkspaceFilesTruncated(false);
			setContextItems([]);
			setComposerImages([]);
			setContextSkills([]);
			setContextMemoryBackend(null);
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
					]);
					setModels(await client.getAvailableModels().catch(() => []));
				} catch (err) {
					reportError("switch workspace failed", err);
				}
			} else {
				setStatus("idle");
				setStatusDetail(undefined);
			}
		},
		[refreshGitStatus, refreshLoginProviders, refreshSessions, refreshState, refreshWorkspaceDiff, reportError],
	);

	const openFolder = useCallback(async () => {
		const folder = await pickWorkspaceFolder();
		if (folder) await switchWorkspaceTo(folder);
	}, [switchWorkspaceTo]);

	const refreshWorktrees = useCallback(async () => {
		const client = clientRef.current;
		if (!client || !supportsCapability(engineCapabilitiesRef.current, "list_worktrees")) return;
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

	const onOpenWorktree = useCallback(
		async (worktreePath: string) => {
			setWorktreeMutatingPath(worktreePath);
			try {
				await switchWorkspaceTo(worktreePath);
				setWorktreeManagerOpen(false);
			} finally {
				setWorktreeMutatingPath(null);
			}
		},
		[switchWorkspaceTo],
	);

	const onRemoveWorktree = useCallback(
		async (worktreePath: string, force: boolean) => {
			const client = clientRef.current;
			if (!client || !supportsCapability(engineCapabilities, "remove_worktree")) return;
			const warning = force
				? `Force-remove ${worktreePath}? Uncommitted changes in that worktree will be lost.`
				: `Remove worktree ${worktreePath}? Git will refuse if it contains uncommitted changes.`;
			if (!(await confirmPermission(warning))) return;
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
		[addToast, engineCapabilities, refreshWorktrees, reportError],
	);

	const consumeContext = useCallback(
		(text: string): string => {
			if (contextItems.length === 0) return text;
			const contextText = contextItems
				.map(item =>
					item.kind === "selection" ? `Selected code from @${item.path}:\n${item.content ?? ""}` : `@${item.path}`,
				)
				.join("\n\n");
			setContextItems([]);
			return `${contextText}\n\n${text}`;
		},
		[contextItems],
	);

	const onRemoveContextItem = useCallback((id: string) => {
		setContextItems(items => items.filter(item => item.id !== id));
	}, []);

	const onClearContext = useCallback(() => {
		setContextItems([]);
		setComposerImages([]);
	}, []);

	const onSend = useCallback(
		(text: string, images: ImageContent[]) => {
			const composedText = consumeContext(text);
			dispatch({ kind: "user", text: composedText, images });
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
			client
				.prompt(composedText, images)
				.then(result => {
					if (result?.agentInvoked === false) dispatch({ kind: "streaming", value: false });
				})
				.catch(err => {
					dispatch({ kind: "streaming", value: false });
					reportError("send failed", err);
				});
		},
		[consumeContext, reportError],
	);

	const onAbortAndPrompt = useCallback(
		(text: string, images: ImageContent[]) => {
			const client = clientRef.current;
			if (!client || !supportsCapability(engineCapabilities, "abort_and_prompt")) return;
			const composedText = consumeContext(text);
			dispatch({ kind: "user", text: composedText, images });
			dispatch({ kind: "streaming", value: true });
			void client.abortAndPrompt(composedText, images).catch(err => {
				dispatch({ kind: "streaming", value: false });
				reportError("replace prompt failed", err);
			});
		},
		[consumeContext, engineCapabilities, reportError],
	);

	const onSteer = useCallback(
		(text: string, images: ImageContent[]) => {
			const client = clientRef.current;
			if (!client || !supportsCapability(engineCapabilities, "steer")) return;
			const composedText = consumeContext(text);
			dispatch({ kind: "user", text: composedText, images });
			void client.steer(composedText, images).catch(err => reportError("steer failed", err));
		},
		[consumeContext, engineCapabilities, reportError],
	);

	const onFollowUp = useCallback(
		(text: string, images: ImageContent[]) => {
			const client = clientRef.current;
			if (!client || !supportsCapability(engineCapabilities, "follow_up")) return;
			const composedText = consumeContext(text);
			dispatch({ kind: "user", text: composedText, images });
			void client.followUp(composedText, images).catch(err => reportError("follow-up failed", err));
		},
		[consumeContext, engineCapabilities, reportError],
	);

	const onCycleModel = useCallback(() => {
		const client = clientRef.current;
		if (!client || !supportsCapability(engineCapabilities, "cycle_model")) return;
		void client
			.cycleModel()
			.then(async model => {
				if (model) addToast(`Model changed to ${model.provider}/${model.id}`, "info");
				await refreshState();
			})
			.catch(err => reportError("cycle model failed", err));
	}, [addToast, engineCapabilities, refreshState, reportError]);

	const onAbort = useCallback(() => {
		// Reflect the stop request immediately (button → "Stopping…", disabled) so a
		// slow turn teardown doesn't look unresponsive. The `aborting` effect clears
		// this once streaming ends via agent_end / engine-stopped.
		setAborting(true);
		clientRef.current?.abort().catch(() => {});
	}, []);

	const onRestartEngine = useCallback(() => {
		const client = clientRef.current;
		if (!client) return;
		void client
			.restart(workspaceRef.current ?? undefined)
			.then(async () => {
				setModels(await client.getAvailableModels().catch(() => []));
				await Promise.all([refreshState(), refreshLoginProviders(), refreshSessions(), refreshWorkspaceDiff()]);
			})
			.catch(err => reportError("restart engine failed", err));
	}, [refreshLoginProviders, refreshSessions, refreshState, refreshWorkspaceDiff, reportError]);

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
		client
			.newSession()
			.then(() => Promise.all([refreshState(), refreshSessions(), refreshWorkspaceDiff()]))
			.catch(err => reportError("new session failed", err));
	}, [refreshState, refreshSessions, refreshWorkspaceDiff, reportError]);

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

	const onCopyDiagnostics = useCallback(() => {
		void collectDiagnostics()
			.then(snapshot =>
				writeClipboardText(JSON.stringify({ ...snapshot, generatedAt: new Date().toISOString() }, null, 2)),
			)
			.then(() => addToast("Diagnostics copied to clipboard", "info"))
			.catch(error =>
				addToast(
					`Could not collect diagnostics: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				),
			);
	}, [addToast]);

	const onUpdateSetting = useCallback(
		async (path: string, value: unknown) => {
			const client = clientRef.current;
			if (!client || settingsSavingKey) return;
			const previous = settingsSnapshot;
			setSettingsSavingKey(path);
			setSettingsSnapshot(current =>
				current
					? {
							...current,
							settings: current.settings.map(setting =>
								setting.path === path ? { ...setting, value } : setting,
							),
						}
					: current,
			);
			try {
				const updated: SettingDescriptor = await client.setSetting(path, value);
				setSettingsSnapshot(current =>
					current
						? {
								...current,
								settings: current.settings.map(setting => (setting.path === path ? updated : setting)),
							}
						: current,
				);
				addToast(
					updated.activation === "next_engine_restart"
						? `${updated.label} saved — restart the engine to apply it`
						: `${updated.label} saved`,
					"info",
				);
			} catch (error) {
				setSettingsSnapshot(previous);
				addToast(`Could not save setting: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				setSettingsSavingKey(null);
			}
		},
		[addToast, settingsSavingKey, settingsSnapshot],
	);

	const onSetPluginEnabled = useCallback(
		async (name: string, enabled: boolean) => {
			const client = clientRef.current;
			const key = `plugin:${name}`;
			if (!client || settingsSavingKey) return;
			const previous = settingsSnapshot;
			setSettingsSavingKey(key);
			setSettingsSnapshot(current =>
				current
					? {
							...current,
							plugins: current.plugins.map(plugin => (plugin.name === name ? { ...plugin, enabled } : plugin)),
						}
					: current,
			);
			try {
				const updated: PluginDescriptor = await client.setPluginEnabled(name, enabled);
				setSettingsSnapshot(current =>
					current
						? { ...current, plugins: current.plugins.map(plugin => (plugin.name === name ? updated : plugin)) }
						: current,
				);
				addToast(`${name} ${enabled ? "enabled" : "disabled"}`, "info");
			} catch (error) {
				setSettingsSnapshot(previous);
				addToast(`Could not update plugin: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				setSettingsSavingKey(null);
			}
		},
		[addToast, settingsSavingKey, settingsSnapshot],
	);

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
				capabilities={engineCapabilities}
				availableCommands={availableCommands}
				bashOutput={bashOutput}
				bashRunning={bashRunning}
				onRunBash={onRunBash}
				onAbortBash={onAbortBash}
				sessionStats={sessionStats}
				statsLoading={statsLoading}
				compacting={compacting}
				autoRetry={autoRetry}
				onRefreshStats={refreshSessionStats}
				onCompact={onCompact}
				onSetAutoRetry={onSetAutoRetry}
				onAbortRetry={onAbortRetry}
				branchMessages={branchMessages}
				sessionActionRunning={sessionActionRunning}
				onBranch={onBranch}
				onCopyLast={onCopyLast}
				onExport={onExport}
				onHandoff={onHandoff}
				onCycleThinking={onCycleThinking}
				onSetSteering={onSetSteering}
				onSetFollowUp={onSetFollowUp}
				onSetInterrupt={onSetInterrupt}
				onSetAutoCompaction={onSetAutoCompaction}
				models={models}
				session={session}
				subagents={subagents}
				loginProviders={loginProviders}
				sessions={sessions}
				statuses={statuses}
				widgets={widgets}
				planMode={planMode}
				settingsSnapshot={settingsSnapshot}
				settingsLoading={settingsLoading}
				settingsSavingKey={settingsSavingKey}
				onRefreshSettings={refreshSettings}
				onUpdateSetting={onUpdateSetting}
				onSetPluginEnabled={onSetPluginEnabled}
				onInstallPlugin={async spec => {
					const client = clientRef.current;
					if (
						!client ||
						!(await confirmPermission(`Install plugin ${spec}? This may download and execute package code.`))
					)
						return;
					setSettingsSavingKey(`plugin:${spec}`);
					try {
						await client.installPlugin(spec);
						await refreshSettings();
						addToast(`${spec} installed`, "info");
					} catch (error) {
						addToast(`Plugin install failed: ${error instanceof Error ? error.message : String(error)}`, "error");
					} finally {
						setSettingsSavingKey(null);
					}
				}}
				onUpdatePlugin={async name => {
					const client = clientRef.current;
					if (!client || !(await confirmPermission(`Update plugin ${name}? Package code will be replaced.`)))
						return;
					setSettingsSavingKey(`plugin:${name}`);
					try {
						await client.updatePlugin(name);
						await refreshSettings();
						addToast(`${name} updated`, "info");
					} catch (error) {
						addToast(`Plugin update failed: ${error instanceof Error ? error.message : String(error)}`, "error");
					} finally {
						setSettingsSavingKey(null);
					}
				}}
				onUninstallPlugin={async name => {
					const client = clientRef.current;
					if (
						!client ||
						!(await confirmPermission(`Uninstall plugin ${name}? Its tools and extensions will be removed.`))
					)
						return;
					setSettingsSavingKey(`plugin:${name}`);
					try {
						await client.uninstallPlugin(name);
						await refreshSettings();
						addToast(`${name} uninstalled`, "info");
					} catch (error) {
						addToast(
							`Plugin uninstall failed: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
					} finally {
						setSettingsSavingKey(null);
					}
				}}
				mcpServers={mcpServers}
				mcpLoading={mcpLoading}
				onRefreshMcp={refreshMcpStatus}
				onReconnectMcp={async serverName => {
					const client = clientRef.current;
					if (!client) return;
					try {
						await client.reconnectMcp(serverName);
						await refreshMcpStatus();
						addToast(`${serverName} reconnected`, "info");
					} catch (error) {
						addToast(
							`Could not reconnect ${serverName}: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
					}
				}}
				onSetMcpEnabled={async (serverName, enabled) => {
					const client = clientRef.current;
					if (!client) return;
					try {
						await client.setMcpEnabled(serverName, enabled);
						await refreshMcpStatus();
						addToast(`${serverName} ${enabled ? "enabled" : "disabled"}`, "info");
					} catch (error) {
						addToast(
							`Could not update ${serverName}: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
					}
				}}
				memoryStatus={memoryStatus}
				memorySearch={memorySearch}
				memoryLoading={memoryLoading}
				onRefreshMemory={refreshMemoryStatus}
				onSearchMemory={async query => {
					const client = clientRef.current;
					if (!client) return;
					setMemoryLoading(true);
					try {
						setMemorySearch(await client.searchMemory(query, 20));
					} catch (error) {
						addToast(`Memory search failed: ${error instanceof Error ? error.message : String(error)}`, "error");
					} finally {
						setMemoryLoading(false);
					}
				}}
				onTogglePlanMode={onTogglePlanMode}
				onCopyDiagnostics={onCopyDiagnostics}
				changes={changes}
				gitStatus={gitStatus}
				onRefreshChanges={refreshWorkspaceDiff}
				onStageHunks={onStageHunks}
				onUnstage={onUnstage}
				onRevertFiles={onRevertFiles}
				onCommit={onCommit}
				onPush={onPush}
				onCreatePullRequest={onCreatePullRequest}
				onCreateWorktree={onCreateWorktree}
				onManageWorktrees={onManageWorktrees}
				composerImages={composerImages}
				onComposerImagesChange={setComposerImages}
				contextItems={contextItems}
				contextSkills={contextSkills}
				contextMemoryBackend={contextMemoryBackend}
				contextSkillDetails={contextSkillDetails}
				contextSkillWarnings={contextSkillWarnings}
				onRemoveContextItem={onRemoveContextItem}
				onClearContext={onClearContext}
				browserUrl={browserUrl}
				browserSnapshot={browserSnapshot}
				browserBusy={browserBusy}
				onBrowserOpen={onBrowserOpen}
				onBrowserHistory={onBrowserHistory}
				onBrowserSnapshot={onBrowserSnapshot}
				onBrowserAddContext={onBrowserAddContext}
				onBrowserExternal={onBrowserExternal}
				sideChatReady={sideChatReady}
				sideChatStarting={sideChatStarting}
				sideChatMessages={sideChatMessages}
				onEnsureSideChat={onEnsureSideChat}
				onForkSideChat={onForkSideChat}
				onAddSideChatResult={onAddSideChatResult}
				sideChatWorktreePath={sideChatWorktreePath}
				onToggleSideChatWorktree={onToggleSideChatWorktree}
				onSendSideChat={onSendSideChat}
				onCloseSideChat={onCloseSideChat}
				scheduledTasks={scheduledTasks}
				onSaveScheduledTask={onSaveScheduledTask}
				onRemoveScheduledTask={onRemoveScheduledTask}
				onRunScheduledTask={onRunScheduledTask}
				workspaceEntries={workspaceEntries}
				workspaceFileContent={workspaceFileContent}
				selectedWorkspacePath={selectedWorkspacePath}
				workspaceFilesLoading={workspaceFilesLoading}
				workspaceFilesTruncated={workspaceFilesTruncated}
				onRefreshWorkspaceFiles={refreshWorkspaceFiles}
				onOpenWorkspaceFile={onOpenWorkspaceFile}
				onRevealWorkspaceFile={onRevealWorkspaceFile}
				onAddWorkspaceContext={onAddWorkspaceContext}
				updateVersion={update?.info.version ?? null}
				updateInstalling={updateInstalling}
				onInstallUpdate={onInstallUpdate}
				onRestartEngine={onRestartEngine}
				historyLoading={historyLoading}
				switching={switching}
				dialog={dialogQueue.find(d => DIALOG_METHODS.has(d.method)) ?? null}
				toasts={toasts}
				injection={injection}
				onSend={onSend}
				onAbort={onAbort}
				onAbortAndPrompt={onAbortAndPrompt}
				onSteer={onSteer}
				onFollowUp={onFollowUp}
				onCycleModel={onCycleModel}
				aborting={aborting}
				onChangeFolder={openFolder}
				authPrompt={authPrompt}
				onSelectModel={onSelectModel}
				onSelectThinking={onSelectThinking}
				onSelectApprovalMode={onSelectApprovalMode}
				onNewSession={onNewSession}
				onRenameSession={onRenameSession}
				onSelectSession={onSelectSession}
				onLogin={onLogin}
				onSetApiKey={onSetApiKey}
				onLogout={onLogout}
				onAuthOpen={onAuthOpen}
				onAuthCancel={onAuthCancel}
				onDialogRespond={respondDialog}
				onDismissToast={dismissToast}
				subagentMessages={subagentMessages}
				onLoadSubagentMessages={onLoadSubagentMessages}
			/>
			{workspace ? (
				<WorktreeManager
					open={worktreeManagerOpen}
					workspace={workspace}
					worktrees={worktrees}
					loading={worktreesLoading}
					mutatingPath={worktreeMutatingPath}
					onClose={() => setWorktreeManagerOpen(false)}
					onRefresh={refreshWorktrees}
					onOpen={onOpenWorktree}
					onRemove={onRemoveWorktree}
				/>
			) : null}
		</>
	);
}
