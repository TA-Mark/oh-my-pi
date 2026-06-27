import type { ReactNode } from 'react';
import type { DiagCheck, DiagCheckStatus } from '../types/launcher';

interface Props {
  checks: DiagCheck[];
  running: boolean;
  onRunDiag(): void;
}

function DiagIcon({ status }: { status: DiagCheckStatus }): ReactNode {
  if (status === 'running') return <span className="lnc-spinner" />;
  if (status === 'ok')      return <span style={{ color: 'var(--ok)', fontSize: 13 }}>✓</span>;
  if (status === 'fail')    return <span style={{ color: 'var(--err)', fontSize: 13 }}>✗</span>;
  if (status === 'warn')    return <span style={{ color: 'var(--warn)', fontSize: 13 }}>⚠</span>;
  return null;
}

export function DiagnosticsCard({ checks, running, onRunDiag }: Props): ReactNode {
  return (
    <div className="lnc-card lnc-card-span">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="lnc-card-title">Health &amp; Diagnostics</div>
        <button
          className="lnc-btn"
          onClick={onRunDiag}
          disabled={running}
        >
          {running ? <><span className="lnc-spinner" /> Running…</> : '⚕ Run Diagnostics'}
        </button>
      </div>

      {checks.length === 0 && !running && (
        <div style={{ fontSize: 12, color: 'var(--fg-faint)' }}>
          Run diagnostics to check service health.
        </div>
      )}

      {checks.length > 0 && (
        <div className="lnc-diag-list">
          {checks.map(check => (
            <div key={check.id} className="lnc-diag-item" data-status={check.status}>
              <div style={{ marginTop: 2, flexShrink: 0 }}>
                <DiagIcon status={check.status} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="lnc-diag-label">{check.label}</div>
                {check.detail && <div className="lnc-diag-detail">{check.detail}</div>}
                {check.fixHint && <div className="lnc-diag-fix">{check.fixHint}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
