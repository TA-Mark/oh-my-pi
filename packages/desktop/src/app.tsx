import type { Update as UpdateHandle } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AppShell, type SessionInfo } from "./components/AppShell";
import type { AuthPrompt } from "./components/AuthDialog";
import type { ComposerInjection } from "./components/Composer";
import type { WidgetEntry } from "./components/ExtensionWidgets";
import type { Toast } from "./components/Toasts";
import { WelcomeScreen } from "./components/WelcomeScreen";
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
	EngineEvent,
	ExtensionUIRequest,
	ExtensionUIResponse,
	HunkSelection,
	ImageContent,
	LoginProvider,
	ModelInfo,
	PlanModeState,
	SessionMessage,
	SessionSummary,
	SubagentSnapshot,
	ThinkingLevel,
	WorkspaceFileChange,
} from "./lib/rpc-protocol";
import { openExternalUrl, pickWorkspaceFolder } from "./lib/tauri-bridge";
import { checkForUpdate, installUpdate, type UpdateInfo } from "./lib/updater";

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

/** Events after which session metadata (model/thinking/name/count) may have changed. */
const REFRESH_EVENTS = new Set(["agent_end", "thinking_level_changed", "goal_updated"]);

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
	const [changes, setChanges] = useState<WorkspaceFileChange[]>([]);
	const [update, setUpdate] = useState<{ info: UpdateInfo; update: UpdateHandle } | null>(null);
	const [updateInstalling, setUpdateInstalling] = useState(false);
	const [injection, setInjection] = useState<ComposerInjection | undefined>();
	const [authPrompt, setAuthPrompt] = useState<AuthPrompt | null>(null);
	const [statuses, setStatuses] = useState<Record<string, string>>({});
	const [widgets, setWidgets] = useState<Record<string, WidgetEntry>>({});
	const [docTitle, setDocTitle] = useState<string | undefined>();
	const [planMode, setPlanMode] = useState<PlanModeState | undefined>();
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
			});
			setPlanMode(state.planMode);
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
		if (!client) return;
		try {
			setChanges(await client.getWorkspaceDiff());
		} catch {
			// transient; ignore
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
			onEvent: event => {
				dispatch({ kind: "event", event });
				if (event.type === "plan_mode_changed") {
					setPlanMode(event.planMode);
				}
				if (REFRESH_EVENTS.has(event.type)) {
					void refreshState();
					void refreshWorkspaceDiff();
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
			if (!client) return;
			try {
				await client.stageHunks(selections);
				await refreshWorkspaceDiff();
			} catch (err) {
				reportError("stage failed", err);
			}
		},
		[refreshWorkspaceDiff, reportError],
	);

	const onUnstage = useCallback(
		async (files?: string[]) => {
			const client = clientRef.current;
			if (!client) return;
			try {
				await client.unstage(files);
				await refreshWorkspaceDiff();
			} catch (err) {
				reportError("unstage failed", err);
			}
		},
		[refreshWorkspaceDiff, reportError],
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
				await Promise.all([refreshState(), refreshSessions(), refreshLoginProviders(), refreshWorkspaceDiff()]);
				setModels(await client.getAvailableModels().catch(() => []));
			} catch (err) {
				reportError("switch workspace failed", err);
			}
		} else {
			setStatus("idle");
			setStatusDetail(undefined);
		}
	}, [refreshState, refreshSessions, refreshLoginProviders, refreshWorkspaceDiff, reportError]);

	const onSend = useCallback(
		(text: string, images: ImageContent[]) => {
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
			client
				.prompt(text, images)
				.then(result => {
					if (result?.agentInvoked === false) dispatch({ kind: "streaming", value: false });
				})
				.catch(err => {
					dispatch({ kind: "streaming", value: false });
					reportError("send failed", err);
				});
		},
		[reportError],
	);

	const onAbort = useCallback(() => {
		clientRef.current?.abort().catch(() => {});
	}, []);

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

	if (!workspace) {
		return <WelcomeScreen onOpenFolder={openFolder} error={status === "error" ? statusDetail : undefined} />;
	}

	return (
		<AppShell
			vm={vm}
			status={status}
			statusDetail={statusDetail}
			workspace={workspace}
			models={models}
			session={session}
			subagents={subagents}
			loginProviders={loginProviders}
			sessions={sessions}
			statuses={statuses}
			widgets={widgets}
			planMode={planMode}
			onTogglePlanMode={onTogglePlanMode}
			changes={changes}
			onRefreshChanges={refreshWorkspaceDiff}
			onStageHunks={onStageHunks}
			onUnstage={onUnstage}
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
		/>
	);
}
