/**
 * configApi — wrappers over the bridge's /api/v1/config/* endpoints.
 *
 * These touch `~/.omp/agent/config.yml`, the same file the omp CLI reads/writes
 * via `omp config get|set|reset`. Use dot-paths for nested keys
 * (e.g. `modelRoles.default`, `theme.dark`, `searxng.endpoint`).
 */

const BASE = "http://localhost:8787/api/v1";

export interface OmpConfig {
	theme?: { dark?: string; light?: string };
	modelRoles?: Partial<Record<"default" | "smol" | "slow" | "plan" | "commit", string>>;
	steeringMode?: "one-at-a-time" | "all";
	followUpMode?: "one-at-a-time" | "all";
	interruptMode?: "immediate" | "wait";
	tools?: { discoveryMode?: "auto" | "manual" };
	debug?: { enabled?: boolean };
	extensions?: string[];
	skills?: Record<string, boolean>;
	images?: { autoResize?: boolean };
	searxng?: { endpoint?: string; token?: string; basicUsername?: string; basicPassword?: string };
	memory?: { backend?: string };
}

export type ConfigValue = string | number | boolean | null | string[] | Record<string, string | boolean>;

async function expectOk<T>(res: Response): Promise<T> {
	if (!res.ok) {
		const err = await res.json().catch(() => ({ code: "UNKNOWN", message: res.statusText }));
		throw Object.assign(new Error(err.message ?? res.statusText), { code: err.code });
	}
	return res.json() as Promise<T>;
}

export async function getConfig(): Promise<{ config: OmpConfig }> {
	return expectOk(await fetch(`${BASE}/config`, { signal: AbortSignal.timeout(5000) }));
}

export async function getConfigKey(key: string): Promise<{ key: string; value: ConfigValue | null }> {
	return expectOk(await fetch(`${BASE}/config/${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(5000) }));
}

export async function setConfigKey(key: string, value: ConfigValue): Promise<{ ok: boolean; key: string; config: OmpConfig }> {
	return expectOk(await fetch(`${BASE}/config/${encodeURIComponent(key)}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ value }),
	}));
}

export async function resetConfigKey(key: string): Promise<{ ok: boolean; key: string; config: OmpConfig }> {
	return expectOk(await fetch(`${BASE}/config/${encodeURIComponent(key)}`, { method: "DELETE" }));
}
