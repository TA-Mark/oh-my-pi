/**
 * prompt-history — capped ring of user prompts persisted to disk.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_ENTRIES = 200;

export class PromptHistory {
	private entries: string[] = [];
	private readonly filePath: string;

	constructor(stateDir: string) {
		this.filePath = join(stateDir, "prompt-history.json");
		this.load();
	}

	private load(): void {
		try {
			if (existsSync(this.filePath)) {
				const raw = readFileSync(this.filePath, "utf8");
				const data = JSON.parse(raw);
				if (Array.isArray(data)) this.entries = data;
			}
		} catch {
			this.entries = [];
		}
	}

	private save(): void {
		try {
			const dir = join(this.filePath, "..");
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			writeFileSync(this.filePath, JSON.stringify(this.entries), "utf8");
		} catch { /* best-effort */ }
	}

	push(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		const lastIdx = this.entries.lastIndexOf(trimmed);
		if (lastIdx >= 0) this.entries.splice(lastIdx, 1);
		this.entries.push(trimmed);
		if (this.entries.length > MAX_ENTRIES) {
			this.entries = this.entries.slice(-MAX_ENTRIES);
		}
		this.save();
	}

	list(): string[] {
		return [...this.entries];
	}

	search(query: string): string[] {
		if (!query) return this.list();
		const q = query.toLowerCase();
		return this.entries.filter(e => e.toLowerCase().includes(q));
	}
}
