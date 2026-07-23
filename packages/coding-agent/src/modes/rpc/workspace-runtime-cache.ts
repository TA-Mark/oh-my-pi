import * as fs from "node:fs/promises";
import * as path from "node:path";

export const RPC_WORKSPACE_RUNTIME_CACHE_MAX = 4;

export interface CanonicalWorkspace {
	cwd: string;
	key: string;
}

export async function canonicalWorkspace(cwd: string): Promise<CanonicalWorkspace> {
	const realCwd = path.normalize(await fs.realpath(cwd));
	return {
		cwd: realCwd,
		key: process.platform === "win32" ? realCwd.toLowerCase() : realCwd,
	};
}

export class RpcWorkspaceRuntimeCache<T> {
	readonly #entries = new Map<string, T>();

	constructor(readonly max: number = RPC_WORKSPACE_RUNTIME_CACHE_MAX) {
		if (!Number.isInteger(max) || max < 1) throw new Error("RPC workspace runtime cache max must be positive");
	}

	get size(): number {
		return this.#entries.size;
	}

	get(key: string): T | undefined {
		const value = this.#entries.get(key);
		if (value === undefined) return undefined;
		this.#entries.delete(key);
		this.#entries.set(key, value);
		return value;
	}

	set(key: string, value: T): T[] {
		this.#entries.delete(key);
		this.#entries.set(key, value);
		const evicted: T[] = [];
		while (this.#entries.size > this.max) {
			const oldestKey = this.#entries.keys().next().value;
			if (oldestKey === undefined) break;
			const oldest = this.#entries.get(oldestKey);
			this.#entries.delete(oldestKey);
			if (oldest !== undefined) evicted.push(oldest);
		}
		return evicted;
	}

	values(): T[] {
		return [...this.#entries.values()];
	}
}
