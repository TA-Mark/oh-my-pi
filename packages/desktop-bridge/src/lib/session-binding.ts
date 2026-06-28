/**
 * Persistent map: chat session id → omp sessionFile on disk.
 *
 * The bridge captures `sessionFile` from omp's `get_state` response stream
 * and stores it here. On the next `/start` for the same session, the binding
 * tells us to spawn omp with `--resume <file>` so the transcript reloads.
 */

import { makeStore, type JsonStore } from "./store";

export interface SessionBinding {
	sessionFile: string;
	updatedAt: string;
}

export interface BindingsFile {
	bindings: Record<string, SessionBinding>;
}

export class SessionBindingStore {
	private readonly store: JsonStore<BindingsFile>;

	constructor(stateDir: string) {
		this.store = makeStore<BindingsFile>(stateDir, "session-bindings", { bindings: {} });
	}

	get(sessionId: string): SessionBinding | null {
		return this.store.get().bindings[sessionId] ?? null;
	}

	set(sessionId: string, sessionFile: string): void {
		this.store.mutate((s) => {
			s.bindings[sessionId] = { sessionFile, updatedAt: new Date().toISOString() };
		});
	}

	clear(sessionId: string): void {
		this.store.mutate((s) => {
			delete s.bindings[sessionId];
		});
	}
}
