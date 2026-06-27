/**
 * installerApi — Desktop WebUI wrapper adapter.
 * Bridges the React installer UI to the local desktop bridge server.
 * Never imports oh-my-pi core logic — wrapper only.
 *
 * REST base: http://localhost:8787/api/v1
 * WS stream: ws://localhost:8787/api/v1/installer/jobs/{jobId}/stream
 */

import type {
  PreflightRequest,
  PreflightResponse,
  InstallRequest,
  InstallJobCreated,
  InstallStatusResponse,
  InstallActionResponse,
  StreamEvent,
  LogLine,
} from '../types/installer';

const BASE_URL = 'http://localhost:8787/api/v1';
const WS_BASE = 'ws://localhost:8787/api/v1';

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ code: 'UNKNOWN', message: res.statusText }));
    throw Object.assign(new Error(err.message ?? res.statusText), { code: err.code, detail: err.detail, actions: err.actions });
  }
  return res.json() as Promise<T>;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ code: 'UNKNOWN', message: res.statusText }));
    throw Object.assign(new Error(err.message ?? res.statusText), { code: err.code });
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** Run preflight checks — fast, synchronous on backend side. */
export async function runPreflight(req: PreflightRequest): Promise<PreflightResponse> {
  return post<PreflightResponse>('/installer/preflight', req);
}

/** Start an install job — returns immediately with jobId. */
export async function startInstall(req: InstallRequest): Promise<InstallJobCreated> {
  return post<InstallJobCreated>('/installer/jobs', req);
}

/** Poll job status (fallback when WS unavailable). */
export async function getInstallStatus(jobId: string): Promise<InstallStatusResponse> {
  return get<InstallStatusResponse>(`/installer/jobs/${jobId}/status`);
}

/** Cancel a running job. */
export async function cancelInstall(jobId: string): Promise<InstallActionResponse> {
  return post<InstallActionResponse>(`/installer/jobs/${jobId}/cancel`, {});
}

/** Repair a failed job. */
export async function repairInstall(jobId: string): Promise<InstallActionResponse> {
  return post<InstallActionResponse>(`/installer/jobs/${jobId}/repair`, {});
}

/** Fetch buffered log lines (fallback polling). */
export async function getInstallLogs(jobId: string, since?: string): Promise<LogLine[]> {
  const url = since
    ? `/installer/jobs/${jobId}/logs?since=${encodeURIComponent(since)}`
    : `/installer/jobs/${jobId}/logs`;
  const res = await get<{ jobId: string; lines: LogLine[] }>(url);
  return res.lines;
}

// ---------------------------------------------------------------------------
// WebSocket streaming
// ---------------------------------------------------------------------------

export interface StreamSubscription {
  close(): void;
}

/**
 * Subscribe to live log + phase events for a job via WebSocket.
 * Falls back gracefully if WS is unavailable.
 */
export function subscribeToJobStream(
  jobId: string,
  onEvent: (event: StreamEvent) => void,
  onError: (err: Error) => void,
): StreamSubscription {
  const url = `${WS_BASE}/installer/jobs/${jobId}/stream`;
  let ws: WebSocket | null = null;
  let closed = false;

  function connect(): void {
    if (closed) return;
    try {
      ws = new WebSocket(url);
      ws.onmessage = (e: MessageEvent) => {
        if (closed) return;
        try {
          const event = JSON.parse(e.data as string) as StreamEvent;
          onEvent(event);
        } catch {
          // malformed frame — ignore
        }
      };
      ws.onerror = () => {
        if (!closed) onError(new Error('WebSocket error on installer stream'));
      };
      ws.onclose = (e: CloseEvent) => {
        if (!closed && e.code !== 1000) {
          // transient close — retry after 2s
          setTimeout(connect, 2000);
        }
      };
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  connect();

  return {
    close() {
      closed = true;
      try { ws?.close(1000); } catch { /* already closed */ }
      ws = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Health check (checks if desktop bridge is running)
// ---------------------------------------------------------------------------

export async function checkBridgeHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}
