/**
 * SessionTabBar — VS Code-style horizontal tab strip above the chat area.
 *
 * Each tab corresponds to one open omp PTY session. Clicking a tab
 * activates it (parent creates/attaches the {@link PtyChatClient} on
 * demand); clicking `×` closes it (parent disposes the client and picks a
 * neighbor to focus). The `+` button on the right creates a fresh session.
 *
 * Not in Phase 1 (deferred):
 *   - Drag-reorder (needs a persistent order in state — cheap once
 *     openSessionIds is fully authoritative and no other reducer path
 *     mutates it).
 *   - Middle-click close (accessibility tradeoff — a keyboard-only user
 *     already has the visible × button).
 *   - Overflow menu (for now the tab strip scrolls horizontally).
 */

import { Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import type { ChatSession } from "../types/chat";

interface Props {
	sessions: readonly ChatSession[];
	openIds: readonly string[];
	activeId: string | null;
	onActivate(id: string): void;
	onClose(id: string): void;
	onNew(): void;
	/** Disables the New button while a session-create request is in flight. */
	newDisabled?: boolean;
}

export function SessionTabBar({
	sessions,
	openIds,
	activeId,
	onActivate,
	onClose,
	onNew,
	newDisabled,
}: Props): ReactNode {
	// Preserve the order of openIds; drop ids that no longer exist in the
	// session list (defensive — a background sessionsLoaded refresh can lag
	// behind a delete on another window).
	const tabs = openIds.map(id => sessions.find(s => s.id === id)).filter((s): s is ChatSession => s !== undefined);

	return (
		<div className="mc-tab-bar" role="tablist" aria-label="Open sessions">
			<div className="mc-tab-bar-scroll">
				{tabs.map(session => {
					const isActive = session.id === activeId;
					return (
						<div
							key={session.id}
							role="tab"
							aria-selected={isActive}
							data-active={isActive ? "true" : "false"}
							className="mc-tab"
							onClick={() => onActivate(session.id)}
							onKeyDown={ev => {
								if (ev.key === "Enter" || ev.key === " ") {
									ev.preventDefault();
									onActivate(session.id);
								}
							}}
							tabIndex={0}
						>
							<span className="mc-tab-label" title={session.name}>
								{session.name}
							</span>
							<button
								type="button"
								className="mc-tab-close"
								aria-label={`Close ${session.name}`}
								onClick={ev => {
									// Stop the click from bubbling to the tab activation handler —
									// otherwise closing an inactive tab would activate it first
									// and then close it, causing a flash of the wrong session.
									ev.stopPropagation();
									onClose(session.id);
								}}
							>
								<X size={12} />
							</button>
						</div>
					);
				})}
			</div>
			<button
				type="button"
				className="mc-tab-new"
				onClick={onNew}
				disabled={newDisabled}
				aria-label="New session"
				title="New session"
			>
				<Plus size={14} />
			</button>
		</div>
	);
}
