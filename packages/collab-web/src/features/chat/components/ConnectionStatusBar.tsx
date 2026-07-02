import type { ReactNode } from "react";
import type { ConnectionPhase, StatusEntry } from "../../../lib/client";
import type { LauncherHealthStatus } from "../types/chat";

interface Props {
	phase: ConnectionPhase;
	health: LauncherHealthStatus | null;
	statusEntries?: readonly StatusEntry[];
	isCompacting?: boolean;
	planModeActive?: boolean;
	onReconnect(): void;
	onGoToLauncher(): void;
}

const PHASE_LABELS: Record<ConnectionPhase, string> = {
	connecting: "Connecting…",
	waiting: "Waiting for session…",
	live: "Connected",
	reconnecting: "Reconnecting…",
	ended: "Session ended",
};

export function ConnectionStatusBar({ phase, health, statusEntries, isCompacting, planModeActive, onReconnect, onGoToLauncher }: Props): ReactNode {
	// "installing" is a benign transient — runtime is being staged on first
	// boot. Show a calm blue banner with progress instead of the red error.
	const isInstalling = health?.phase === "installing" || (health?.installProgress != null && !health.installProgress.message.includes("ready"));
	const isUnhealthy = health !== null && !health.healthy && !isInstalling;

	const modeBanners: string[] = [];
	if (planModeActive) modeBanners.push("PLAN MODE");
	if (isCompacting) modeBanners.push("COMPACTING");
	if (statusEntries) {
		for (const entry of statusEntries) {
			if (entry.text) modeBanners.push(entry.text);
		}
	}

	return (
		<>
			{/* Installer progress (first boot) — blue, non-blocking */}
			{isInstalling && health?.installProgress && (
				<div className="mc-launcher-installing">
					<div className="mc-launcher-installing-head">
						<span className="mc-spinner" aria-hidden="true" />
						<span>{health.installProgress.message}</span>
						<span className="mc-launcher-installing-pct">{Math.round(health.installProgress.percent)}%</span>
					</div>
					<div className="mc-launcher-installing-bar">
						<div className="mc-launcher-installing-fill" style={{ width: `${Math.max(2, Math.min(100, health.installProgress.percent))}%` }} />
					</div>
					{health.installProgress.logTail && health.installProgress.logTail.length > 0 && (
						<div className="mc-launcher-installing-log">
							{health.installProgress.logTail.slice(-4).map((line, i) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: log tail is ordered + ephemeral
								<div key={i} className="mc-launcher-installing-log-line">{line}</div>
							))}
						</div>
					)}
				</div>
			)}

			{/* Launcher health warning (only after install failed / unrelated outage) */}
			{isUnhealthy && (
				<div className="mc-launcher-warn">
					⚠ Runtime service is {health!.phase} — chat may be unavailable.
					<button className="mc-launcher-warn-action" type="button" onClick={onGoToLauncher}>
						Go to Launcher →
					</button>
				</div>
			)}

			{/* Mode banners */}
			{modeBanners.length > 0 && (
				<div className="mc-conn-bar" style={{ background: "var(--accent)", color: "var(--bg)", fontWeight: 600, fontSize: 11, letterSpacing: "0.05em" }}>
					{modeBanners.join(" · ")}
				</div>
			)}

			{/* WS connection bar */}
			<div className="mc-conn-bar">
				<span className="mc-conn-dot" data-phase={phase} />
				<span className="mc-conn-label">{PHASE_LABELS[phase]}</span>

				{health !== null && !isInstalling && (
					<span className="mc-conn-health-badge" data-healthy={health.healthy ? "true" : "false"}>
						{health.healthy ? "Runtime OK" : "Runtime ⚠"}
					</span>
				)}
				{isInstalling && (
					<span className="mc-conn-health-badge" data-healthy="installing">
						Installing runtime…
					</span>
				)}

				{(phase === "ended" || phase === "reconnecting") && (
					<button className="mc-conn-reconnect-btn" type="button" onClick={onReconnect}>
						Reconnect
					</button>
				)}
			</div>
		</>
	);
}
