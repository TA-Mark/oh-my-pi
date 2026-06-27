import type { ReactNode } from 'react';
import type { ChatSession } from '../types/chat';

interface Props {
  sessions: ChatSession[];
  activeId: string | null;
  loading: boolean;
  onActivate(id: string, link: string): void;
  onDelete(id: string): void;
  onNew(): void;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return d.toLocaleDateString();
}

export function SessionList({ sessions, activeId, loading, onActivate, onDelete, onNew }: Props): ReactNode {
  return (
    <div>
      <div className="mc-section-title">Sessions</div>

      {loading && sessions.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--fg-faint)' }}>Loading…</div>
      )}

      {!loading && sessions.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--fg-faint)' }}>
          No sessions yet. Start one below.
        </div>
      )}

      <div className="mc-session-list">
        {sessions.map(s => (
          <div
            key={s.id}
            className="mc-session-item"
            data-active={s.id === activeId ? 'true' : 'false'}
            role="button"
            tabIndex={0}
            aria-label={`Session: ${s.name}`}
            onClick={() => onActivate(s.id, s.link)}
            onKeyDown={e => { if (e.key === 'Enter') onActivate(s.id, s.link); }}
          >
            <span className="mc-session-name">{s.name}</span>
            <span className="mc-session-meta">{fmtDate(s.lastActiveAt)}</span>
            <button
              type="button"
              className="mc-session-del"
              title="Delete session"
              aria-label={`Delete session ${s.name}`}
              onClick={e => { e.stopPropagation(); onDelete(s.id); }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <button
        type="button"
        className="mc-new-session-btn"
        onClick={onNew}
        disabled={loading}
      >
        + New Session
      </button>
    </div>
  );
}
