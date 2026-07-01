/**
 * Usage / cost dashboard — parses `~/.omp/sessions/**.jsonl` transcripts and
 * aggregates model usage.
 *
 * The TUI writes each session as a JSONL append log; message-end entries
 * carry a `usage` block from the provider. We walk every file, sum tokens
 * and cost per (day, model, provider, session), and return the aggregate.
 *
 * Route:
 *   GET /api/v1/usage → { totals, byModel[], byProvider[], byDay[], topSessions[] }
 *
 * Not authoritative: the counts are approximate — OMP's own accounting is
 * the source of truth for a live session's context bar. This endpoint is a
 * post-hoc report for spend visibility across sessions.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { errorResponse, jsonResponse } from "../lib/http";

/** Session dir mirrors packages/utils/src/dirs.ts (`~/.omp/sessions`). */
function sessionsDir(): string {
	const ompHome = process.env.OMP_HOME;
	if (ompHome) return join(ompHome, "sessions");
	return join(homedir(), ".omp", "sessions");
}

interface UsageBlock {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
	totalCost?: number;
}

interface Row {
	model: string;
	provider: string;
	sessionFile: string;
	day: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheCreation: number;
	cost: number;
	timestamp: number;
}

function parseUsage(u: unknown): UsageBlock | null {
	if (!u || typeof u !== "object") return null;
	return u as UsageBlock;
}

function dayKey(ts: number): string {
	const d = new Date(ts);
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function walkJsonl(dir: string, out: string[]): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		const p = join(dir, name);
		let stat: import("node:fs").Stats;
		try {
			stat = statSync(p);
		} catch {
			continue;
		}
		if (stat.isDirectory()) walkJsonl(p, out);
		else if (name.endsWith(".jsonl")) out.push(p);
	}
}

function parseSessionFile(path: string): Row[] {
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch {
		return [];
	}
	const rows: Row[] = [];
	// Track current model context (each `model_change` entry updates it; message
	// entries inherit whatever model was last set).
	let currentModel = "unknown";
	let currentProvider = "unknown";

	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (entry.type === "model_change" && typeof entry.model === "object" && entry.model) {
			const m = entry.model as { id?: string; provider?: string };
			if (m.id) currentModel = m.id;
			if (m.provider) currentProvider = m.provider;
			continue;
		}
		if (entry.type !== "message") continue;
		const msg = entry.message as Record<string, unknown> | undefined;
		if (msg?.role !== "assistant") continue;
		const usage = parseUsage(msg.usage);
		if (!usage) continue;
		const ts = typeof entry.timestamp === "number" ? entry.timestamp : Date.parse(String(entry.createdAt ?? ""));
		const timestamp = Number.isFinite(ts) ? ts : Date.now();
		rows.push({
			model: currentModel,
			provider: currentProvider,
			sessionFile: path,
			day: dayKey(timestamp),
			input: Number(usage.inputTokens ?? 0),
			output: Number(usage.outputTokens ?? 0),
			cacheRead: Number(usage.cacheReadTokens ?? 0),
			cacheCreation: Number(usage.cacheCreationTokens ?? 0),
			cost: Number(usage.totalCost ?? 0),
			timestamp,
		});
	}
	return rows;
}

interface Bucket {
	key: string;
	label: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheCreation: number;
	cost: number;
	count: number;
}

function bucketize(rows: Row[], keyFn: (r: Row) => string, labelFn: (r: Row) => string): Bucket[] {
	const map = new Map<string, Bucket>();
	for (const r of rows) {
		const k = keyFn(r);
		let b = map.get(k);
		if (!b) {
			b = {
				key: k,
				label: labelFn(r),
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheCreation: 0,
				cost: 0,
				count: 0,
			};
			map.set(k, b);
		}
		b.input += r.input;
		b.output += r.output;
		b.cacheRead += r.cacheRead;
		b.cacheCreation += r.cacheCreation;
		b.cost += r.cost;
		b.count += 1;
	}
	return Array.from(map.values()).sort((a, b) => b.cost - a.cost);
}

export async function handleUsage(req: Request, _url: URL): Promise<Response> {
	if (req.method !== "GET") {
		return errorResponse("METHOD_NOT_ALLOWED", "usage endpoint only supports GET", 405);
	}
	const files: string[] = [];
	walkJsonl(sessionsDir(), files);
	const rows: Row[] = [];
	for (const f of files) rows.push(...parseSessionFile(f));

	const totals = rows.reduce(
		(acc, r) => {
			acc.input += r.input;
			acc.output += r.output;
			acc.cacheRead += r.cacheRead;
			acc.cacheCreation += r.cacheCreation;
			acc.cost += r.cost;
			acc.messages += 1;
			return acc;
		},
		{ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0, messages: 0, sessions: files.length },
	);

	return jsonResponse({
		totals,
		byModel: bucketize(
			rows,
			r => `${r.provider}/${r.model}`,
			r => `${r.provider}/${r.model}`,
		),
		byProvider: bucketize(
			rows,
			r => r.provider,
			r => r.provider,
		),
		byDay: bucketize(
			rows,
			r => r.day,
			r => r.day,
		).sort((a, b) => a.key.localeCompare(b.key)),
		topSessions: bucketize(
			rows,
			r => r.sessionFile,
			r => r.sessionFile,
		).slice(0, 10),
	});
}
