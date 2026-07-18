import { Bug, Download, RefreshCw, X } from "lucide-react";
import type { DiagnosticsSnapshot } from "../lib/desktop-bridge";
import type { SessionStats } from "../lib/rpc-protocol";

interface DiagnosticsPanelProps {
	open: boolean;
	snapshot: DiagnosticsSnapshot | null;
	sessionStats: SessionStats | null;
	loading: boolean;
	onRefresh: () => void;
	onExport: () => void;
	onClose: () => void;
}

export function DiagnosticsPanel({
	open,
	snapshot,
	sessionStats,
	loading,
	onRefresh,
	onExport,
	onClose,
}: DiagnosticsPanelProps) {
	if (!open) return null;
	return (
		<div className="settings-layer">
			<button type="button" className="settings-backdrop" aria-label="Close diagnostics" onClick={onClose} />
			<section className="settings-panel diagnostics-panel" role="dialog" aria-modal="true" aria-label="Diagnostics">
				<header className="settings-panel-head">
					<span>
						<Bug size={17} /> Diagnostics
					</span>
					<div>
						<button
							type="button"
							className="top-icon-button"
							onClick={onRefresh}
							disabled={loading}
							aria-label="Refresh diagnostics"
						>
							<RefreshCw size={16} />
						</button>
						<button
							type="button"
							className="top-icon-button"
							onClick={onExport}
							disabled={!snapshot || loading}
							aria-label="Export diagnostics bundle"
						>
							<Download size={16} />
						</button>
						<button type="button" className="top-icon-button" onClick={onClose} aria-label="Close diagnostics">
							<X size={16} />
						</button>
					</div>
				</header>
				<div className="diagnostics-content">
					{loading ? <p>Collecting redacted diagnostics…</p> : null}
					{snapshot ? (
						<>
							<div className="diagnostics-summary">
								<span>OMP Desktop {snapshot.appVersion}</span>
								<span>
									{snapshot.platform}/{snapshot.arch}
								</span>
								<span>Engine: {snapshot.engineRunning ? "running" : "stopped"}</span>
								<span>Protocol: {snapshot.protocolVersion ?? "unknown"}</span>
								{sessionStats ? (
									<span>
										Messages: {sessionStats.totalMessages} · Tools: {sessionStats.toolCalls}
									</span>
								) : null}
								{sessionStats ? <span>Tokens: {sessionStats.tokens.total.toLocaleString()}</span> : null}
							</div>
							<pre>{snapshot.logTail || "No Electron log entries."}</pre>
						</>
					) : !loading ? (
						<p>No diagnostics collected yet.</p>
					) : null}
				</div>
			</section>
		</div>
	);
}
