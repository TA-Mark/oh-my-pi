/**
 * UsagePanel — post-hoc summary of token spend across every session file
 * OMP has written to `~/.omp/sessions/`. Read-only.
 *
 * Renders three sections in the sidebar:
 *   • Totals (grand total tokens + cost across all sessions)
 *   • Top models by cost (with a CSS bar per row for at-a-glance
 *     proportions — no chart library dependency).
 *   • Recent days (last 30, ordered oldest→newest).
 *
 * Bridge parses the JSONL transcripts on each request; the panel just
 * displays. If OMP's session format changes, the bridge's usage.ts is the
 * single place to update.
 */

import { type ReactNode, useCallback, useEffect, useState } from "react";

interface Totals {
	input: number;
	output: number;
	cacheRead: number;
	cacheCreation: number;
	cost: number;
	messages: number;
	sessions: number;
}

interface Bucket {
	key: string;
	label: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheCreation: number;
	cost: number;
	count: number;
}

interface UsageResponse {
	totals: Totals;
	byModel: Bucket[];
	byProvider: Bucket[];
	byDay: Bucket[];
	topSessions: Bucket[];
}

const BASE = "http://127.0.0.1:8787/api/v1";

function fmtNumber(n: number | undefined): string {
	if (typeof n !== "number" || !Number.isFinite(n)) return "—";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${n}`;
}

function fmtCost(n: number | undefined): string {
	if (typeof n !== "number" || !Number.isFinite(n)) return "—";
	if (n >= 100) return `$${n.toFixed(0)}`;
	if (n >= 1) return `$${n.toFixed(2)}`;
	if (n === 0) return "$0";
	return `$${n.toFixed(4)}`;
}

/** Trim a session file path to just its basename for the "top sessions" list. */
function sessionLabel(fullPath: string): string {
	const idx = Math.max(fullPath.lastIndexOf("/"), fullPath.lastIndexOf("\\"));
	if (idx < 0) return fullPath;
	return fullPath.slice(idx + 1);
}

export function UsagePanel(): ReactNode {
	const [data, setData] = useState<UsageResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await fetch(`${BASE}/usage`);
			if (!res.ok) throw new Error(await res.text());
			const body = (await res.json()) as UsageResponse;
			setData(body);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setData(null);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	if (loading && !data) return <div className="mc-panel-empty">Loading usage data…</div>;
	if (error) return <div className="mc-panel-error">{error}</div>;
	if (!data) return <div className="mc-panel-empty">No usage data available.</div>;

	const maxModelCost = data.byModel.length > 0 ? Math.max(...data.byModel.map(b => b.cost)) : 1;
	const maxDayCost = data.byDay.length > 0 ? Math.max(...data.byDay.map(b => b.cost)) : 1;
	const recentDays = data.byDay.slice(-30);

	return (
		<div className="mc-usage-panel">
			<div className="mc-panel-head">
				<span className="mc-panel-title">Usage</span>
				<button type="button" className="sh-btn" onClick={refresh} disabled={loading}>
					↻ Refresh
				</button>
			</div>

			<section className="mc-usage-totals">
				<div className="mc-usage-stat">
					<span className="mc-usage-stat-label">Total cost</span>
					<span className="mc-usage-stat-value">{fmtCost(data.totals.cost)}</span>
				</div>
				<div className="mc-usage-stat">
					<span className="mc-usage-stat-label">Input</span>
					<span className="mc-usage-stat-value">{fmtNumber(data.totals.input)}</span>
				</div>
				<div className="mc-usage-stat">
					<span className="mc-usage-stat-label">Output</span>
					<span className="mc-usage-stat-value">{fmtNumber(data.totals.output)}</span>
				</div>
				<div className="mc-usage-stat">
					<span className="mc-usage-stat-label">Cache read</span>
					<span className="mc-usage-stat-value">{fmtNumber(data.totals.cacheRead)}</span>
				</div>
				<div className="mc-usage-stat">
					<span className="mc-usage-stat-label">Sessions</span>
					<span className="mc-usage-stat-value">{data.totals.sessions}</span>
				</div>
				<div className="mc-usage-stat">
					<span className="mc-usage-stat-label">Messages</span>
					<span className="mc-usage-stat-value">{data.totals.messages}</span>
				</div>
			</section>

			<section className="mc-usage-section">
				<h3 className="mc-usage-h">Top models by cost</h3>
				{data.byModel.length === 0 ? (
					<div className="mc-panel-empty">No model usage yet.</div>
				) : (
					<ul className="mc-usage-bars">
						{data.byModel.slice(0, 8).map(b => (
							<li key={b.key} className="mc-usage-bar-row">
								<span className="mc-usage-bar-label" title={b.label}>
									{b.label}
								</span>
								<div className="mc-usage-bar-track">
									<div
										className="mc-usage-bar-fill"
										style={{ width: `${Math.max(2, Math.round((b.cost / maxModelCost) * 100))}%` }}
									/>
								</div>
								<span className="mc-usage-bar-value">{fmtCost(b.cost)}</span>
							</li>
						))}
					</ul>
				)}
			</section>

			<section className="mc-usage-section">
				<h3 className="mc-usage-h">Recent days</h3>
				{recentDays.length === 0 ? (
					<div className="mc-panel-empty">No activity in the last 30 days.</div>
				) : (
					<ul className="mc-usage-bars">
						{recentDays.map(b => (
							<li key={b.key} className="mc-usage-bar-row">
								<span className="mc-usage-bar-label">{b.label}</span>
								<div className="mc-usage-bar-track">
									<div
										className="mc-usage-bar-fill"
										style={{ width: `${Math.max(2, Math.round((b.cost / maxDayCost) * 100))}%` }}
									/>
								</div>
								<span className="mc-usage-bar-value">{fmtCost(b.cost)}</span>
							</li>
						))}
					</ul>
				)}
			</section>

			<section className="mc-usage-section">
				<h3 className="mc-usage-h">Top sessions</h3>
				{data.topSessions.length === 0 ? (
					<div className="mc-panel-empty">No sessions yet.</div>
				) : (
					<ul className="mc-usage-sessions">
						{data.topSessions.map(b => (
							<li key={b.key} className="mc-usage-session-row" title={b.label}>
								<span className="mc-usage-session-name">{sessionLabel(b.label)}</span>
								<span className="mc-usage-session-cost">{fmtCost(b.cost)}</span>
							</li>
						))}
					</ul>
				)}
			</section>
		</div>
	);
}
