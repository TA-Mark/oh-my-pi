import type { ReactNode } from 'react';
import type { InstallerPhase } from '../types/installer';

interface Props {
  phase: InstallerPhase;
  onStartChecks(): void;
  onInstall(): void;
  onCancel(): void;
  onRetry(): void;
  onOpenLauncher(): void;
}

export function InstallerActionBar({
  phase,
  onStartChecks,
  onInstall,
  onCancel,
  onRetry,
  onOpenLauncher,
}: Props): ReactNode {
  return (
    <div className="ins-actionbar">
      <div className="ins-actionbar-left">
        {/* Cancel — visible while checking or installing */}
        {(phase === 'checking' || phase === 'installing') && (
          <button className="ins-btn ins-btn-danger" onClick={onCancel}>
            Cancel
          </button>
        )}

        {/* Retry — visible after failure or cancel */}
        {(phase === 'failed' || phase === 'cancelled' || phase === 'check_fail') && (
          <button className="ins-btn" onClick={onRetry}>
            ↩ Start Over
          </button>
        )}
      </div>

      <div className="ins-actionbar-right">
        {/* Start checks — idle state */}
        {phase === 'idle' && (
          <button className="ins-btn ins-btn-primary" onClick={onStartChecks}>
            Start Checks
          </button>
        )}

        {/* Run install — ready state */}
        {phase === 'ready' && (
          <button className="ins-btn ins-btn-primary" onClick={onInstall}>
            Install Now
          </button>
        )}

        {/* Checking in progress */}
        {phase === 'checking' && (
          <button className="ins-btn" disabled>
            <span className="ins-spinner" />
            Checking…
          </button>
        )}

        {/* Installing in progress */}
        {phase === 'installing' && (
          <button className="ins-btn" disabled>
            <span className="ins-spinner" />
            Installing…
          </button>
        )}

        {/* Success — open launcher */}
        {phase === 'success' && (
          <button className="ins-btn ins-btn-primary" onClick={onOpenLauncher}>
            Open Launcher →
          </button>
        )}

        {/* Failed — re-run install (repair) */}
        {phase === 'failed' && (
          <button className="ins-btn ins-btn-primary" onClick={onInstall}>
            Retry Install
          </button>
        )}
      </div>
    </div>
  );
}
