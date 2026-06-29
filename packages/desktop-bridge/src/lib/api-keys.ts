/**
 * Persistent API-key store for the desktop bridge.
 *
 * The web UI lets a user paste API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY,
 * GEMINI_API_KEY, …) without having to fiddle with shell env vars. We persist
 * them to `<installDir>/api-keys.json` and merge them into every omp child's
 * environment on spawn — that is the same surface omp itself reads.
 *
 * Stored shape:
 *   { "keys": { "ANTHROPIC_API_KEY": "sk-ant-…", "OPENAI_API_KEY": "sk-…" } }
 *
 * Security note: this file is plain JSON inside %LOCALAPPDATA%\omp-desktop
 * (per-user, never world-readable on Windows). v0.2 should encrypt at rest
 * via DPAPI / Keychain. For v0.1 the localhost-only bridge + per-user storage
 * already matches the trust level of `~/.zshrc` / `~/.bashrc` containing the
 * same keys in plain text — which is how every other CLI tool stores them.
 */

import { type JsonStore, makeStore } from "./store";

export interface ApiKeysFile {
	keys: Record<string, string>;
}

/** Strip everything but the last 4 chars so we never leak the full key over HTTP. */
export function maskKey(value: string): string {
	if (!value) return "";
	if (value.length <= 8) return "****";
	return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export class ApiKeyStore {
	private readonly store: JsonStore<ApiKeysFile>;

	constructor(stateDir: string) {
		this.store = makeStore<ApiKeysFile>(stateDir, "api-keys", { keys: {} });
	}

	/** Full key map — only used when spawning an omp child so we can populate env. */
	all(): Record<string, string> {
		return { ...this.store.get().keys };
	}

	/** Public listing for the UI: name + masked preview, never the raw value. */
	list(): Array<{ name: string; masked: string }> {
		const map = this.store.get().keys;
		return Object.entries(map).map(([name, value]) => ({ name, masked: maskKey(value) }));
	}

	set(name: string, value: string): void {
		this.store.mutate(s => {
			s.keys[name] = value;
		});
	}

	delete(name: string): boolean {
		const existed = name in this.store.get().keys;
		if (!existed) return false;
		this.store.mutate(s => {
			delete s.keys[name];
		});
		return true;
	}
}
