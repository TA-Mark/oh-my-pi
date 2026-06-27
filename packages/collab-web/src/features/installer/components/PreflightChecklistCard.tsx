import type { ReactNode } from 'react';
import type { PreflightCheck, CheckStatus } from '../types/installer';

interface Props {
  checks: PreflightCheck[];
  running: boolean;
}

function StatusIcon({ status }: { status: CheckStatus }): ReactNode {
  if (status === 'running') return <span className="ins-spinner" />;
  if (status === 'pass')    return <span style={{ color: 'var(--ok)' }}>✓</span>;
  if (status === 'fail')    return <span style={{ color: 'var(--err)' }}>✗</span>;
  if (status === 'warn')    return <span style={{ color: 'var(--warn)' }}>⚠</span>;
  return <span style={{ color: 'var(--fg-faint)' }}>○</span>;
}

export function PreflightChecklistCard({ checks, running }: Props): ReactNode {
  if (!running && checks.length === 0) return null;

  return (
    <div className="ins-card">
      <div className="ins-card-title">Pre-flight Checks</div>
      <div className="ins-checklist">
        {checks.length === 0 && running && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--fg-muted)' }}>
            <span className="ins-spinner" />
            Running checks…
          </div>
        )}
        {checks.map(check => (
          <div className="ins-check-item" key={check.id} data-status={check.status}>
            <div className="ins-check-icon">
              <StatusIcon status={check.status} />
            </div>
            <div className="ins-check-body">
              <div className="ins-check-label">{check.label}</div>
              {check.detail && <div className="ins-check-detail">{check.detail}</div>}
              {check.fixHint && <div className="ins-check-fix">{check.fixHint}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
