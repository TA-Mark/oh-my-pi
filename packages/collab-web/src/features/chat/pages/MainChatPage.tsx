/**
 * MainChatPage — Desktop WebUI wrapper Main Chat orchestration.
 *
 * Multi-session Phase 1 layout:
 *   ┌──────────────────────────────────────────────────────┐
 *   │ mc-header: logo + session title + actions            │
 *   ├──────────────────────────────────────────────────────┤
 *   │ SessionTabBar (Tab1) (Tab2) [Tab3*] [+]              │
 *   ├────────────┬─────────────────────────────────────────┤
 *   │            │ ConnectionStatusBar                     │
 *   │ LeftSidebar│                                         │
 *   │            │ ┌─────────────────────────────────────┐ │
 *   │ Controls   │ │ TerminalView (ghostty-web + PTY WS)│ │
 *   │ Providers  │ │                                     │ │
 *   │ Settings   │ │  the actual OMP TUI — 100% CLI      │ │
 *   │ Sessions   │ │  fidelity, all slash commands work  │ │
 *   │ Todos      │ └─────────────────────────────────────┘ │
 *   │            │ StatusWidgets (aboveEditor)             │
 *   │            │ ChatComposer (synths keystrokes → PTY)  │
 *   │            │ StatusWidgets (belowEditor)             │
 *   └────────────┴─────────────────────────────────────────┘
 *
 * Transport (Phase 1 swap):
 *   Each open tab owns a {@link PtyChatClient} kept in a ref-managed Map.
 *   Switching tabs re-points `activeClient` state (which drives
 *   useSyncExternalStore) but does NOT tear down the sibling clients — their
 *   collab GuestClients stay connected, snapshots stay warm. Closing a tab
 *   disposes its client and calls `stop-pty` so the omp child terminates.
 *
 * Gated by Launcher health: warns when runtime is unhealthy.
 * Never imports oh-my-pi core logic.
 */

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Transcript } from "../../../components/transcript/Transcript";
import type { ChatClient, DialogResponsePayload } from "../../../lib/chat-client";
import { PtyChatClient } from "../../../lib/pty-chat-client";
import type { InterceptCallbacks } from "../../../lib/slash-intercept";
import {
	createSession,
	deleteSession,
	listDataSources,
	listSessions,
	refreshDataSource,
	renameSession as renameSessionApi,
	startPtySession,
	stopPtySession,
} from "../api/chatApi";
import { ChatComposer } from "../components/ChatComposer";
import { ConnectionStatusBar } from "../components/ConnectionStatusBar";
import { ExtensionDialog } from "../components/ExtensionDialog";
import { LeftSidebar } from "../components/LeftSidebar";
import { LogsDrawer } from "../components/LogsDrawer";
import { SessionHeaderActions } from "../components/SessionHeaderActions";
import { SessionTabBar } from "../components/SessionTabBar";
import { StatusWidgetPanel } from "../components/StatusWidgetPanel";
import { TerminalView } from "../components/TerminalView";
import { useChatStateMachine } from "../hooks/useChatStateMachine";
import { useLauncherHealthGate } from "../hooks/useLauncherHealthGate";
import "../components/chat.css";

interface Props {
	/** Called when Launcher health gate fails and user wants to go back */
	onGoToLauncher(): void;
}

async function ensureBridgePtyStarted(id: string): Promise<boolean> {
	try {
		await startPtySession(id);
		return true;
	} catch {
		return false;
	}
}

const TRANSCRIPT_STORAGE_KEY = "omp.desktop.transcriptOpen";

function loadTranscriptOpen(): boolean {
	if (typeof localStorage === "undefined") return false;
	try {
		return localStorage.getItem(TRANSCRIPT_STORAGE_KEY) === "1";
	} catch {
		return false;
	}
}

export function MainChatPage({ onGoToLauncher }: Props): ReactNode {
	const [ui, actions] = useChatStateMachine();
	const [logsOpen, setLogsOpen] = useState(false);
	// Transcript mirror pane (Phase 2). Right-side read-only view of
	// snapshot.entries — same component the collab web guest renders — so users
	// who miss the rich tool cards can see them alongside the raw terminal.
	// State persists to localStorage so the toggle survives reloads.
	const [transcriptOpen, setTranscriptOpen] = useState<boolean>(loadTranscriptOpen);
	useEffect(() => {
		if (typeof localStorage === "undefined") return;
		try {
			localStorage.setItem(TRANSCRIPT_STORAGE_KEY, transcriptOpen ? "1" : "0");
		} catch {
			/* quota / private mode — non-critical */
		}
	}, [transcriptOpen]);

	// ---- Launcher health gate ----
	// Bounce back to Launcher if omp goes missing under us (uninstall, PATH
	// change). The bridge's health flag now mirrors `findOmp().found`, so a
	// failed probe means there is no agent to talk to.
	const healthGate = useLauncherHealthGate(onGoToLauncher);

	// ---- Per-session PtyChatClient pool ----
	// A ref, not state, so mutating the map never triggers a full re-render.
	// The `activeClient` state below drives useSyncExternalStore for the
	// currently-focused tab; every other client stays warm in the map.
	const clientsRef = useRef<Map<string, PtyChatClient>>(new Map());
	// Typed as ChatClient (the interface with all-optional mutation methods)
	// so consumers can safely `client?.sendSetModel?.(...)` even though the
	// current PtyChatClient implementation only fills a subset — Phase 3 will
	// grow that subset via input synthesis.
	const [activeClient, setActiveClient] = useState<ChatClient | null>(null);
	// Bump when a new client is inserted so useEffect consumers can rebind.
	const [_clientEpoch, setClientEpoch] = useState(0);

	// Same subscribe/getSnapshot dance as before, now pointed at the active
	// tab's PtyChatClient. useSyncExternalStore automatically re-subscribes
	// when `activeClient` identity flips.
	const getClientSnapshot = useCallback(() => activeClient?.getSnapshot() ?? null, [activeClient]);
	const subscribeClient = useCallback((cb: () => void) => activeClient?.subscribe(cb) ?? (() => {}), [activeClient]);
	const snapshot = useSyncExternalStore(subscribeClient, getClientSnapshot);

	// ---- Ensure a client exists for `id` and return it ----
	const ensureClient = useCallback((id: string): PtyChatClient => {
		const map = clientsRef.current;
		const existing = map.get(id);
		if (existing) return existing;
		const client = new PtyChatClient({ sessionId: id, displayName: "desktop" });
		map.set(id, client);
		setClientEpoch(n => n + 1);
		return client;
	}, []);

	// ---- Activate session (or tab): boot PTY if needed, connect client ----
	const activateSession = useCallback(
		(id: string, link: string) => {
			actions.sessionActivated(id, link);
			const client = ensureClient(id);
			setActiveClient(client);
			void ensureBridgePtyStarted(id).then(ok => {
				if (!ok) {
					actions.setError({
						code: "OMP_SPAWN_FAILED",
						message:
							"Could not start omp PTY child via desktop bridge. Check that the bridge is running on :8787.",
						recoverable: true,
					});
					return;
				}
				// connect() is idempotent — safe to call every activate. Starts the
				// collab-link polling loop if the client hasn't attached its
				// GuestClient yet.
				client.connect();
			});
		},
		[actions, ensureClient],
	);

	// ---- Close tab: dispose client, stop bridge PTY, activate neighbor ----
	const handleCloseTab = useCallback(
		async (id: string) => {
			const map = clientsRef.current;
			const client = map.get(id);
			map.delete(id);
			setClientEpoch(n => n + 1);
			client?.close();
			// Reducer picks the neighbor id and clears activeSessionLink; we still
			// need to spin up its client if it hasn't been touched yet.
			const wasActive = ui.activeSessionId === id;
			actions.tabClosed(id);
			// Fire-and-forget: kill the omp child. Bridge tolerates missing
			// sessions, and we don't want to block tab-close on network.
			void stopPtySession(id).catch(() => {});
			if (wasActive) {
				// Find neighbor manually (state.openSessionIds hasn't updated yet in
				// this closure). Mirror pickNeighbor semantics: right-then-left.
				const remaining = ui.openSessionIds.filter(sid => sid !== id);
				const idx = ui.openSessionIds.indexOf(id);
				const neighborId = remaining[Math.min(idx, remaining.length - 1)] ?? null;
				const neighbor = neighborId ? ui.sessions.find(s => s.id === neighborId) : null;
				if (neighbor) {
					activateSession(neighbor.id, neighbor.link);
				} else {
					setActiveClient(null);
				}
			}
		},
		[actions, activateSession, ui.activeSessionId, ui.openSessionIds, ui.sessions],
	);

	// ---- Restart session (after editing ~/.omp/agent/config.yml so omp re-reads) ----
	// stop kills the omp child; activateSession respawns it, which re-reads
	// config fresh on boot. Reuses the same session id + link so transcripts
	// persist on disk (omp resumes via --resume sessionFile).
	const handleRestartSession = useCallback(
		async (sessionId: string) => {
			const session = ui.sessions.find(s => s.id === sessionId);
			if (!session) return;
			await stopPtySession(sessionId).catch(() => {});
			// Reset client so it re-polls for the new collab link (relayed room
			// changes across restarts — bridge's resetCollabState clears the
			// scraped link on stop).
			const client = clientsRef.current.get(sessionId);
			client?.close();
			clientsRef.current.delete(sessionId);
			activateSession(sessionId, session.link);
		},
		[ui.sessions, activateSession],
	);

	// ---- Reconnect (when WS ended) ----
	const handleReconnect = useCallback(() => {
		if (ui.activeSessionId && ui.activeSessionLink) {
			activateSession(ui.activeSessionId, ui.activeSessionLink);
		} else {
			activeClient?.connect();
		}
	}, [activeClient, ui.activeSessionId, ui.activeSessionLink, activateSession]);

	// ---- Create new session ----
	const handleNewSession = useCallback(async () => {
		actions.sessionLoading(true);
		try {
			const res = await createSession();
			const s = res.session;
			actions.sessionCreated({
				id: s.id,
				name: s.name,
				link: s.link,
				createdAt: new Date().toISOString(),
				lastActiveAt: null,
				messageCount: 0,
				isActive: false,
			});
			// Auto-activate + open the new session as a tab.
			activateSession(s.id, s.link);
		} catch (err) {
			actions.setError({
				code: "SESSION_CREATE_FAILED",
				message: `Failed to create session: ${err instanceof Error ? err.message : String(err)}`,
				recoverable: true,
			});
		} finally {
			actions.sessionLoading(false);
		}
	}, [actions, activateSession]);

	// ---- Delete session (destructive — also closes its tab and stops PTY) ----
	const handleDeleteSession = useCallback(
		async (id: string) => {
			try {
				const client = clientsRef.current.get(id);
				clientsRef.current.delete(id);
				setClientEpoch(n => n + 1);
				client?.close();
				await deleteSession(id);
				actions.sessionDeleted(id);
				// If we deleted the active tab, mirror the tab-close neighbor logic.
				if (ui.activeSessionId === id) {
					const remaining = ui.openSessionIds.filter(sid => sid !== id);
					const idx = ui.openSessionIds.indexOf(id);
					const neighborId = remaining[Math.min(idx, remaining.length - 1)] ?? null;
					const neighbor = neighborId ? ui.sessions.find(s => s.id === neighborId) : null;
					if (neighbor) activateSession(neighbor.id, neighbor.link);
					else setActiveClient(null);
				}
			} catch {
				// silently ignore
			}
		},
		[actions, activateSession, ui.activeSessionId, ui.openSessionIds, ui.sessions],
	);

	// ---- Rename session ----
	const handleSessionRenamed = useCallback(
		(name: string) => {
			if (!ui.activeSessionId) return;
			actions.sessionRenamed(ui.activeSessionId, name);
			// Persist to the bridge's session list (omp also updates its own sessionName).
			void renameSessionApi(ui.activeSessionId, name).catch(() => {});
		},
		[actions, ui.activeSessionId],
	);

	// ---- Data source refresh ----
	const handleSourceRefresh = useCallback(
		async (id: string) => {
			actions.dataSourceStatus(id, "loading");
			try {
				await refreshDataSource(id);
				actions.dataSourceStatus(id, "connected");
			} catch {
				actions.dataSourceStatus(id, "error");
			}
		},
		[actions],
	);

	// ---- Load initial data on mount ----
	// Guard with a ref so this runs exactly once — the deps array satisfies
	// biome's useExhaustiveDependencies, but the ref prevents re-fetch when
	// the callbacks change (which happens every render since actions come from
	// useCallback closures over state).
	const didBootstrapRef = useRef(false);
	useEffect(() => {
		if (didBootstrapRef.current) return;
		didBootstrapRef.current = true;
		listSessions()
			.then(res => {
				actions.sessionsLoaded(res.sessions);
				// Rehydrate the persisted active tab. Inactive open tabs stay in
				// state but don't spin up a client until the user focuses them —
				// cold-start stays cheap even with many restored tabs.
				const activeId = ui.activeSessionId;
				const activeSession = activeId ? res.sessions.find(s => s.id === activeId) : null;
				if (activeSession) activateSession(activeSession.id, activeSession.link);
			})
			.catch(() => {});
		listDataSources()
			.then(res => actions.dataSourcesLoaded(res.sources))
			.catch(() => {});
	}, [actions, activateSession, ui.activeSessionId]);

	// ---- Cleanup on unmount ----
	useEffect(() => {
		const map = clientsRef.current;
		return () => {
			for (const client of map.values()) client.close();
			map.clear();
		};
	}, []);

	// ---- Sync messageCount into session list when entries change ----
	const entryCount = snapshot?.entries.length ?? 0;
	useEffect(() => {
		if (ui.activeSessionId && entryCount > 0) {
			actions.sessionMessageCount(ui.activeSessionId, entryCount);
		}
	}, [ui.activeSessionId, entryCount, actions]);

	// ---- Active session name for header ----
	const activeSession = useMemo(
		() => ui.sessions.find(s => s.id === ui.activeSessionId) ?? null,
		[ui.sessions, ui.activeSessionId],
	);

	// ---- Slash command intercept callbacks ----
	const interceptCallbacks: InterceptCallbacks = useMemo(
		() => ({
			onNewSession: () => void handleNewSession(),
			onSidebarTab: (tab: string) => actions.setSidebarTab(tab as import("../hooks/useChatStateMachine").SidebarTab),
			activeSessionId: () => ui.activeSessionId,
		}),
		[handleNewSession, actions, ui.activeSessionId],
	);

	// ---- Connection phase from snapshot ----
	const connPhase = snapshot?.phase ?? "connecting";

	// ---- Dialog responder + title display ----
	const handleDialogRespond = useCallback(
		(payload: DialogResponsePayload) => {
			activeClient?.respondToDialog?.(payload);
		},
		[activeClient],
	);

	const displayTitle = snapshot?.titleOverride ?? activeSession?.name ?? "oh-my-pi Desktop";

	return (
		<div className="mc-app">
			{/* ---- Header ---- */}
			<header className="mc-header">
				<div className="mc-header-left">
					{/* Sidebar toggle */}
					<button
						type="button"
						className="mc-sidebar-toggle"
						aria-label={ui.sidebarOpen ? "Close sidebar" : "Open sidebar"}
						onClick={actions.toggleSidebar}
					>
						{ui.sidebarOpen ? "◂ Hide" : "▸ Show"}
					</button>

					{/* Session title (may be overridden by extension setTitle) +
					    inline actions (rename / compact / export / stats) */}
					{ui.activeSessionLink && activeClient ? (
						<SessionHeaderActions
							client={activeClient}
							currentName={displayTitle}
							onRenamed={handleSessionRenamed}
						/>
					) : (
						<span className="mc-session-title">{displayTitle}</span>
					)}
				</div>

				<div className="mc-header-right">
					{/* Health indicator */}
					{healthGate.status && (
						<span
							style={{
								fontSize: 11,
								color: healthGate.healthy ? "var(--ok)" : "var(--warn)",
								fontFamily: "var(--font-mono)",
							}}
						>
							{healthGate.healthy ? "● Runtime OK" : "● Runtime ⚠"}
						</span>
					)}
					<button
						type="button"
						className="mc-header-iconbtn"
						onClick={() => setTranscriptOpen(v => !v)}
						title="Toggle transcript mirror pane"
						aria-pressed={transcriptOpen}
					>
						{transcriptOpen ? "◨ Transcript" : "◧ Transcript"}
					</button>
					<button
						type="button"
						className="mc-header-iconbtn"
						onClick={() => setLogsOpen(v => !v)}
						title="Toggle log drawer"
					>
						{logsOpen ? "▾ Logs" : "▴ Logs"}
					</button>
				</div>
			</header>

			{/* ---- Session tab bar ---- */}
			<SessionTabBar
				sessions={ui.sessions}
				openIds={ui.openSessionIds}
				activeId={ui.activeSessionId}
				onActivate={id => {
					const s = ui.sessions.find(x => x.id === id);
					if (s) activateSession(s.id, s.link);
				}}
				onClose={id => void handleCloseTab(id)}
				onNew={() => void handleNewSession()}
				newDisabled={ui.sessionLoading}
			/>

			{/* ---- Body: Sidebar + Chat area ---- */}
			<div className="mc-body">
				{/* Left sidebar */}
				<LeftSidebar
					open={ui.sidebarOpen}
					tab={ui.sidebarTab}
					sessions={ui.sessions}
					activeSessionId={ui.activeSessionId}
					sessionLoading={ui.sessionLoading}
					dataSources={ui.dataSources}
					client={activeClient}
					snapshot={snapshot}
					onTabChange={actions.setSidebarTab}
					onSessionActivate={activateSession}
					onSessionDelete={handleDeleteSession}
					onSessionNew={handleNewSession}
					onSourceRefresh={handleSourceRefresh}
					onSessionRestart={handleRestartSession}
				/>

				{/* Chat area */}
				<div className="mc-chat-area">
					{/* Error banner */}
					{ui.error && (
						<div className="mc-error-banner" role="alert">
							{ui.error.message}
							<button
								type="button"
								className="mc-error-dismiss"
								onClick={actions.clearError}
								aria-label="Dismiss error"
							>
								Dismiss
							</button>
						</div>
					)}

					{/* Connection status bar */}
					<ConnectionStatusBar
						phase={connPhase}
						health={healthGate.status}
						statusEntries={snapshot?.statusEntries}
						isCompacting={snapshot?.sessionExtras?.isCompacting}
						onReconnect={handleReconnect}
						onGoToLauncher={onGoToLauncher}
					/>

					{/* No session selected empty state */}
					{!ui.activeSessionLink && (
						<div className="mc-empty">
							<span className="mc-empty-title">No session selected</span>
							<span className="mc-empty-sub">
								Choose an existing session from the sidebar, or start a new one.
							</span>
							<div className="mc-empty-actions">
								<button
									type="button"
									className="sh-btn sh-btn-primary"
									onClick={handleNewSession}
									disabled={ui.sessionLoading}
								>
									+ New Session
								</button>
								<button type="button" className="sh-btn" onClick={() => actions.setSidebarTab("sessions")}>
									Open Sessions
								</button>
							</div>
						</div>
					)}

					{/* Terminal + Composer — only when session is active */}
					{ui.activeSessionId && activeClient && (
						<>
							{/* Split view: terminal on the left, optional transcript mirror
							    on the right. Transcript renders from snapshot.entries — the
							    same GuestSnapshot the collab web guest consumes — so users
							    who want to see tool cards / markdown alongside the raw TUI
							    can toggle it without spawning a second session. Transcript
							    is a read-only view; every interaction still routes through
							    the terminal or the composer below. */}
							<div className="mc-terminal-split" data-transcript-open={transcriptOpen ? "true" : "false"}>
								{/* TerminalView key'd by session id so React unmounts +
								    remounts on tab switch; keeps ghostty-web instance per
								    session cheap (we only pay for the active one, at the
								    cost of a redraw on switch — bridge's rolling tail makes
								    this instant). */}
								<TerminalView key={ui.activeSessionId} sessionId={ui.activeSessionId} />
								{transcriptOpen && snapshot && (
									<aside className="mc-transcript-pane" aria-label="Session transcript (mirror)">
										<Transcript
											entries={snapshot.entries}
											stream={snapshot.stream}
											streamDone={snapshot.streamDone}
											activeTools={snapshot.activeTools}
											working={snapshot.working}
										/>
									</aside>
								)}
							</div>

							{snapshot && (
								<>
									<StatusWidgetPanel
										statusEntries={snapshot.statusEntries}
										widgets={snapshot.widgets}
										placement="aboveEditor"
									/>

									<ChatComposer
										client={activeClient}
										snapshot={snapshot}
										launcherHealthy={healthGate.healthy && healthGate.status?.phase !== "installing"}
										onGoToLauncher={onGoToLauncher}
										interceptCallbacks={interceptCallbacks}
									/>

									<StatusWidgetPanel
										statusEntries={snapshot.statusEntries}
										widgets={snapshot.widgets}
										placement="belowEditor"
									/>
								</>
							)}
						</>
					)}

					{/* Logs drawer (slides up from bottom of chat area) */}
					{snapshot && <LogsDrawer logs={snapshot.logs} open={logsOpen} onClose={() => setLogsOpen(false)} />}

					{/* Extension UI dialog modal — overlay outside chat-area */}
					{snapshot?.pendingDialog && (
						<ExtensionDialog
							dialog={snapshot.pendingDialog}
							onRespond={handleDialogRespond}
							client={activeClient}
						/>
					)}
				</div>
			</div>
		</div>
	);
}
