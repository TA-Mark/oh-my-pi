import { ChevronDown, ChevronRight, File, Folder, FolderOpen, Plus, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { WorkspaceEntry, WorkspaceFileContent } from "../lib/rpc-protocol";

interface FilesPanelProps {
	entries: WorkspaceEntry[];
	content: WorkspaceFileContent | null;
	selectedPath: string | null;
	loading: boolean;
	truncated: boolean;
	onRefresh: (query?: string) => void;
	onOpen: (path: string) => void;
	onReveal: (path: string) => void;
	onAddContext: (path: string, selection?: string) => void;
}

export function FilesPanel({
	entries,
	content,
	selectedPath,
	loading,
	truncated,
	onRefresh,
	onOpen,
	onReveal,
	onAddContext,
}: FilesPanelProps) {
	const [query, setQuery] = useState("");
	const [collapsedDirectories, setCollapsedDirectories] = useState<Set<string>>(() => new Set());
	const files = useMemo(() => entries.filter(entry => entry.type === "file"), [entries]);
	const visibleEntries = useMemo(
		() =>
			entries.filter(entry => {
				const segments = entry.path.split("/");
				for (let index = 1; index < segments.length; index++) {
					if (collapsedDirectories.has(segments.slice(0, index).join("/"))) return false;
				}
				return true;
			}),
		[collapsedDirectories, entries],
	);

	useEffect(() => {
		onRefresh(query);
		const timer = window.setInterval(() => onRefresh(query), 3000);
		return () => window.clearInterval(timer);
	}, [onRefresh, query]);

	const addSelection = (): void => {
		if (!content) return;
		const selection = window.getSelection()?.toString().trim();
		onAddContext(content.path, selection || undefined);
	};

	return (
		<div className="files-panel">
			<form
				className="files-search"
				onSubmit={event => {
					event.preventDefault();
					onRefresh(query);
				}}
			>
				<Search size={15} />
				<input
					value={query}
					onChange={event => setQuery(event.currentTarget.value)}
					placeholder="Search workspace files"
				/>
				<button type="submit" disabled={loading}>
					Search
				</button>
				<button
					type="button"
					title="Refresh files"
					aria-label="Refresh files"
					disabled={loading}
					onClick={() => onRefresh(query)}
				>
					<RefreshCw size={14} className={loading ? "spin" : undefined} />
				</button>
			</form>
			{truncated ? (
				<div className="files-warning">Results reached the workspace entry limit. Narrow the search.</div>
			) : null}
			<div className="files-workspace">
				<nav className="files-list" aria-label="Workspace files">
					{entries.length === 0 && !loading ? <p className="changes-empty">No matching files.</p> : null}
					{visibleEntries.map(entry => (
						<button
							type="button"
							key={`${entry.type}:${entry.path}`}
							className={entry.path === selectedPath ? "files-entry files-entry--active" : "files-entry"}
							onClick={() => {
								if (entry.type === "file") onOpen(entry.path);
								else
									setCollapsedDirectories(current => {
										const next = new Set(current);
										if (next.has(entry.path)) next.delete(entry.path);
										else next.add(entry.path);
										return next;
									});
							}}
							title={entry.path}
							style={{ paddingLeft: 8 + Math.max(0, entry.path.split("/").length - 1) * 14 }}
						>
							{entry.type === "directory" ? (
								collapsedDirectories.has(entry.path) ? (
									<ChevronRight size={13} />
								) : (
									<ChevronDown size={13} />
								)
							) : (
								<span className="files-entry-spacer" />
							)}
							{entry.type === "directory" ? <Folder size={14} /> : <File size={14} />}
							<span>{entry.name}</span>
						</button>
					))}
				</nav>
				<section className="files-preview">
					{content ? (
						<>
							<header className="files-preview-head">
								<div>
									<strong>{content.path}</strong>
									<small>
										{content.size.toLocaleString()} bytes{content.truncated ? " · preview truncated" : ""}
									</small>
								</div>
								<div>
									<button type="button" onClick={() => onReveal(content.path)}>
										<FolderOpen size={14} /> Reveal
									</button>
									<button type="button" onClick={addSelection}>
										<Plus size={14} /> Add to context
									</button>
								</div>
							</header>
							<pre className="files-preview-content">{content.content}</pre>
						</>
					) : (
						<div className="tools-placeholder">
							<p className="tools-placeholder-title">Select a file</p>
							<p className="tools-placeholder-copy">{files.length} text candidates available.</p>
						</div>
					)}
				</section>
			</div>
		</div>
	);
}
