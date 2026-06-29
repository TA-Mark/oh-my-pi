/**
 * chatApi — Desktop WebUI wrapper adapter for Main Chat phase.
 * Connects React chat UI ↔ local desktop bridge server.
 * Never imports oh-my-pi core logic.
 *
 * REST base: http://localhost:8787/api/v1
 */

import type {
	DataSourceListResponse,
	LauncherHealthStatus,
	RuntimeConfig,
	RuntimeConfigResponse,
	SessionListResponse,
} from "../types/chat";

const BASE = "http://localhost:8787/api/v1";

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
// Launcher health gate
// ---------------------------------------------------------------------------

export async function getLauncherHealth(): Promise<LauncherHealthStatus> {
	return get<LauncherHealthStatus>("/launcher/status", 10000);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function listSessions(): Promise<SessionListResponse> {
	return get<SessionListResponse>("/chat/sessions");
}

export async function createSession(name?: string): Promise<{ session: { id: string; link: string; name: string } }> {
	return post("/chat/sessions", { name: name ?? `Session ${new Date().toLocaleString()}` });
}

export async function deleteSession(id: string): Promise<void> {
	await fetch(`${BASE}/chat/sessions/${id}`, { method: "DELETE" });
}

export async function renameSession(id: string, name: string): Promise<void> {
	await post(`/chat/sessions/${id}/rename`, { name });
}

// ---------------------------------------------------------------------------
// Data sources
// ---------------------------------------------------------------------------

export async function listDataSources(): Promise<DataSourceListResponse> {
	return get<DataSourceListResponse>("/chat/data-sources");
}

export async function refreshDataSource(id: string): Promise<void> {
	await post(`/chat/data-sources/${id}/refresh`);
}

// ---------------------------------------------------------------------------
// Runtime config
// ---------------------------------------------------------------------------

export async function getRuntimeConfig(): Promise<RuntimeConfigResponse> {
	return get<RuntimeConfigResponse>("/chat/runtime-config");
}

export async function updateRuntimeConfig(patch: Partial<RuntimeConfig>): Promise<RuntimeConfigResponse> {
	return post<RuntimeConfigResponse>("/chat/runtime-config", patch);
}

// ---------------------------------------------------------------------------
// API keys (env vars piped to omp on session start)
// ---------------------------------------------------------------------------

export interface StoredApiKey {
	name: string;
	masked: string;
}

export async function listApiKeys(): Promise<{ keys: StoredApiKey[] }> {
	return get<{ keys: StoredApiKey[] }>("/chat/keys");
}

export async function saveApiKey(name: string, value: string): Promise<{ ok: boolean; name: string }> {
	return post<{ ok: boolean; name: string }>("/chat/keys", { name, value });
}

export async function deleteApiKey(name: string): Promise<void> {
	await fetch(`${BASE}/chat/keys/${encodeURIComponent(name)}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Provider catalog (full list of every LLM provider omp supports)
// ---------------------------------------------------------------------------

export type ProviderCatalogType = "oauth" | "api-key" | "coding-plan" | "local" | "discovery";

export interface ProviderCatalogEntry {
	id: string;
	name: string;
	type: ProviderCatalogType;
	envVars?: string[];
	defaultUrl?: string;
	description?: string;
	common?: boolean;
	configured: boolean;
	configuredVia: "stored-key" | "process-env" | null;
}

export interface ProviderCatalogResponse {
	providers: ProviderCatalogEntry[];
	total: number;
	byType: Record<ProviderCatalogType, number>;
}

export async function getProviderCatalog(): Promise<ProviderCatalogResponse> {
	return get<ProviderCatalogResponse>("/chat/providers/catalog");
}

// ---------------------------------------------------------------------------
// File search (for @file autocomplete)
// ---------------------------------------------------------------------------

export async function searchFiles(query: string, cwd?: string): Promise<{ files: string[] }> {
	const params = new URLSearchParams({ q: query });
	if (cwd) params.set("cwd", cwd);
	return get<{ files: string[] }>(`/chat/files/search?${params}`);
}

// ---------------------------------------------------------------------------
// Shell execution (bridge-owned)
// ---------------------------------------------------------------------------

export async function execBridgeBash(
	sessionId: string,
	command: string,
	hidden?: boolean,
): Promise<{ output: string; exitCode: number | null; cancelled: boolean }> {
	return post<{ output: string; exitCode: number | null; cancelled: boolean }>(
		`/chat/sessions/${sessionId}/bash`,
		{ command, hidden },
	);
}

// ---------------------------------------------------------------------------
// Python execution (persistent kernel)
// ---------------------------------------------------------------------------

export async function execBridgePython(
	sessionId: string,
	code: string,
	hidden?: boolean,
): Promise<{ output: string; error: string; exitCode: number | null }> {
	return post<{ output: string; error: string; exitCode: number | null }>(
		`/chat/sessions/${sessionId}/python`,
		{ code, hidden },
	);
}

// ---------------------------------------------------------------------------
// Plan mode (bridge-managed)
// ---------------------------------------------------------------------------

export async function planModeAction(
	sessionId: string,
	action: string,
	objective?: string,
): Promise<{ ok?: boolean; state?: unknown }> {
	return post<{ ok?: boolean; state?: unknown }>(`/chat/sessions/${sessionId}/plan`, { action, objective });
}

// ---------------------------------------------------------------------------
// Goal mode (bridge-managed)
// ---------------------------------------------------------------------------

export async function goalModeAction(
	sessionId: string,
	action: string,
	objective?: string,
): Promise<{ ok?: boolean; state?: unknown }> {
	return post<{ ok?: boolean; state?: unknown }>(`/chat/sessions/${sessionId}/goal`, { action, objective });
}

// ---------------------------------------------------------------------------
// OMP config
// ---------------------------------------------------------------------------

export async function getModelRoles(): Promise<{ roles: Record<string, string> }> {
	return get<{ roles: Record<string, string> }>("/chat/config/roles");
}

// ---------------------------------------------------------------------------
// Prompt history
// ---------------------------------------------------------------------------

export async function getPromptHistory(query?: string): Promise<{ entries: string[] }> {
	const params = query ? `?q=${encodeURIComponent(query)}` : "";
	return get<{ entries: string[] }>(`/chat/history${params}`);
}

export async function savePromptHistory(text: string): Promise<void> {
	await post("/chat/history", { text });
}
