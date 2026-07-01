/**
 * FileBrowserPanel — read-only tree browser + text preview for the session
 * working directory. Bridge enforces path safety (`GET /api/v1/fs` refuses
 * anything outside `installDir` and `$HOME`); this panel just navigates.
 */

import { type ReactNode, useCallback, useEffect, useState } from "react";

interface FsEntry {
	name: string;
	kind: "file" | "dir" | "symlink" | "other";
	size?: number;
	mtime?: number;
}

interface ListResponse {
	entries: FsEntry[];
	root: string;
	path: string;
}

interface ReadResponse {
	path: string;
	content: string;
	truncated: boolean;
	size: number;
	encoding: "utf-8" | "binary";
	error?: string;
}

const BASE = "http://127.0.0.1:8787/api/v1";

interface Props {
	activeSessionId: string | null;
}

/** Format a byte count as "1.2 KB" / "3.4 MB" for the item metadata row. */
function fmtSize(n: number | undefined): string {
	if (typeof n !== "number") return "";
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function parentPath(p: string): string {
	// Both / and \ separators (bridge returns realpath in native form).
	const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	if (idx <= 0) return p;
	return p.slice(0, idx);
}

function joinPath(base: string, name: string): string {
	const sep = base.includes("\\") ? "\\" : "/";
	if (base.endsWith(sep)) return base + name;
	return `${base}${sep}${name}`;
}

export function FileBrowserPanel({ activeSessionId }: Props): ReactNode {
	// Start at whatever the bridge chose for its installDir — realpath'd by
	// the fs route. Empty until first list call resolves it.
	const [cwd, setCwd] = useState<string>("");
	const [listing, setListing] = useState<FsEntry[] | null>(null);
	const [previewPath, setPreviewPath] = useState<string | null>(null);
	const [preview, setPreview] = useState<ReadResponse | null>(null);
	const [error, setError] = useState<string | null>(null);

	const doList = useCallback(async (path: string) => {
		setError(null);
		try {
			const url = path ? `${BASE}/fs?path=${encodeURIComponent(path)}&mode=list` : `${BASE}/fs?path=.&mode=list`;
			const res = await fetch(url);
			if (!res.ok) throw new Error(await res.text());
			const body = (await res.json()) as ListResponse;
			setCwd(body.path);
			setListing(body.entries);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setListing([]);
		}
	}, []);

	const doRead = useCallback(async (path: string) => {
		setError(null);
		setPreviewPath(path);
		try {
			const url = `${BASE}/fs?path=${encodeURIComponent(path)}&mode=read`;
			const res = await fetch(url);
			if (!res.ok) throw new Error(await res.text());
			const body = (await res.json()) as ReadResponse;
			setPreview(body);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPreview(null);
		}
	}, []);

	useEffect(() => {
		void doList("");
	}, [doList]);

	if (!activeSessionId) {
		return (
			<div className="mc-panel-empty">
				<span>No active session — start a chat to browse its workspace.</span>
			</div>
		);
	}

	return (
		<div className="mc-fs-panel">
			<div className="mc-panel-head">
				<span className="mc-panel-title">Files</span>
				<button type="button" className="sh-btn" onClick={() => void doList(parentPath(cwd))} disabled={!cwd}>
					↑ Up
				</button>
			</div>
			<div className="mc-panel-hint" title={cwd}>
				{cwd || "resolving…"}
			</div>
			{error && <div className="mc-panel-error">{error}</div>}
			<div className="mc-fs-split">
				<ul className="mc-fs-list">
					{listing === null ? (
						<li className="mc-panel-empty">Loading…</li>
					) : listing.length === 0 ? (
						<li className="mc-panel-empty">Empty directory.</li>
					) : (
						listing.map(entry => (
							<li key={entry.name} className="mc-fs-item">
								<button
									type="button"
									className="mc-fs-item-btn"
									onClick={() => {
										const next = joinPath(cwd, entry.name);
										if (entry.kind === "dir") void doList(next);
										else if (entry.kind === "file") void doRead(next);
									}}
								>
									<span className="mc-fs-item-icon">{entry.kind === "dir" ? "📁" : "📄"}</span>
									<span className="mc-fs-item-name">{entry.name}</span>
									{entry.kind === "file" && <span className="mc-fs-item-size">{fmtSize(entry.size)}</span>}
								</button>
							</li>
						))
					)}
				</ul>
				{preview && (
					<div className="mc-fs-preview">
						<div className="mc-fs-preview-head" title={preview.path}>
							{preview.path.split(/[/\\]/).pop()}
							<button
								type="button"
								className="mc-fs-preview-close"
								onClick={() => {
									setPreview(null);
									setPreviewPath(null);
								}}
								aria-label="Close preview"
							>
								×
							</button>
						</div>
						<div className="mc-fs-preview-meta">
							{fmtSize(preview.size)} · {preview.encoding}
							{preview.truncated && " · truncated"}
						</div>
						{preview.error ? (
							<div className="mc-panel-error">{preview.error}</div>
						) : (
							<pre className="mc-fs-preview-body">{preview.content}</pre>
						)}
					</div>
				)}
			</div>
			<div className="mc-panel-hint">
				Read-only. Preview capped at 512 KiB, binary files skipped. Session id: {activeSessionId.slice(0, 8)}
				{previewPath && "…"}
			</div>
		</div>
	);
}
