import { File, Folder, FolderOpen, Plus, RefreshCw, Search } from "lucide-react";
import { useEffect, useState } from "react";
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
	useEffect(() => {
		onRefresh(query);
		const timer = window.setInterval(() => onRefresh(query), 3000);
		return () => window.clearInterval(timer);
	}, [onRefresh, query]);
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
				<button type="button" disabled={loading} onClick={() => onRefresh(query)} aria-label="Refresh files">
					<RefreshCw size={14} />
				</button>
			</form>
			{truncated ? (
				<div className="files-warning">Results reached the workspace entry limit. Narrow the search.</div>
			) : null}
			<div className="files-workspace">
				<nav className="files-list" aria-label="Workspace files">
					{entries.length === 0 && !loading ? <p className="changes-empty">No matching files.</p> : null}
					{entries.map(entry => (
						<button
							type="button"
							key={`${entry.type}:${entry.path}`}
							className={entry.path === selectedPath ? "files-entry files-entry--active" : "files-entry"}
							onClick={() => entry.type === "file" && onOpen(entry.path)}
							title={entry.path}
						>
							{entry.type === "directory" ? <Folder size={14} /> : <File size={14} />}
							<span>{entry.path}</span>
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
									<button
										type="button"
										onClick={() =>
											onAddContext(content.path, window.getSelection()?.toString().trim() || undefined)
										}
									>
										<Plus size={14} /> Add to context
									</button>
								</div>
							</header>
							<pre className="files-preview-content">{content.content}</pre>
						</>
					) : (
						<div className="tools-placeholder">
							<p className="tools-placeholder-title">Select a file</p>
							<p className="tools-placeholder-copy">
								{entries.filter(entry => entry.type === "file").length} text candidates available.
							</p>
						</div>
					)}
				</section>
			</div>
		</div>
	);
}
