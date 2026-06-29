/**
 * SessionHeaderActions — rename, compact, export, auto-retry toggle, stats.
 *
 * Lives in the chat header next to the session title. All actions flow
 * through RpcClient so omp itself owns the source of truth.
 */

import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { ChatClient } from "../../../lib/chat-client";
import type { SessionStats } from "../../../lib/rpc-client";

interface Props {
	client: ChatClient | null;
	currentName: string;
	onRenamed(name: string): void;
}

function fmtTokens(n: number | undefined): string {
	if (typeof n !== "number" || !Number.isFinite(n)) return "—";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${n}`;
}

function fmtCost(n: number | undefined): string {
	if (typeof n !== "number" || !Number.isFinite(n)) return "—";
	if (n >= 100) return `$${n.toFixed(0)}`;
	if (n >= 1) return `$${n.toFixed(2)}`;
	return `$${n.toFixed(4)}`;
}

export function SessionHeaderActions({ client, currentName, onRenamed }: Props): ReactNode {
	const [stats, setStats] = useState<SessionStats | null>(null);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(currentName);
	const [exporting, setExporting] = useState(false);
	const [exportPath, setExportPath] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [branches, setBranches] = useState<Array<{ entryId: string; text: string }> | null>(null);
	const [branchOpen, setBranchOpen] = useState(false);
	const inputRef = useRef<HTMLInputElement | null>(null);

	// Periodic stats poll while a session is live (and the user hasn't hidden
	// the header). Lightweight — get_session_stats is local + cheap.
	useEffect(() => {
		if (!client?.sendGetSessionStats) return;
		let cancelled = false;
		const fetchStats = async () => {
			try {
				const s = await client.sendGetSessionStats!();
				if (!cancelled) setStats(s);
			} catch {
				// silently ignore — stats are cosmetic
			}
		};
		void fetchStats();
		const id = setInterval(fetchStats, 10_000);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, [client]);

	useEffect(() => {
		if (editing) {
			inputRef.current?.focus();
			inputRef.current?.select();
		}
	}, [editing]);

	useEffect(() => {
		setDraft(currentName);
	}, [currentName]);

	const startEdit = useCallback(() => {
		setEditing(true);
		setError(null);
	}, []);

	const commitRename = useCallback(() => {
		const next = draft.trim();
		setEditing(false);
		if (!next || next === currentName) {
			setDraft(currentName);
			return;
		}
		client?.sendSetSessionName?.(next);
		onRenamed(next);
	}, [draft, currentName, client, onRenamed]);

	const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
		if (e.key === "Enter") {
			e.preventDefault();
			commitRename();
		} else if (e.key === "Escape") {
			e.preventDefault();
			setEditing(false);
			setDraft(currentName);
		}
	};

	const handleCompact = useCallback(() => {
		client?.sendCompact?.();
	}, [client]);

	const handleExport = useCallback(async () => {
		if (!client?.sendExportHtml) return;
		setExporting(true);
		setError(null);
		try {
			const res = await client.sendExportHtml();
			setExportPath(res.path);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setExporting(false);
		}
	}, [client]);

	const handleOpenBranches = useCallback(async () => {
		if (!client?.sendGetBranchMessages) return;
		setBranchOpen(true);
		try {
			const list = await client.sendGetBranchMessages();
			setBranches(list);
		} catch (err) {
			setBranches([]);
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [client]);

	const handlePickBranch = useCallback(
		(entryId: string) => {
			client?.sendBranch?.(entryId);
			setBranchOpen(false);
		},
		[client],
	);

	return (
		<div className="mc-header-session">
			{/* Inline rename */}
			{editing ? (
				<input
					ref={inputRef}
					className="mc-header-rename"
					value={draft}
					onChange={e => setDraft(e.target.value)}
					onBlur={commitRename}
					onKeyDown={onKey}
					spellCheck={false}
				/>
			) : (
				<button type="button" className="mc-session-title-btn" onClick={startEdit} title="Click to rename">
					{currentName}
				</button>
			)}

			{/* Stats chips */}
			{stats && (
				<div className="mc-header-stats" title="Session totals">
					{typeof stats.totalTokens === "number" && (
						<span className="mc-stat-chip">
							<span className="mc-stat-key">tok</span>
							{fmtTokens(stats.totalTokens)}
						</span>
					)}
					{typeof stats.totalCost === "number" && (
						<span className="mc-stat-chip">
							<span className="mc-stat-key">cost</span>
							{fmtCost(stats.totalCost)}
						</span>
					)}
					{typeof stats.turnCount === "number" && (
						<span className="mc-stat-chip">
							<span className="mc-stat-key">turns</span>
							{stats.turnCount}
						</span>
					)}
				</div>
			)}

			{/* Action buttons */}
			<div className="mc-header-actions">
				<button
					type="button"
					className="mc-header-iconbtn"
					onClick={handleOpenBranches}
					disabled={!client?.sendGetBranchMessages}
					title="View alternative branches at this point"
				>
					⑂ Branches
				</button>
				<button
					type="button"
					className="mc-header-iconbtn"
					onClick={handleCompact}
					disabled={!client?.sendCompact}
					title="Compact this session — summarize older context"
				>
					⊟ Compact
				</button>
				<button
					type="button"
					className="mc-header-iconbtn"
					onClick={handleExport}
					disabled={!client?.sendExportHtml || exporting}
					title="Export transcript as HTML"
				>
					{exporting ? "Exporting…" : "↗ Export"}
				</button>
			</div>

			{branchOpen && (
				<div className="mc-dialog-overlay" onMouseDown={() => setBranchOpen(false)}>
					<div className="mc-dialog" onMouseDown={e => e.stopPropagation()}>
						<div className="mc-dialog-title">Branch points</div>
						{branches === null && <div className="mc-providers-hint">Loading…</div>}
						{branches?.length === 0 && (
							<div className="mc-providers-hint">
								No branches yet — every user message becomes a branch point.
							</div>
						)}
						{branches && branches.length > 0 && (
							<div className="mc-dialog-options" role="listbox" tabIndex={-1}>
								{branches.map(b => (
									<button
										key={b.entryId}
										type="button"
										className="mc-dialog-option"
										onClick={() => handlePickBranch(b.entryId)}
										title={b.entryId}
									>
										<span className="mc-dialog-option-label">{b.text || "(empty)"}</span>
									</button>
								))}
							</div>
						)}
						<div className="mc-dialog-actions">
							<button type="button" className="mc-btn" onClick={() => setBranchOpen(false)}>
								Close
							</button>
						</div>
					</div>
				</div>
			)}

			{exportPath && (
				<span className="mc-header-toast" title={exportPath}>
					Exported → {exportPath.split(/[\\/]/).pop()}
				</span>
			)}
			{error && (
				<span className="mc-header-toast mc-header-toast--err" title={error}>
					{error}
				</span>
			)}
		</div>
	);
}
