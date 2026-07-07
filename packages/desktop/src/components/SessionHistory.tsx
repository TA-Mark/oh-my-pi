import type { SessionSummary } from "../lib/rpc-protocol";

interface SessionHistoryProps {
	open: boolean;
	sessions: SessionSummary[];
	loading: boolean;
	onSelect: (session: SessionSummary) => void;
	onClose: () => void;
}

function relativeTime(iso: string): string {
	const then = new Date(iso).getTime();
	if (!Number.isFinite(then)) return "";
	const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
	if (secs < 60) return "now";
	const mins = Math.round(secs / 60);
	if (mins < 60) return `${mins}m`;
	const hours = Math.round(mins / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

export function SessionHistory({ open, sessions, loading, onSelect, onClose }: SessionHistoryProps) {
	if (!open) return null;
	return (
		<aside className="history-drawer">
			<div className="history-head">
				<span className="history-title">History</span>
				<button type="button" className="btn btn-ghost history-close" title="Close" onClick={onClose}>
					×
				</button>
			</div>
			<div className="history-list">
				{loading && sessions.length === 0 ? (
					<p className="history-empty">Loading…</p>
				) : sessions.length === 0 ? (
					<p className="history-empty">No sessions yet.</p>
				) : (
					sessions.map(session => (
						<button
							key={session.path}
							type="button"
							className={`history-item${session.active ? " history-item--active" : ""}`}
							onClick={() => onSelect(session)}
							disabled={session.active}
							title={session.title ?? session.id}
						>
							<span className="history-item-dot" aria-hidden="true" />
							<span className="history-item-body">
								<span className="history-item-name">{session.title || "untitled"}</span>
								<span className="history-item-meta">
									{session.messageCount} msgs · {relativeTime(session.modified)}
								</span>
							</span>
						</button>
					))
				)}
			</div>
		</aside>
	);
}
