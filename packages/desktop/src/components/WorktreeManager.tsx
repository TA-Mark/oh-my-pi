import { ExternalLink, RefreshCw, Trash2, X } from "lucide-react";
import type { WorktreeInfo } from "../lib/rpc-protocol";

interface WorktreeManagerProps {
	open: boolean;
	workspace: string;
	worktrees: WorktreeInfo[];
	loading: boolean;
	mutatingPath: string | null;
	onClose: () => void;
	onRefresh: () => void;
	onOpen: (path: string) => void;
	onRemove: (path: string, force: boolean) => void;
}

export function WorktreeManager({
	open,
	workspace,
	worktrees,
	loading,
	mutatingPath,
	onClose,
	onRefresh,
	onOpen,
	onRemove,
}: WorktreeManagerProps) {
	if (!open) return null;
	return (
		<div
			className="dialog-backdrop"
			role="presentation"
			onMouseDown={event => event.target === event.currentTarget && onClose()}
		>
			<section
				className="dialog worktree-manager"
				role="dialog"
				aria-modal="true"
				aria-labelledby="worktree-manager-title"
			>
				<header className="worktree-manager-head">
					<div>
						<h2 className="dialog-title" id="worktree-manager-title">
							Worktree Manager
						</h2>
						<p className="dialog-message">Open or safely remove registered Git worktrees.</p>
					</div>
					<button type="button" className="changes-icon-button" aria-label="Close" onClick={onClose}>
						<X size={17} />
					</button>
				</header>
				<div className="worktree-manager-toolbar">
					<span>{worktrees.length} registered</span>
					<button type="button" className="changes-pill-action" disabled={loading} onClick={onRefresh}>
						<RefreshCw size={14} className={loading ? "spin" : undefined} /> Refresh
					</button>
				</div>
				<div className="worktree-manager-list">
					{!loading && worktrees.length === 0 ? <p className="changes-empty">No registered worktrees.</p> : null}
					{worktrees.map(entry => {
						const active =
							entry.path.replaceAll("\\", "/").toLowerCase() === workspace.replaceAll("\\", "/").toLowerCase();
						const busy = mutatingPath === entry.path;
						return (
							<article className="worktree-manager-item" key={entry.path}>
								<div className="worktree-manager-info">
									<strong>{entry.branch ?? (entry.detached ? "Detached HEAD" : "Unknown branch")}</strong>
									<span title={entry.path}>{entry.path}</span>
									<small>{active ? "Current workspace" : (entry.head?.slice(0, 12) ?? "No HEAD")}</small>
								</div>
								<div className="worktree-manager-actions">
									<button type="button" disabled={active || busy} onClick={() => onOpen(entry.path)}>
										<ExternalLink size={14} /> Open
									</button>
									<button type="button" disabled={active || busy} onClick={() => onRemove(entry.path, false)}>
										<Trash2 size={14} /> Remove
									</button>
									<button
										type="button"
										className="worktree-force-remove"
										disabled={active || busy}
										onClick={() => onRemove(entry.path, true)}
									>
										Force remove
									</button>
								</div>
							</article>
						);
					})}
				</div>
			</section>
		</div>
	);
}
