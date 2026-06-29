import type { ReactNode } from "react";
import type { ConnectionPhase } from "../../../lib/client";
import type { LauncherHealthStatus } from "../types/chat";

interface Props {
	phase: ConnectionPhase;
	health: LauncherHealthStatus | null;
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

export function ConnectionStatusBar({ phase, health, onReconnect, onGoToLauncher }: Props): ReactNode {
	const isUnhealthy = health !== null && !health.healthy;

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
