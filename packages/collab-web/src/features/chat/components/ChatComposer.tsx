/**
 * ChatComposer — extends existing shell Composer pattern
 * with Regenerate button + launcher health gating.
 * Talks to any transport that satisfies {@link ChatClient}
 * (GuestClient over collab, or RpcClient over the desktop bridge).
 */
import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { GuestSnapshot } from '../../../lib/client';
import type { ChatClient } from '../../../lib/chat-client';

interface Props {
  client: ChatClient;
  snapshot: GuestSnapshot;
  launcherHealthy: boolean;
  onGoToLauncher(): void;
}

const LINE_PX = 20;
const PAD_Y = 16;
const MAX_ROWS = 8;

export function ChatComposer({ client, snapshot, launcherHealthy, onGoToLauncher }: Props): ReactNode {
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const live      = snapshot.phase === 'live';
  const readOnly  = snapshot.readOnly;
  const canPrompt = live && !readOnly && launcherHealthy;
  const busy      = snapshot.working || (snapshot.state?.isStreaming ?? false);
  const queued    = snapshot.state?.queuedMessageCount ?? 0;
  const canSend   = canPrompt && text.trim().length > 0;

  // Auto-grow textarea
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = '0px';
    const max = MAX_ROWS * LINE_PX + PAD_Y;
    el.style.height = `${Math.max(LINE_PX + PAD_Y, Math.min(el.scrollHeight, max))}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [text]);

  const send = useCallback((): void => {
    const trimmed = text.trim();
    if (!trimmed || !live || readOnly || !launcherHealthy) return;
    client.sendPrompt(trimmed);
    setText('');
  }, [client, live, readOnly, launcherHealthy, text]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // Regenerate: abort current turn if busy, otherwise ask the transport to
  // regenerate. RpcClient maps sendRegenerate→sendAbort intentionally, so
  // calling both back-to-back would just send two aborts.
  const regenerate = useCallback((): void => {
    if (!live || readOnly || !launcherHealthy) return;
    if (busy) client.sendAbort();
    else client.sendRegenerate?.();
  }, [client, live, readOnly, busy, launcherHealthy]);

  const placeholder = !launcherHealthy
    ? 'Runtime service unavailable — go to Launcher to restart'
    : readOnly
    ? 'read-only session — watching only'
    : live
    ? 'prompt the host agent…'
    : 'waiting for session…';

  return (
    <div className="sh-composer">
      {/* Launcher unhealthy warning inline */}
      {!launcherHealthy && (
        <div
          style={{
            padding: '4px 12px 8px',
            fontSize: 11,
            color: 'var(--warn)',
            display: 'flex',
            gap: 8,
            alignItems: 'center',
          }}
        >
          ⚠ Runtime unavailable.
          <button
            type="button"
            style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: 11, cursor: 'pointer' }}
            onClick={onGoToLauncher}
          >
            Open Launcher →
          </button>
        </div>
      )}

      <div className="sh-composer-inner">
        <textarea
          ref={taRef}
          className="sh-composer-input"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={!canPrompt}
          rows={1}
          spellCheck={false}
          aria-label="Chat input"
        />
        <div className="sh-composer-actions">
          {/* Queued count */}
          {busy && queued > 0 && (
            <span className="sh-queued">
              <span className="sh-queued-label">queued </span>×{queued}
            </span>
          )}

          {/* Stop */}
          {busy && !readOnly && (
            <button
              type="button"
              className="sh-btn sh-btn-stop"
              onClick={() => client.sendAbort()}
              disabled={!live}
              title="Stop current turn"
              aria-label="Stop"
            >
              ▪ <span className="sh-btn-label">Stop</span>
            </button>
          )}

          {/* Regenerate — only when idle and has history */}
          {!busy && live && !readOnly && launcherHealthy && (
            <button
              type="button"
              className="sh-btn"
              onClick={regenerate}
              title="Regenerate last response"
              aria-label="Regenerate"
            >
              ↻ <span className="sh-btn-label">Regen</span>
            </button>
          )}

          {/* Send */}
          <button
            type="button"
            className="sh-btn sh-btn-primary"
            onClick={send}
            disabled={!canSend}
            title="Send (Enter)"
            aria-label="Send"
          >
            → <span className="sh-btn-label">Send</span>
          </button>
        </div>
      </div>
    </div>
  );
}
