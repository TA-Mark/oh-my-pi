/**
 * InstallerPage — Desktop WebUI wrapper installer screen.
 * Orchestrates preflight → install → success flow.
 * Never imports oh-my-pi core. All system ops go through installerApi.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useInstallerStateMachine } from '../hooks/useInstallerStateMachine';
import {
  runPreflight,
  startInstall,
  cancelInstall,
  repairInstall,
  subscribeToJobStream,
} from '../api/installerApi';
import type { InstallerError, StreamEvent } from '../types/installer';
import { SourceSetupCard } from '../components/SourceSetupCard';
import { PreflightChecklistCard } from '../components/PreflightChecklistCard';
import { InstallProgressCard } from '../components/InstallProgressCard';
import { InstallerActionBar } from '../components/InstallerActionBar';
import '../components/installer.css';

interface Props {
  /** Called when install succeeds and user clicks "Open Launcher" */
  onInstallerDone(): void;
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function InstallerPage({ onInstallerDone }: Props): ReactNode {
  const [state, actions] = useInstallerStateMachine();
  const streamRef = useRef<{ close(): void } | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTsRef = useRef<number>(0);

  // Elapsed timer
  useEffect(() => {
    if (state.phase === 'checking' || state.phase === 'installing') {
      startTsRef.current = Date.now() - state.elapsedMs;
      timerRef.current = setInterval(() => {
        actions.tick(Date.now() - startTsRef.current);
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [state.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup WS on unmount
  useEffect(() => {
    return () => {
      streamRef.current?.close();
    };
  }, []);

  // --- handlers ---

  const handleStartChecks = useCallback(async () => {
    actions.startChecking();
    try {
      // Seed placeholder checks immediately for visual feedback
      const placeholders = [
        { id: 'git',  label: 'Git available', status: 'running' as const },
        { id: 'net',  label: 'Network reachable', status: 'running' as const },
        { id: 'disk', label: 'Disk space', status: 'running' as const },
        { id: 'src',  label: 'Source repository accessible', status: 'running' as const },
        { id: 'port', label: 'Bridge port available', status: 'running' as const },
      ];
      placeholders.forEach(c => actions.updateCheck(c));

      const result = await runPreflight({
        repoUrl: state.repoUrl,
        branch: state.branch,
        installPath: state.installPath,
      });
      actions.checksDone(result.allPassed, result.checks);
    } catch (err) {
      const e = err as InstallerError & { message?: string };
      actions.checksDone(false, [
        {
          id: 'bridge',
          label: 'Desktop bridge connection',
          status: 'fail',
          detail: e.message ?? 'Could not reach desktop bridge',
          fixHint: 'Make sure the oh-my-pi desktop bridge is running on port 8787.',
        },
      ]);
    }
  }, [state.repoUrl, state.branch, state.installPath, actions]);

  const handleInstall = useCallback(async () => {
    try {
      const job = await startInstall({
        repoUrl: state.repoUrl,
        branch: state.branch,
        installPath: state.installPath,
        windowsInstallPath: state.installPath,
      });
      actions.startInstalling(job.jobId);

      // Subscribe to WS stream for live logs + phase changes
      const sub = subscribeToJobStream(
        job.jobId,
        (event: StreamEvent) => {
          if (event.type === 'log') {
            actions.appendLog(event.line);
          } else if (event.type === 'phase_change') {
            if (event.phase === 'success') {
              sub.close();
              actions.installSuccess();
            } else if (event.phase === 'failed') {
              sub.close();
              actions.installFailed({
                code: 'INSTALL_FAILED',
                message: 'Installation failed. Check logs for details.',
                actions: [
                  { label: 'Retry', action: 'retry' },
                  { label: 'View Logs', action: 'logs' },
                ],
              });
            }
          }
        },
        (err: Error) => {
          actions.installFailed({
            code: 'STREAM_ERROR',
            message: err.message,
            actions: [{ label: 'Retry', action: 'retry' }],
          });
        },
      );
      streamRef.current = sub;
    } catch (err) {
      const e = err as InstallerError & { message?: string };
      actions.installFailed({
        code: (e as { code?: string }).code ?? 'START_FAILED',
        message: e.message ?? 'Failed to start installation.',
        actions: [{ label: 'Retry', action: 'retry' }],
      });
    }
  }, [state.repoUrl, state.branch, state.installPath, actions]);

  const handleCancel = useCallback(async () => {
    streamRef.current?.close();
    streamRef.current = null;
    if (state.jobId) {
      await cancelInstall(state.jobId).catch(() => {/* best-effort */});
    }
    actions.cancel();
  }, [state.jobId, actions]);

  const handleRetry = useCallback(async () => {
    streamRef.current?.close();
    streamRef.current = null;
    if (state.jobId && state.phase === 'failed') {
      await repairInstall(state.jobId).catch(() => {/* best-effort */});
    }
    actions.retry();
  }, [state.jobId, state.phase, actions]);

  const phaseLabel: Record<string, string> = {
    idle: 'Ready',
    checking: 'Checking…',
    check_fail: 'Check failed',
    ready: 'Ready to install',
    installing: 'Installing…',
    success: 'Installation complete',
    failed: 'Installation failed',
    cancelled: 'Cancelled',
  };

  return (
    <div className="ins-page">
      {/* Top bar */}
      <div className="ins-topbar">
        <div className="ins-topbar-left">
          <div className="ins-lockup">
            <div className="ins-lockup-mark" />
            oh-my-pi installer
          </div>
          <span className="ins-env-badge">Stable</span>
        </div>
        <div className="ins-topbar-right">
          <span style={{ fontSize: 11, color: 'var(--fg-faint)' }}>Windows</span>
        </div>
      </div>

      {/* Body */}
      <div className="ins-body">
        <div className="ins-main">
          {/* Success screen */}
          {state.phase === 'success' ? (
            <div className="ins-card">
              <div className="ins-success">
                <div className="ins-success-icon">✓</div>
                <div className="ins-success-title">Installation Complete</div>
                <div className="ins-success-sub">
                  oh-my-pi has been installed to <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{state.installPath}</code>
                </div>
              </div>
            </div>
          ) : (
            <>
              <SourceSetupCard
                repoUrl={state.repoUrl}
                branch={state.branch}
                installPath={state.installPath}
                phase={state.phase}
                onChange={actions.setSource}
              />

              <PreflightChecklistCard
                checks={state.checks}
                running={state.phase === 'checking'}
              />

              {(state.phase === 'installing' || state.phase === 'failed' || state.phase === 'success') && (
                <InstallProgressCard
                  steps={state.steps}
                  logs={state.logs}
                  progress={state.progress}
                  currentStep={state.currentStep}
                  failed={state.phase === 'failed'}
                />
              )}

              {/* Error card */}
              {state.error && (
                <div className="ins-card ins-error-card">
                  <div className="ins-error-title">Error: {state.error.code}</div>
                  <div className="ins-error-detail">{state.error.message}</div>
                  {state.error.detail && (
                    <div className="ins-error-detail" style={{ opacity: 0.75 }}>{state.error.detail}</div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Action bar */}
          <InstallerActionBar
            phase={state.phase}
            onStartChecks={handleStartChecks}
            onInstall={handleInstall}
            onCancel={handleCancel}
            onRetry={handleRetry}
            onOpenLauncher={onInstallerDone}
          />
        </div>

        {/* Help panel */}
        <aside className="ins-help">
          <div className="ins-help-section">
            <div className="ins-help-title">What this does</div>
            <div className="ins-help-text">
              Clones the official oh-my-pi repository to your machine and sets up the runtime environment.
              No core source files are modified.
            </div>
          </div>
          <div className="ins-help-section">
            <div className="ins-help-title">Security</div>
            <div className="ins-help-text">
              Only the official GitHub source is used. The installer validates the remote URL before proceeding.
            </div>
          </div>
          <div className="ins-help-section">
            <div className="ins-help-title">Requirements</div>
            <div className="ins-help-text">
              Git, Node.js 18+, internet connection, ~500 MB free disk space.
            </div>
          </div>
          <div className="ins-help-section">
            <div className="ins-help-title">Troubleshooting</div>
            <a
              className="ins-help-link"
              href="https://github.com/myorg/oh-my-pi/wiki/install-troubleshooting"
              target="_blank"
              rel="noreferrer"
            >
              View docs ↗
            </a>
          </div>
        </aside>
      </div>

      {/* Status bar */}
      <div className="ins-statusbar">
        <span>{phaseLabel[state.phase] ?? state.phase}</span>
        {state.elapsedMs > 0 && (
          <span>Elapsed: {formatElapsed(state.elapsedMs)}</span>
        )}
      </div>
    </div>
  );
}
