import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AppShell, type SessionInfo } from "./components/AppShell";
import type { AuthPrompt } from "./components/AuthDialog";
import type { ComposerInjection } from "./components/Composer";
import type { WidgetEntry } from "./components/ExtensionWidgets";
import type { Toast } from "./components/Toasts";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { appendStderr, appendUserMessage, initialViewModel, reduce, seedMessages, type ViewModel } from "./lib/reducer";
import { DesktopRpcClient, type EngineStatus } from "./lib/rpc-client";
import type {
	EngineEvent,
	ExtensionUIRequest,
	ExtensionUIResponse,
	ImageContent,
	LoginProvider,
	ModelInfo,
	SessionMessage,
	SessionSummary,
	SubagentSnapshot,
	ThinkingLevel,
	WorkspaceFileChange,
} from "./lib/rpc-protocol";
import { openExternalUrl, pickWorkspaceFolder } from "./lib/tauri-bridge";

type Action =
	| { kind: "event"; event: EngineEvent }
	| { kind: "user"; text: string; images?: ImageContent[] }
	| { kind: "stderr"; line: string }
	| { kind: "seed"; messages: SessionMessage[] }
	| { kind: "reset" };

function rootReducer(state: ViewModel, action: Action): ViewModel {
	switch (action.kind) {
		case "event":
			return reduce(state, action.event);
		case "user":
			return appendUserMessage(state, action.text, action.images);
		case "stderr":
			return appendStderr(state, action.line);
		case "seed":
			return seedMessages(action.messages);
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
	const [changes, setChanges] = useState<WorkspaceFileChange[]>([]);
	const [injection, setInjection] = useState<ComposerInjection | undefined>();
	const [authPrompt, setAuthPrompt] = useState<AuthPrompt | null>(null);
	const [statuses, setStatuses] = useState<Record<string, string>>({});
	const [widgets, setWidgets] = useState<Record<string, WidgetEntry>>({});
	const [docTitle, setDocTitle] = useState<string | undefined>();
	const clientRef = useRef<DesktopRpcClient | null>(null);
	const injectNonce = useRef(0);
	const loginProviderRef = useRef<string | undefined>(undefined);

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
			});
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
						else next[request.widgetKey] = { lines: request.widgetLines, placement: request.widgetPlacement ?? "aboveEditor" };
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

	useEffect(() => {
		if (!workspace) return;
		let cancelled = false;

		const client = new DesktopRpcClient({
			onEvent: event => {
				dispatch({ kind: "event", event });
				if (REFRESH_EVENTS.has(event.type)) {
					void refreshState();
					void refreshWorkspaceDiff();
				}
			},
			onStatus: (next, detail) => {
				if (cancelled) return;
				setStatus(next);
				setStatusDetail(detail);
			},
			onStderr: line => dispatch({ kind: "stderr", line }),
			onSubagentUpdate: () => void refreshSubagents(),
			onExtensionUI: request => handleExtensionUI(request),
		});
		clientRef.current = client;

		void (async () => {
			try {
				await client.start(workspace);
				if (cancelled) return;
				const [availableModels] = await Promise.all([
					client.getAvailableModels(),
					refreshState(),
					refreshLoginProviders(),
					refreshSessions(),
					refreshWorkspaceDiff(),
				]);
				if (cancelled) return;
				setModels(availableModels);
				await client.setSubagentSubscription("progress").catch(() => {});
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
		workspace,
		refreshState,
		refreshSubagents,
		refreshLoginProviders,
		refreshSessions,
		refreshWorkspaceDiff,
		handleExtensionUI,
	]);

	const reportError = useCallback((label: string, err: unknown) => {
		dispatch({ kind: "stderr", line: `${label}: ${err instanceof Error ? err.message : String(err)}` });
	}, []);

	const openFolder = useCallback(async () => {
		const folder = await pickWorkspaceFolder();
		if (!folder) return;
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
		loginProviderRef.current = undefined;
		setStatus("idle");
		setStatusDetail(undefined);
		saveLastWorkspace(folder);
		setWorkspace(folder);
	}, []);

	const onSend = useCallback(
		(text: string, images: ImageContent[]) => {
			dispatch({ kind: "user", text, images });
			clientRef.current?.prompt(text, images).catch(err => reportError("send failed", err));
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

	const onSelectThinking = useCallback(
		(level: ThinkingLevel) => {
			clientRef.current
				?.setThinkingLevel(level)
				.then(refreshState)
				.catch(err => reportError("set thinking failed", err));
		},
		[refreshState, reportError],
	);

	const onNewSession = useCallback(() => {
		clientRef.current
			?.newSession()
			.then(() => {
				dispatch({ kind: "reset" });
				setSubagents([]);
				return Promise.all([refreshState(), refreshSessions(), refreshWorkspaceDiff()]);
			})
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
			void (async () => {
				try {
					const { cancelled } = await client.switchSession(session.path);
					if (cancelled) return;
					const messages = await client.getMessages();
					dispatch({ kind: "seed", messages });
					setSubagents([]);
					await Promise.all([refreshState(), refreshSessions()]);
				} catch (err) {
					reportError("switch session failed", err);
				}
			})();
		},
		[refreshState, refreshSessions, reportError],
	);

	const refreshAuth = useCallback(async () => {
		await Promise.all([refreshLoginProviders(), refreshState()]);
		const client = clientRef.current;
		if (client) setModels(await client.getAvailableModels());
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
					reportError("login failed", err);
					addToast(`Login failed: ${err instanceof Error ? err.message : String(err)}`, "error");
				})
				.finally(() => {
					setAuthPrompt(null);
					loginProviderRef.current = undefined;
				});
		},
		[addToast, refreshAuth, reportError],
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
					reportError("set api key failed", err);
					addToast(`API key failed: ${err instanceof Error ? err.message : String(err)}`, "error");
				});
		},
		[addToast, refreshAuth, reportError],
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
			changes={changes}
			onRefreshChanges={refreshWorkspaceDiff}
			historyLoading={historyLoading}
			dialog={dialogQueue.find(d => DIALOG_METHODS.has(d.method)) ?? null}
			toasts={toasts}
			injection={injection}
			onSend={onSend}
			onAbort={onAbort}
			onChangeFolder={openFolder}
			authPrompt={authPrompt}
			onSelectModel={onSelectModel}
			onSelectThinking={onSelectThinking}
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
