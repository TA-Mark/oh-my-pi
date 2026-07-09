import { useState } from "react";
import type { MouseEvent } from "react";
import type { SessionSummary } from "../lib/rpc-protocol";

export interface ChatContextActions {
	isPinned: (session: SessionSummary) => boolean;
	isUnread: (session: SessionSummary) => boolean;
	onPin: (session: SessionSummary) => void;
	onRename: (session: SessionSummary) => void;
	onArchive: (session: SessionSummary) => void;
	onMarkUnread: (session: SessionSummary) => void;
	onOpenExplorer: (session: SessionSummary) => void;
	onCopyWorkingDirectory: (session: SessionSummary) => void;
	onCopySessionId: (session: SessionSummary) => void;
	onCopyDeeplink: (session: SessionSummary) => void;
	onOpenNewWindow: (session: SessionSummary) => void;
}

interface SessionHistoryProps {
	sessions: SessionSummary[];
	loading: boolean;
	onSelect: (session: SessionSummary) => void;
	emptyLabel?: string;
	contextActions?: ChatContextActions;
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

export function SessionHistory({
	sessions,
	loading,
	onSelect,
	emptyLabel = "No sessions yet.",
	contextActions,
}: SessionHistoryProps) {
	const [menu, setMenu] = useState<{ session: SessionSummary; x: number; y: number } | null>(null);

	const openMenu = (event: MouseEvent<HTMLButtonElement>, session: SessionSummary): void => {
		if (!contextActions) return;
		event.preventDefault();
		const menuWidth = 224;
		const menuHeight = 332;
		setMenu({
			session,
			x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
			y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
		});
	};

	const runAction = (action: (session: SessionSummary) => void): void => {
		if (!menu) return;
		action(menu.session);
		setMenu(null);
	};

	return (
		<div className="history-list">
			{loading && sessions.length === 0 ? (
				<p className="history-empty">Loading...</p>
			) : sessions.length === 0 ? (
				<p className="history-empty">{emptyLabel}</p>
			) : (
				sessions.map(session => (
					<button
						key={session.path}
						type="button"
						className={`history-item${session.active ? " history-item--active" : ""}${
							contextActions?.isPinned(session) ? " history-item--pinned" : ""
						}${contextActions?.isUnread(session) ? " history-item--unread" : ""}`}
						onClick={() => {
							if (!session.active) onSelect(session);
						}}
						onContextMenu={event => openMenu(event, session)}
						aria-disabled={session.active}
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
			{menu && contextActions ? (
				<>
					<button type="button" className="chat-menu-backdrop" aria-label="Close chat menu" onClick={() => setMenu(null)} />
					<div className="chat-context-menu" style={{ left: menu.x, top: menu.y }}>
						<button type="button" onClick={() => runAction(contextActions.onPin)}>
							{contextActions.isPinned(menu.session) ? "Unpin chat" : "Pin chat"}
						</button>
						<button type="button" onClick={() => runAction(contextActions.onRename)}>
							Rename chat
						</button>
						<button type="button" onClick={() => runAction(contextActions.onArchive)}>
							Archive chat
						</button>
						<button type="button" onClick={() => runAction(contextActions.onMarkUnread)}>
							{contextActions.isUnread(menu.session) ? "Mark as read" : "Mark as unread"}
						</button>
						<div className="chat-context-separator" />
						<button type="button" onClick={() => runAction(contextActions.onOpenExplorer)}>
							Open in Explorer
						</button>
						<button type="button" onClick={() => runAction(contextActions.onCopyWorkingDirectory)}>
							Copy working directory
						</button>
						<button type="button" onClick={() => runAction(contextActions.onCopySessionId)}>
							Copy session ID
						</button>
						<button type="button" onClick={() => runAction(contextActions.onCopyDeeplink)}>
							Copy deeplink
						</button>
						<div className="chat-context-separator" />
						<button type="button" onClick={() => runAction(contextActions.onOpenNewWindow)}>
							Open in new window
						</button>
					</div>
				</>
			) : null}
		</div>
	);
}
