import type { ReactNode } from 'react';
import type { LauncherPhase } from '../types/launcher';

interface Props {
  phase: LauncherPhase;
  onStart(): void;
  onStop(): void;
  onRestart(): void;
  onSafeMode(): void;
}

export function LaunchControlCard({ phase, onStart, onStop, onRestart, onSafeMode }: Props): ReactNode {
  const isRunning  = phase === 'running_healthy' || phase === 'running_degraded';
  const isStopped  = phase === 'stopped';
  const isTransition = phase === 'starting' || phase === 'stopping' || phase === 'updating';
  const isError    = phase === 'error';

  return (
    <div className="lnc-card">
      <div className="lnc-card-title">Launch Control</div>

      <div className="lnc-control-grid">
        {/* Start */}
        <button
          className="lnc-btn lnc-btn-primary"
          onClick={onStart}
          disabled={isRunning || isTransition}
        >
          {phase === 'starting' ? <><span className="lnc-spinner" /> Starting…</> : '▶ Start'}
        </button>

        {/* Stop */}
        <button
          className="lnc-btn lnc-btn-danger"
          onClick={onStop}
          disabled={isStopped || isTransition || isError}
        >
          {phase === 'stopping' ? <><span className="lnc-spinner" /> Stopping…</> : '■ Stop'}
        </button>

        {/* Restart */}
        <button
          className="lnc-btn"
          onClick={onRestart}
          disabled={isStopped || isTransition || isError}
        >
          ↺ Restart
        </button>

        {/* Safe mode — only when error */}
        {isError && (
          <button className="lnc-btn" onClick={onSafeMode}>
            🛡 Safe Mode
          </button>
        )}
      </div>

      {isTransition && (
        <div style={{ fontSize: 11, color: 'var(--fg-faint)' }}>
          Controls locked while service transitions…
        </div>
      )}
    </div>
  );
}
