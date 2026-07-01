/**
 * ToolInspectorPanel — realtime + recent-history view of tool executions.
 *
 * Purely client-side: reads from the active session's {@link GuestSnapshot}
 * (`activeTools` map for in-flight calls, `entries` walk for completed
 * calls). Renders each with the shared {@link ToolCard} the transcript uses,
 * so tool-specific renderers (bash, grep, edit, glob, todo, …) work the same
 * as in the main transcript. Filter box narrows the list by tool name or
 * substring of args.
 */

import type { AssistantMessage, SessionEntry, ToolResultMessage } from "@oh-my-pi/pi-wire";
import { type ChangeEvent, type ReactNode, useMemo, useState } from "react";
import { ToolCard } from "../../../components/transcript/ToolCard";
import type { GuestSnapshot } from "../../../lib/client";

interface Props {
	snapshot: GuestSnapshot | null;
}

interface ToolRow {
	toolCallId: string;
	name: string;
	args: unknown;
	intent?: string;
	result?: ToolResultMessage;
	running: boolean;
	partialResult?: unknown;
	startedAt: number;
}

/** Cap on completed tools we render — protects the panel from 1000-entry sessions. */
const HISTORY_LIMIT = 50;

function assistantOf(entry: SessionEntry): AssistantMessage | null {
	if (entry.type !== "message") return null;
	return entry.message.role === "assistant" ? entry.message : null;
}

function toolResultOf(entry: SessionEntry): ToolResultMessage | null {
	if (entry.type !== "message") return null;
	return entry.message.role === "toolResult" ? entry.message : null;
}

/**
 * Walk entries once, harvesting toolCall blocks from assistant messages and
 * matching them with the toolResult messages that follow (matched by
 * `toolCallId`). Yields most-recent-first.
 */
function extractHistoricalTools(entries: readonly SessionEntry[]): ToolRow[] {
	const results = new Map<string, ToolResultMessage>();
	for (const entry of entries) {
		const tr = toolResultOf(entry);
		if (tr) results.set(tr.toolCallId, tr);
	}
	const rows: ToolRow[] = [];
	for (const entry of entries) {
		const am = assistantOf(entry);
		if (!am) continue;
		for (const block of am.content) {
			if (block.type !== "toolCall") continue;
			rows.push({
				toolCallId: block.id,
				name: block.name,
				args: block.arguments,
				intent: block.intent,
				result: results.get(block.id),
				running: false,
				startedAt: 0,
			});
		}
	}
	return rows.reverse().slice(0, HISTORY_LIMIT);
}

export function ToolInspectorPanel({ snapshot }: Props): ReactNode {
	const [filter, setFilter] = useState("");

	const rows = useMemo<ToolRow[]>(() => {
		if (!snapshot) return [];
		const active: ToolRow[] = Array.from(snapshot.activeTools.values()).map(t => ({
			toolCallId: t.toolCallId,
			name: t.toolName,
			args: t.args,
			intent: t.intent,
			partialResult: t.partialResult,
			running: true,
			startedAt: t.startedAt,
		}));
		const history = extractHistoricalTools(snapshot.entries);
		// De-dupe: a tool currently running is also in entries as a tool_use with
		// no matching result yet. Prefer the active-tools entry (has partialResult
		// + intent), drop the historical duplicate.
		const activeIds = new Set(active.map(r => r.toolCallId));
		const merged = [...active, ...history.filter(r => !activeIds.has(r.toolCallId))];
		return merged;
	}, [snapshot]);

	const filtered = useMemo(() => {
		const q = filter.trim().toLowerCase();
		if (!q) return rows;
		return rows.filter(r => {
			if (r.name.toLowerCase().includes(q)) return true;
			try {
				const argStr = typeof r.args === "string" ? r.args : JSON.stringify(r.args);
				return argStr.toLowerCase().includes(q);
			} catch {
				return false;
			}
		});
	}, [rows, filter]);

	if (!snapshot) {
		return (
			<div className="mc-panel-empty">
				<span>No active session — start a chat to see tool activity.</span>
			</div>
		);
	}

	return (
		<div className="mc-tools-panel">
			<div className="mc-tools-header">
				<input
					type="search"
					className="mc-tools-filter"
					placeholder="Filter by name or args…"
					value={filter}
					onChange={(ev: ChangeEvent<HTMLInputElement>) => setFilter(ev.target.value)}
				/>
				<span className="mc-tools-count">
					{filtered.length}
					{rows.length !== filtered.length ? ` of ${rows.length}` : ""} tool call{rows.length === 1 ? "" : "s"}
				</span>
			</div>
			{filtered.length === 0 ? (
				<div className="mc-panel-empty">
					<span>{filter ? "No matches for the current filter." : "No tool calls yet in this session."}</span>
				</div>
			) : (
				<div className="mc-tools-list">
					{filtered.map(row => (
						<div key={row.toolCallId} className="mc-tools-row" data-running={row.running ? "true" : "false"}>
							<ToolCard
								toolCallId={row.toolCallId}
								name={row.name}
								args={row.args}
								intent={row.intent}
								result={row.result}
								running={row.running}
								partialResult={row.partialResult}
							/>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
