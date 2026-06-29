/**
 * MainChatPage — Desktop WebUI wrapper Main Chat orchestration.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────┐
 *   │ mc-header: logo + session title + actions   │
 *   ├────────────┬────────────────────────────────┤
 *   │            │ ConnectionStatusBar             │
 *   │ LeftSidebar│ (launcher health + WS phase)   │
 *   │            ├────────────────────────────────┤
 *   │ Controls   │ Transcript (streaming)          │
 *   │ Sessions   │   tool run timeline             │
 *   │ Sources    ├────────────────────────────────┤
 *   │            │ ChatComposer (send/stop/regen)  │
 *   └────────────┴────────────────────────────────┘
 *
 * Gated by Launcher health: warns when runtime is unhealthy.
 * Never imports oh-my-pi core logic.
 */

import { type ReactNode, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Transcript } from "../../../components/transcript/Transcript";
import type { ChatClient, DialogResponsePayload } from "../../../lib/chat-client";
import { RpcClient } from "../../../lib/rpc-client";
import { createSession, deleteSession, listDataSources, listSessions, refreshDataSource } from "../api/chatApi";
import { ChatComposer } from "../components/ChatComposer";
import { ConnectionStatusBar } from "../components/ConnectionStatusBar";
import { ExtensionDialog } from "../components/ExtensionDialog";
import { LeftSidebar } from "../components/LeftSidebar";
import { StatusWidgetPanel } from "../components/StatusWidgetPanel";
import { useChatStateMachine } from "../hooks/useChatStateMachine";
import { useLauncherHealthGate } from "../hooks/useLauncherHealthGate";
import "../components/chat.css";

interface Props {
	/** Called when Launcher health gate fails and user wants to go back */
	onGoToLauncher(): void;
}

const BRIDGE_HTTP = "http://127.0.0.1:8787/api/v1";
const BRIDGE_WS = "ws://127.0.0.1:8787/api/v1";

async function startOmpForSession(id: string): Promise<boolean> {
	try {
		const res = await fetch(`${BRIDGE_HTTP}/chat/sessions/${id}/start`, { method: "POST" });
		return res.ok;
	} catch {
		return false;
	}
}

export function MainChatPage({ onGoToLauncher }: Props): ReactNode {
	const [ui, actions] = useChatStateMachine();

	// ---- Launcher health gate ----
	// Bounce back to Launcher if omp goes missing under us (uninstall, PATH
	// change). The bridge's health flag now mirrors `findOmp().found`, so a
	// failed probe means there is no agent to talk to.
	const healthGate = useLauncherHealthGate(onGoToLauncher);

	// ---- ChatClient (RpcClient backed by the desktop bridge) ----
	// Stored in state, not a ref, so useSyncExternalStore re-subscribes when the
	// client instance changes (e.g. user switches session). A ref would silently
	// keep the stale subscription and the UI would freeze on "Connecting…".
	const [client, setClient] = useState<ChatClient | null>(null);

	const getClientSnapshot = useCallback(() => client?.getSnapshot() ?? null, [client]);

	const subscribeClient = useCallback((cb: () => void) => client?.subscribe(cb) ?? (() => {}), [client]);

	const snapshot = useSyncExternalStore(subscribeClient, getClientSnapshot);

	// ---- Activate session: ensure omp child is spawned, then connect WS ----
	const activateSession = useCallback(
		(id: string, link: string) => {
			setClient(prev => {
				prev?.close();
				return null;
			});
			actions.sessionActivated(id, link);
			void startOmpForSession(id).then(ok => {
				if (!ok) {
					actions.setError({
						code: "OMP_SPAWN_FAILED",
						message: "Could not start omp child via desktop bridge. Check that the bridge is running on :8787.",
						recoverable: true,
					});
					return;
				}
				try {
					const next = new RpcClient({ sessionId: id, wsBase: BRIDGE_WS });
					setClient(next);
					next.connect();
				} catch (err) {
					actions.setError({
						code: "SESSION_CONNECT_FAILED",
						message: `Cannot connect to session: ${err instanceof Error ? err.message : String(err)}`,
						recoverable: false,
					});
				}
			});
		},
		[actions],
	);

	// ---- Reconnect (when WS ended) ----
	const handleReconnect = useCallback(() => {
		if (client) {
			client.connect();
		} else if (ui.activeSessionLink) {
			activateSession(ui.activeSessionId!, ui.activeSessionLink);
		}
	}, [client, ui.activeSessionId, ui.activeSessionLink, activateSession]);

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
			// Auto-activate new session
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

	// ---- Delete session ----
	const handleDeleteSession = useCallback(
		async (id: string) => {
			try {
				await deleteSession(id);
				actions.sessionDeleted(id);
			} catch {
				// silently ignore
			}
		},
		[actions],
	);

	// Runtime config (model + thinking) is now driven directly by RpcClient
	// inside UserControlsPanel — the REST runtime-config stub is no longer the
	// source of truth.

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
	useEffect(() => {
		// Sessions
		listSessions()
			.then(res => actions.sessionsLoaded(res.sessions))
			.catch(() => {});

		// Data sources
		listDataSources()
			.then(res => actions.dataSourcesLoaded(res.sources))
			.catch(() => {});
	}, [actions]);

	// ---- Cleanup on unmount ----
	useEffect(() => {
		return () => {
			client?.close();
		};
	}, [client]);

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

	// ---- Connection phase from snapshot ----
	const connPhase = snapshot?.phase ?? "connecting";

	// ---- Dialog responder + title display ----
	const handleDialogRespond = useCallback(
		(payload: DialogResponsePayload) => {
			client?.respondToDialog?.(payload);
		},
		[client],
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

					{/* Session title (may be overridden by extension setTitle) */}
					<span className="mc-session-title">{displayTitle}</span>
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
				</div>
			</header>

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
					client={client}
					snapshot={snapshot}
					onTabChange={actions.setSidebarTab}
					onSessionActivate={activateSession}
					onSessionDelete={handleDeleteSession}
					onSessionNew={handleNewSession}
					onSourceRefresh={handleSourceRefresh}
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

					{/* Transcript + Composer — only when session is selected */}
					{ui.activeSessionLink && snapshot && client && (
						<>
							<Transcript
								entries={snapshot.entries}
								stream={snapshot.stream}
								streamDone={snapshot.streamDone}
								activeTools={snapshot.activeTools}
								working={snapshot.working}
							/>

							<StatusWidgetPanel
								statusEntries={snapshot.statusEntries}
								widgets={snapshot.widgets}
								placement="aboveEditor"
							/>

							<ChatComposer
								client={client}
								snapshot={snapshot}
								launcherHealthy={healthGate.healthy}
								onGoToLauncher={onGoToLauncher}
							/>

							<StatusWidgetPanel
								statusEntries={snapshot.statusEntries}
								widgets={snapshot.widgets}
								placement="belowEditor"
							/>
						</>
					)}

					{/* Extension UI dialog modal — overlay outside chat-area */}
					{snapshot?.pendingDialog && (
						<ExtensionDialog dialog={snapshot.pendingDialog} onRespond={handleDialogRespond} />
					)}

					{/* Session selected but client not yet built */}
					{ui.activeSessionLink && (!snapshot || !client) && (
						<div className="mc-empty">
							<span className="mc-empty-title">Connecting…</span>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
