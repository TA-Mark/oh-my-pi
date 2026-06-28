/**
 * Tiny JSON-file backed persistence.
 * Atomic via write-temp-then-rename. In-memory cache invalidated on write.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class JsonStore<T extends object> {
	private cache: T | null = null;

	constructor(
		private readonly path: string,
		private readonly defaults: T,
	) {}

	get(): T {
		if (this.cache !== null) return this.cache;
		if (!existsSync(this.path)) {
			this.cache = structuredClone(this.defaults);
			return this.cache;
		}
		try {
			this.cache = JSON.parse(readFileSync(this.path, "utf8")) as T;
		} catch {
			this.cache = structuredClone(this.defaults);
		}
		return this.cache;
	}

	set(value: T): void {
		const tmp = `${this.path}.tmp`;
		writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
		renameSync(tmp, this.path);
		this.cache = value;
	}

	mutate(fn: (current: T) => void): T {
		const next = structuredClone(this.get());
		fn(next);
		this.set(next);
		return next;
	}
}

export function makeStore<T extends object>(stateDir: string, name: string, defaults: T): JsonStore<T> {
	return new JsonStore<T>(join(stateDir, `${name}.json`), defaults);
}
