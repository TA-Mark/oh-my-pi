/**
 * LogsDrawer — slide-up panel showing live omp stdout/stderr.
 *
 * Logs come from the bridge envelope `{type:"log", stream, line}` and are
 * captured by RpcClient (capped at 500 lines). Useful for diagnosing
 * provider errors, missing keys, and other runtime issues without
 * popping a terminal.
 */

import { type ReactNode, useEffect, useRef, useState } from "react";
import type { LogLine } from "../../../lib/client";

interface Props {
	logs: readonly LogLine[];
	open: boolean;
	onClose(): void;
}

function timeLabel(at: number): string {
	const d = new Date(at);
	const hh = d.getHours().toString().padStart(2, "0");
	const mm = d.getMinutes().toString().padStart(2, "0");
	const ss = d.getSeconds().toString().padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

export function LogsDrawer({ logs, open, onClose }: Props): ReactNode {
	const [filter, setFilter] = useState<"all" | "stdout" | "stderr">("all");
	const bodyRef = useRef<HTMLDivElement | null>(null);
	const [stickToBottom, setStickToBottom] = useState(true);

	const filtered = filter === "all" ? logs : logs.filter(l => l.stream === filter);

	useEffect(() => {
		if (!open || !stickToBottom) return;
		const el = bodyRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [open, filtered.length, stickToBottom]);

	if (!open) return null;

	return (
		<div className="mc-logs-drawer">
			<div className="mc-logs-head">
				<span className="mc-section-title" style={{ marginBottom: 0 }}>
					Logs
				</span>
				<div className="mc-segmented" style={{ width: "auto", flex: "none" }}>
					{(["all", "stdout", "stderr"] as const).map(f => (
						<button
							key={f}
							type="button"
							className="mc-segmented-btn"
							data-active={filter === f ? "true" : undefined}
							onClick={() => setFilter(f)}
						>
							{f}
						</button>
					))}
				</div>
				<span className="mc-logs-count">{filtered.length} lines</span>
				<button type="button" className="mc-header-iconbtn" onClick={onClose} title="Close logs">
					✕
				</button>
			</div>
			<div
				ref={bodyRef}
				className="mc-logs-body"
				onScroll={() => {
					const el = bodyRef.current;
					if (!el) return;
					const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
					setStickToBottom(atBottom);
				}}
			>
				{filtered.length === 0 ? (
					<div className="mc-providers-hint">No logs yet.</div>
				) : (
					filtered.map(l => (
						<div key={l.id} className="mc-log-line" data-stream={l.stream}>
							<span className="mc-log-ts">{timeLabel(l.at)}</span>
							<span className="mc-log-stream">{l.stream}</span>
							<span className="mc-log-text">{l.line}</span>
						</div>
					))
				)}
			</div>
		</div>
	);
}
