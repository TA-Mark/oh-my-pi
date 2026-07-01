/**
 * DiffViewerPanel — read-only view of `git status` + `git diff` in the
 * active session's working directory. Bridge shells out to git; we render
 * the raw text with per-line coloring.
 *
 * Deep diff / three-way merges are out of scope here — the operator can
 * open `git difftool` in the terminal for anything richer.
 */

import { type ReactNode, useCallback, useEffect, useState } from "react";

interface DiffResponse {
	path: string;
	status: string;
	diff: string;
	truncated: boolean;
	sessionId?: string;
	staged?: boolean;
	error?: string;
}

const BASE = "http://127.0.0.1:8787/api/v1";

interface Props {
	activeSessionId: string | null;
}

/**
 * Classify a diff line by its leading character. Splitting here keeps the
 * render loop cheap — no per-line regex — and lets CSS handle the color
 * palette (green add, red remove, cyan hunk header, muted context).
 */
function classifyLine(line: string): "add" | "remove" | "hunk" | "meta" | "context" {
	if (line.startsWith("+++") || line.startsWith("---")) return "meta";
	if (line.startsWith("+")) return "add";
	if (line.startsWith("-")) return "remove";
	if (line.startsWith("@@")) return "hunk";
	if (line.startsWith("diff ") || line.startsWith("index ")) return "meta";
	return "context";
}

export function DiffViewerPanel({ activeSessionId }: Props): ReactNode {
	const [data, setData] = useState<DiffResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [staged, setStaged] = useState(false);

	const refresh = useCallback(async () => {
		if (!activeSessionId) return;
		setLoading(true);
		setError(null);
		try {
			const url = `${BASE}/diff?session=${encodeURIComponent(activeSessionId)}${staged ? "&staged=1" : ""}`;
			const res = await fetch(url);
			if (!res.ok) throw new Error(await res.text());
			const body = (await res.json()) as DiffResponse;
			setData(body);
			if (body.error) setError(body.error);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setData(null);
		} finally {
			setLoading(false);
		}
	}, [activeSessionId, staged]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	if (!activeSessionId) {
		return (
			<div className="mc-panel-empty">
				<span>No active session — start a chat to see workspace diffs.</span>
			</div>
		);
	}

	const diffLines = data?.diff ? data.diff.split("\n") : [];
	const statusLines = data?.status ? data.status.split("\n").filter(Boolean) : [];

	return (
		<div className="mc-diff-panel">
			<div className="mc-panel-head">
				<span className="mc-panel-title">Diff</span>
				<label className="mc-diff-toggle">
					<input type="checkbox" checked={staged} onChange={ev => setStaged(ev.target.checked)} />
					<span>Staged</span>
				</label>
				<button type="button" className="sh-btn" onClick={refresh} disabled={loading}>
					↻ Refresh
				</button>
			</div>
			{data && (
				<div className="mc-panel-hint" title={data.path}>
					{data.path}
				</div>
			)}
			{error && <div className="mc-panel-error">{error}</div>}
			{data && !error && (
				<>
					<section className="mc-diff-section">
						<h3 className="mc-diff-h">Status</h3>
						{statusLines.length === 0 ? (
							<div className="mc-panel-empty">Working tree clean.</div>
						) : (
							<ul className="mc-diff-status-list">
								{statusLines.map((line, i) => (
									<li key={`${i}-${line.slice(0, 40)}`} className="mc-diff-status-item">
										<code>{line}</code>
									</li>
								))}
							</ul>
						)}
					</section>
					<section className="mc-diff-section">
						<h3 className="mc-diff-h">Diff{staged && " (staged)"}</h3>
						{diffLines.length === 0 ? (
							<div className="mc-panel-empty">No changes to show.</div>
						) : (
							<pre className="mc-diff-body">
								{diffLines.map((line, i) => (
									<span
										key={`${i}-${line.slice(0, 40)}`}
										className={`mc-diff-line mc-diff-line-${classifyLine(line)}`}
									>
										{line}
										{"\n"}
									</span>
								))}
							</pre>
						)}
						{data.truncated && (
							<div className="mc-panel-hint">
								Output truncated. Run `git diff` in the terminal for the full view.
							</div>
						)}
					</section>
				</>
			)}
		</div>
	);
}
