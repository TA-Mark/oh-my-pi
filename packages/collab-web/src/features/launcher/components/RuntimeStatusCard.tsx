import type { ReactNode } from 'react';
import type { LauncherPhase, ResourceMetrics } from '../types/launcher';

interface Props {
  phase: LauncherPhase;
  endpoint: string | null;
  healthy: boolean;
  version: string;
  lastStartedAt: string | null;
  metrics: ResourceMetrics | null;
}

const PHASE_LABELS: Record<LauncherPhase, string> = {
  stopped:          'Stopped',
  starting:         'Starting…',
  running_healthy:  'Running',
  running_degraded: 'Running (degraded)',
  error:            'Error',
  updating:         'Updating…',
  stopping:         'Stopping…',
};

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function RuntimeStatusCard({ phase, endpoint, healthy, version, lastStartedAt, metrics }: Props): ReactNode {
  const isRunning = phase === 'running_healthy' || phase === 'running_degraded';

  return (
    <div className={`lnc-card${phase === 'error' ? ' lnc-error-card' : ''}`}>
      <div className="lnc-card-title">Runtime Status</div>

      <div className="lnc-status-row">
        <span className="lnc-dot" data-phase={phase} />
        <div>
          <div className="lnc-status-label">{PHASE_LABELS[phase]}</div>
          {endpoint && (
            <div className="lnc-status-sub">{endpoint}</div>
          )}
          {!isRunning && lastStartedAt && (
            <div className="lnc-status-sub">
              Last started: {new Date(lastStartedAt).toLocaleTimeString()}
            </div>
          )}
        </div>
      </div>

      {isRunning && metrics && (
        <div className="lnc-metrics">
          <div className="lnc-metric">
            <span className="lnc-metric-label">CPU</span>
            <span className="lnc-metric-value">{metrics.cpuPct.toFixed(1)}%</span>
          </div>
          <div className="lnc-metric">
            <span className="lnc-metric-label">Memory</span>
            <span className="lnc-metric-value">{metrics.memMb}MB</span>
          </div>
          <div className="lnc-metric">
            <span className="lnc-metric-label">Uptime</span>
            <span className="lnc-metric-value">{formatUptime(metrics.uptimeMs)}</span>
          </div>
          {version && (
            <div className="lnc-metric">
              <span className="lnc-metric-label">Version</span>
              <span className="lnc-metric-value">{version}</span>
            </div>
          )}
        </div>
      )}

      {phase === 'error' && !healthy && (
        <div className="lnc-status-sub" style={{ color: 'var(--err)' }}>
          Service unhealthy — use Launch Control to retry or enter safe mode.
        </div>
      )}
    </div>
  );
}
