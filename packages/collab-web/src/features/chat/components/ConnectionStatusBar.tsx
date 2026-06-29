import type { ReactNode } from "react";
import type { ConnectionPhase, StatusEntry } from "../../../lib/client";
import type { LauncherHealthStatus } from "../types/chat";

interface Props {
	phase: ConnectionPhase;
	health: LauncherHealthStatus | null;
	statusEntries?: readonly StatusEntry[];
	isCompacting?: boolean;
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

export function ConnectionStatusBar({ phase, health, statusEntries, isCompacting, onReconnect, onGoToLauncher }: Props): ReactNode {
	const isUnhealthy = health !== null && !health.healthy;

	const modeBanners: string[] = [];
	if (isCompacting) modeBanners.push("COMPACTING");
	if (statusEntries) {
		for (const entry of statusEntries) {
			if (entry.text) modeBanners.push(entry.text);
		}
	}

	return (
		<>
			{/* Launcher health warning */}
			{isUnhealthy && (
				<div className="mc-launcher-warn">
					⚠ Runtime service is {health!.phase} — chat may be unavailable.
					<button className="mc-launcher-warn-action" onClick={onGoToLauncher}>
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

				{health !== null && (
					<span className="mc-conn-health-badge" data-healthy={health.healthy ? "true" : "false"}>
						{health.healthy ? "Runtime OK" : "Runtime ⚠"}
					</span>
				)}

				{(phase === "ended" || phase === "reconnecting") && (
					<button className="mc-conn-reconnect-btn" onClick={onReconnect}>
						Reconnect
					</button>
				)}
			</div>
		</>
	);
}
