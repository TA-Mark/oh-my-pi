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

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { GuestClient } from '../../../lib/client';
import { Transcript } from '../../../components/transcript/Transcript';
import { useChatStateMachine } from '../hooks/useChatStateMachine';
import { useLauncherHealthGate } from '../hooks/useLauncherHealthGate';
import {
  listSessions,
  createSession,
  deleteSession,
  listDataSources,
  refreshDataSource,
  getRuntimeConfig,
  updateRuntimeConfig,
} from '../api/chatApi';
import { ConnectionStatusBar } from '../components/ConnectionStatusBar';
import { LeftSidebar } from '../components/LeftSidebar';
import { ChatComposer } from '../components/ChatComposer';
import '../components/chat.css';

interface Props {
  /** Called when Launcher health gate fails and user wants to go back */
  onGoToLauncher(): void;
}

const GUEST_NAME = 'desktop-user';

export function MainChatPage({ onGoToLauncher }: Props): ReactNode {
  const [ui, actions] = useChatStateMachine();

  // ---- Launcher health gate ----
  const healthGate = useLauncherHealthGate(
    // Called when health becomes unhealthy — show warning, don't auto-redirect
    undefined,
  );

  // ---- GuestClient (created when session link is set) ----
  const clientRef = useRef<GuestClient | null>(null);

  const getClientSnapshot = useCallback(() => {
    return clientRef.current?.getSnapshot() ?? null;
  }, []);

  const subscribeClient = useCallback((cb: () => void) => {
    return clientRef.current?.subscribe(cb) ?? (() => {});
  }, []);

  const snapshot = useSyncExternalStore(subscribeClient, getClientSnapshot);

  // ---- Activate session: build GuestClient from link ----
  const activateSession = useCallback((id: string, link: string) => {
    // Tear down previous client
    if (clientRef.current) {
      clientRef.current.close();
      clientRef.current = null;
    }
    actions.sessionActivated(id, link);
    try {
      const client = new GuestClient(link, GUEST_NAME);
      clientRef.current = client;
      client.connect();
    } catch (err) {
      actions.setError({
        code: 'SESSION_LINK_INVALID',
        message: `Cannot connect to session: ${err instanceof Error ? err.message : String(err)}`,
        recoverable: false,
      });
    }
  }, [actions]);

  // ---- Reconnect (when WS ended) ----
  const handleReconnect = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.connect();
    } else if (ui.activeSessionLink) {
      activateSession(ui.activeSessionId!, ui.activeSessionLink);
    }
  }, [ui.activeSessionId, ui.activeSessionLink, activateSession]);

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
        code: 'SESSION_CREATE_FAILED',
        message: `Failed to create session: ${err instanceof Error ? err.message : String(err)}`,
        recoverable: true,
      });
    } finally {
      actions.sessionLoading(false);
    }
  }, [actions, activateSession]);

  // ---- Delete session ----
  const handleDeleteSession = useCallback(async (id: string) => {
    try {
      await deleteSession(id);
      actions.sessionDeleted(id);
    } catch {
      // silently ignore
    }
  }, [actions]);

  // ---- Config update ----
  const handleConfigUpdate = useCallback(async (patch: Parameters<typeof updateRuntimeConfig>[0]) => {
    actions.configLoading(true);
    try {
      const res = await updateRuntimeConfig(patch);
      actions.configUpdated(res);
    } catch {
      // silently ignore
    } finally {
      actions.configLoading(false);
    }
  }, [actions]);

  // ---- Data source refresh ----
  const handleSourceRefresh = useCallback(async (id: string) => {
    actions.dataSourceStatus(id, 'loading');
    try {
      await refreshDataSource(id);
      actions.dataSourceStatus(id, 'connected');
    } catch {
      actions.dataSourceStatus(id, 'error');
    }
  }, [actions]);

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

    // Runtime config
    getRuntimeConfig()
      .then(res => actions.configLoaded(res, res.availableModels))
      .catch(() => {});
  }, [actions]);

  // ---- Cleanup on unmount ----
  useEffect(() => {
    return () => {
      clientRef.current?.close();
    };
  }, []);

  // ---- Active session name for header ----
  const activeSession = useMemo(
    () => ui.sessions.find(s => s.id === ui.activeSessionId) ?? null,
    [ui.sessions, ui.activeSessionId],
  );

  // ---- Connection phase from snapshot ----
  const connPhase = snapshot?.phase ?? 'connecting';
  const isLive = connPhase === 'live';

  return (
    <div className="mc-app">
      {/* ---- Header ---- */}
      <header className="mc-header">
        <div className="mc-header-left">
          {/* Sidebar toggle */}
          <button
            type="button"
            className="mc-sidebar-toggle"
            aria-label={ui.sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
            onClick={actions.toggleSidebar}
          >
            {ui.sidebarOpen ? '◂ Hide' : '▸ Show'}
          </button>

          {/* Session title */}
          <span className="mc-session-title">
            {activeSession ? activeSession.name : 'oh-my-pi Desktop'}
          </span>
        </div>

        <div className="mc-header-right">
          {/* Health indicator */}
          {healthGate.status && (
            <span
              style={{
                fontSize: 11,
                color: healthGate.healthy ? 'var(--ok)' : 'var(--warn)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {healthGate.healthy ? '● Runtime OK' : '● Runtime ⚠'}
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
          runtimeConfig={ui.runtimeConfig}
          availableModels={ui.availableModels}
          configLoading={ui.configLoading}
          onTabChange={actions.setSidebarTab}
          onSessionActivate={activateSession}
          onSessionDelete={handleDeleteSession}
          onSessionNew={handleNewSession}
          onSourceRefresh={handleSourceRefresh}
          onConfigUpdate={handleConfigUpdate}
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
                <button
                  type="button"
                  className="sh-btn"
                  onClick={() => actions.setSidebarTab('sessions')}
                >
                  Open Sessions
                </button>
              </div>
            </div>
          )}

          {/* Transcript + Composer — only when session is selected */}
          {ui.activeSessionLink && snapshot && clientRef.current && (
            <>
              <Transcript
                entries={snapshot.entries}
                stream={snapshot.stream}
                streamDone={snapshot.streamDone}
                activeTools={snapshot.activeTools}
                working={snapshot.working}
              />

              <ChatComposer
                client={clientRef.current}
                snapshot={snapshot}
                launcherHealthy={healthGate.healthy}
                onGoToLauncher={onGoToLauncher}
              />
            </>
          )}

          {/* Session selected but client not yet built */}
          {ui.activeSessionLink && !snapshot && (
            <div className="mc-empty">
              <span className="mc-empty-title">Connecting…</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
