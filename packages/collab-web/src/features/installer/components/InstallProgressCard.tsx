import { useEffect, useRef, type ReactNode } from 'react';
import type { InstallStep, LogLine, CheckStatus } from '../types/installer';

interface Props {
  steps: InstallStep[];
  logs: LogLine[];
  progress: number;
  currentStep: string;
  failed: boolean;
}

function StepIcon({ status }: { status: CheckStatus }): ReactNode {
  if (status === 'running') return <span className="ins-spinner" />;
  if (status === 'pass')    return <span style={{ color: 'var(--ok)', fontSize: 13 }}>✓</span>;
  if (status === 'fail')    return <span style={{ color: 'var(--err)', fontSize: 13 }}>✗</span>;
  if (status === 'warn')    return <span style={{ color: 'var(--warn)', fontSize: 13 }}>⚠</span>;
  return <span style={{ width: 12, height: 12, borderRadius: '50%', background: 'var(--border-strong)', display: 'inline-block' }} />;
}

export function InstallProgressCard({ steps, logs, progress, currentStep, failed }: Props): ReactNode {
  const logsRef = useRef<HTMLDivElement>(null);

  // Auto-scroll log to bottom, unless user scrolled up
  useEffect(() => {
    const el = logsRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [logs]);

  return (
    <div className="ins-card">
      <div className="ins-card-title">Installation Progress</div>

      {/* Progress bar */}
      <div>
        <div className="ins-progress-label">
          <span>{currentStep || 'Preparing…'}</span>
          <span>{progress}%</span>
        </div>
        <div className="ins-progress-track" style={{ marginTop: 4 }}>
          <div
            className="ins-progress-fill"
            style={{ width: `${progress}%` }}
            data-done={progress === 100 && !failed ? 'true' : undefined}
            data-failed={failed ? 'true' : undefined}
          />
        </div>
      </div>

      {/* Steps */}
      {steps.length > 0 && (
        <div className="ins-steps">
          {steps.map(step => (
            <div className="ins-step" key={step.id} data-status={step.status}>
              <StepIcon status={step.status} />
              <span>{step.label}</span>
            </div>
          ))}
        </div>
      )}

      {/* Log stream */}
      {logs.length > 0 && (
        <div className="ins-logs" ref={logsRef}>
          {logs.map((line, i) => (
            <div className="ins-log-line" key={i} data-level={line.level}>
              <span style={{ opacity: 0.45, marginRight: 6 }}>
                {new Date(line.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
              {line.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
