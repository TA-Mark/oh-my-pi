/**
 * launcherApi — Desktop WebUI wrapper adapter for Launcher phase.
 * Bridges React Launcher UI ↔ local desktop bridge server.
 * Never imports oh-my-pi core logic.
 *
 * REST base: http://localhost:8787/api/v1
 * WS stream: ws://localhost:8787/api/v1/launcher/stream
 */

import type {
	DiagnosticsResponse,
	LauncherStreamEvent,
	LogLine,
	RuntimeStatusResponse,
	ServiceActionResponse,
	UpdateActionResponse,
	UpdateChannel,
	UpdateInfo,
	WorkspaceListResponse,
} from "../types/launcher";

const BASE = "http://localhost:8787/api/v1";
const WS_BASE = "ws://localhost:8787/api/v1";

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function get<T>(path: string, timeoutMs = 5000): Promise<T> {
	const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
	if (!res.ok) {
		const err = await res.json().catch(() => ({ code: "UNKNOWN", message: res.statusText }));
		throw Object.assign(new Error(err.message ?? res.statusText), { code: err.code });
	}
	return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown = {}): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({ code: "UNKNOWN", message: res.statusText }));
		throw Object.assign(new Error(err.message ?? res.statusText), { code: err.code });
	}
	return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Runtime status
// ---------------------------------------------------------------------------

export async function getRuntimeStatus(): Promise<RuntimeStatusResponse> {
	return get<RuntimeStatusResponse>("/launcher/status");
}

// ---------------------------------------------------------------------------
// Service control
// ---------------------------------------------------------------------------

export async function startService(): Promise<ServiceActionResponse> {
	return post<ServiceActionResponse>("/launcher/start");
}

export async function stopService(): Promise<ServiceActionResponse> {
	return post<ServiceActionResponse>("/launcher/stop");
}

export async function restartService(): Promise<ServiceActionResponse> {
	return post<ServiceActionResponse>("/launcher/restart");
}

export async function startSafeMode(): Promise<ServiceActionResponse> {
	return post<ServiceActionResponse>("/launcher/safe-mode");
}

// ---------------------------------------------------------------------------
// Update & maintenance
// ---------------------------------------------------------------------------

export async function checkUpdate(): Promise<UpdateInfo> {
	return get<UpdateInfo>("/launcher/update/check");
}

export async function applyUpdate(channel: UpdateChannel): Promise<UpdateActionResponse> {
	return post<UpdateActionResponse>("/launcher/update/apply", { channel });
}

export async function repairInstall(): Promise<ServiceActionResponse> {
	return post<ServiceActionResponse>("/launcher/repair");
}

export async function resetCache(): Promise<ServiceActionResponse> {
	return post<ServiceActionResponse>("/launcher/reset-cache");
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export async function listWorkspaces(): Promise<WorkspaceListResponse> {
	return get<WorkspaceListResponse>("/launcher/workspaces");
}

export async function activateWorkspace(id: string): Promise<ServiceActionResponse> {
	return post<ServiceActionResponse>(`/launcher/workspaces/${id}/activate`);
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export async function runDiagnostics(): Promise<DiagnosticsResponse> {
	return post<DiagnosticsResponse>("/launcher/diagnostics");
}

// ---------------------------------------------------------------------------
// Runtime log stream (polling fallback)
// ---------------------------------------------------------------------------

export async function getRuntimeLogs(since?: string): Promise<LogLine[]> {
	const url = since ? `/launcher/logs?since=${encodeURIComponent(since)}` : "/launcher/logs";
	const res = await get<{ lines: LogLine[] }>(url);
	return res.lines;
}

// ---------------------------------------------------------------------------
// WebSocket live stream (status + logs + metrics)
// ---------------------------------------------------------------------------

export interface StreamSubscription {
	close(): void;
}

export function subscribeToLauncherStream(
	onEvent: (event: LauncherStreamEvent) => void,
	onError: (err: Error) => void,
): StreamSubscription {
	const url = `${WS_BASE}/launcher/stream`;
	let ws: WebSocket | null = null;
	let closed = false;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let attempt = 0;

	function connect(): void {
		if (closed) return;
		try {
			ws = new WebSocket(url);
			ws.onopen = () => {
				attempt = 0;
			};
			ws.onmessage = (e: MessageEvent) => {
				if (closed) return;
				try {
					onEvent(JSON.parse(e.data as string) as LauncherStreamEvent);
				} catch {
					/* malformed — ignore */
				}
			};
			ws.onerror = () => {
				if (!closed) onError(new Error("Launcher stream WebSocket error"));
			};
			ws.onclose = (e: CloseEvent) => {
				ws = null;
				if (!closed && e.code !== 1000) {
					const delay = Math.min(1000 * 2 ** attempt, 30000);
					attempt++;
					retryTimer = setTimeout(connect, delay);
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
			if (retryTimer !== null) {
				clearTimeout(retryTimer);
				retryTimer = null;
			}
			try {
				ws?.close(1000);
			} catch {
				/* already closed */
			}
			ws = null;
		},
	};
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export async function checkBridgeHealth(): Promise<boolean> {
	try {
		const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
		return res.ok;
	} catch {
		return false;
	}
}
