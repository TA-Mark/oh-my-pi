import { useEffect, useRef, type ReactNode } from 'react';
import type { LogLine } from '../types/launcher';

interface Props {
  logs: LogLine[];
  open: boolean;
  onClose(): void;
  onClear(): void;
}

export function LauncherLogDrawer({ logs, open, onClose, onClear }: Props): ReactNode {
  const bodyRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !open) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [logs, open]);

  if (!open) return null;

  return (
    <div className="lnc-log-drawer">
      <div className="lnc-log-drawer-header">
        <span className="lnc-log-drawer-title">Runtime Logs</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="lnc-btn" onClick={onClear} style={{ padding: '2px 8px', fontSize: 11 }}>
            Clear
          </button>
          <button className="lnc-btn" onClick={onClose} style={{ padding: '2px 8px', fontSize: 11 }}>
            ✕ Close
          </button>
        </div>
      </div>

      <div className="lnc-log-body" ref={bodyRef}>
        {logs.length === 0 && (
          <div style={{ color: 'var(--fg-faint)', fontSize: 11 }}>No logs yet.</div>
        )}
        {logs.map((line, i) => (
          <div key={i} className="lnc-log-line" data-level={line.level}>
            <span style={{ opacity: 0.45, marginRight: 6 }}>
              {new Date(line.ts).toLocaleTimeString([], {
                hour: '2-digit', minute: '2-digit', second: '2-digit',
              })}
            </span>
            {line.source && (
              <span style={{ color: 'var(--fg-faint)', marginRight: 6 }}>[{line.source}]</span>
            )}
            {line.message}
          </div>
        ))}
      </div>
    </div>
  );
}
