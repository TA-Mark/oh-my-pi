/**
 * LauncherPage — Desktop WebUI wrapper launcher screen.
 * Gates entry to Main Chat: only allows entry when service is running_healthy.
 * Orchestrates: start/stop/restart, workspace, update, diagnostics, log stream.
 * Never imports oh-my-pi core.
 */

import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type DetectOmpResult, detectOmp } from "../../installer/api/installerApi";
import {
	activateWorkspace,
	applyUpdate,
	checkUpdate,
	getRuntimeStatus,
	listWorkspaces,
	repairInstall,
	resetCache,
	restartService,
	runDiagnostics,
	startSafeMode,
	startService,
	stopService,
	subscribeToLauncherStream,
} from "../api/launcherApi";
import { DiagnosticsCard } from "../components/DiagnosticsCard";
import { LaunchControlCard } from "../components/LaunchControlCard";
import { LauncherLogDrawer } from "../components/LauncherLogDrawer";
import { RuntimeStatusCard } from "../components/RuntimeStatusCard";
import { UpdateMaintenanceCard } from "../components/UpdateMaintenanceCard";
import { WorkspaceCard } from "../components/WorkspaceCard";
import { useServiceStateMachine } from "../hooks/useServiceStateMachine";
import type { LauncherStreamEvent, UpdateChannel } from "../types/launcher";
import "../components/launcher.css";

interface Props {
	/** Called when user clicks "Enter Main Chat" (only enabled when running_healthy) */
	onEnterChat(): void;
	/** Called if user wants to go back to installer */
	onBackToInstaller(): void;
}

const POLL_INTERVAL_MS = 8000;

export function LauncherPage({ onEnterChat, onBackToInstaller }: Props): ReactNode {
	const [state, actions] = useServiceStateMachine();
	const streamRef = useRef<{ close(): void } | null>(null);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	// Whether omp is detected on this machine. `null` = not checked yet.
	// `{found: false}` = render the recovery card instead of the dashboard.
	const [detect, setDetect] = useState<DetectOmpResult | null>(null);
	const [detectChecking, setDetectChecking] = useState(false);

	const recheckOmp = useCallback(async () => {
		setDetectChecking(true);
		try {
			const r = await detectOmp();
			setDetect(r);
		} catch {
			setDetect({ found: false, path: null, version: null, source: null, candidatesTried: [] });
		} finally {
			setDetectChecking(false);
		}
	}, []);

	// ---------------------------------------------------------------------------
	// Bootstrap: detect omp first, then fetch status + workspaces
	// ---------------------------------------------------------------------------
	useEffect(() => {
		let mounted = true;

		async function bootstrap(): Promise<void> {
			// Gate: if omp is missing, we render a recovery card and skip the
			// rest of the dashboard wiring. Re-check happens on user action.
			try {
				const r = await detectOmp();
				if (!mounted) return;
				setDetect(r);
				if (!r.found) return;
			} catch {
				if (mounted) setDetect({ found: false, path: null, version: null, source: null, candidatesTried: [] });
				return;
			}

			try {
				const status = await getRuntimeStatus();
				if (!mounted) return;

				if (status.phase === "running_healthy") {
					actions.running(status.endpoint ?? "", status.version, status.lastStartedAt ?? new Date().toISOString());
				} else if (status.phase === "running_degraded") {
					actions.degraded(status.endpoint ?? "", status.error ?? "Degraded");
				} else if (status.phase === "error") {
					actions.error({ code: "RUNTIME_ERROR", message: status.error ?? "Unknown error" });
				} else if (status.phase === "starting") {
					actions.starting();
				}

				if (status.metrics) actions.metrics(status.metrics);
			} catch {
				// bridge not reachable — stay in stopped state
			}

			// Load workspaces
			try {
				const ws = await listWorkspaces();
				if (mounted) actions.workspacesLoaded(ws.workspaces);
			} catch {
				/* not critical */
			}
		}

		bootstrap();

		// WS stream for live status + logs + metrics
		const sub = subscribeToLauncherStream(
			(event: LauncherStreamEvent) => {
				if (!mounted) return;
				if (event.type === "log") {
					actions.appendLog(event.line);
				} else if (event.type === "status_change") {
					if (event.phase === "running_healthy") {
						actions.running("", "", new Date().toISOString());
					} else if (event.phase === "running_degraded") {
						actions.degraded("", "Service degraded");
					} else if (event.phase === "stopped") {
						actions.stopped();
					} else if (event.phase === "error") {
						actions.error({ code: "RUNTIME_ERROR", message: "Service error" });
					} else if (event.phase === "updating") {
						actions.updating();
					}
				} else if (event.type === "metrics") {
					actions.metrics(event.metrics);
				} else if (event.type === "health") {
					actions.healthChange(event.healthy);
				}
			},
			() => {
				/* WS error — fall back to polling below */
			},
		);
		streamRef.current = sub;

		// Polling fallback for status
		pollRef.current = setInterval(async () => {
			if (!mounted) return;
			try {
				const status = await getRuntimeStatus();
				if (status.metrics) actions.metrics(status.metrics);
				if (status.healthy !== state.healthy) actions.healthChange(status.healthy);
			} catch {
				/* ignore poll errors */
			}
		}, POLL_INTERVAL_MS);

		return () => {
			mounted = false;
			sub.close();
			if (pollRef.current) clearInterval(pollRef.current);
		};
	}, []); // eslint-disable-line react-hooks/exhaustive-deps

	// ---------------------------------------------------------------------------
	// Handlers
	// ---------------------------------------------------------------------------

	const handleStart = useCallback(async () => {
		actions.starting();
		try {
			await startService();
		} catch (err) {
			const e = err as { message?: string };
			actions.error({ code: "START_FAILED", message: e.message ?? "Failed to start service" });
		}
	}, [actions]);

	const handleStop = useCallback(async () => {
		actions.stopping();
		try {
			await stopService();
			actions.stopped();
		} catch (err) {
			const e = err as { message?: string };
			actions.error({ code: "STOP_FAILED", message: e.message ?? "Failed to stop service" });
		}
	}, [actions]);

	const handleRestart = useCallback(async () => {
		actions.stopping();
		try {
			await restartService();
			actions.starting();
		} catch (err) {
			const e = err as { message?: string };
			actions.error({ code: "RESTART_FAILED", message: e.message ?? "Failed to restart service" });
		}
	}, [actions]);

	const handleSafeMode = useCallback(async () => {
		actions.starting();
		try {
			await startSafeMode();
		} catch (err) {
			const e = err as { message?: string };
			actions.error({ code: "SAFE_MODE_FAILED", message: e.message ?? "Failed to start safe mode" });
		}
	}, [actions]);

	const handleCheckUpdate = useCallback(async () => {
		actions.updateCheckStart();
		try {
			const info = await checkUpdate();
			actions.updateCheckDone(info);
		} catch {
			actions.updateCheckDone({
				available: false,
				currentVersion: "?",
				latestVersion: null,
				channel: "stable",
				releaseNotes: null,
				checkedAt: new Date().toISOString(),
			});
		}
	}, [actions]);

	const handleApplyUpdate = useCallback(
		async (channel: UpdateChannel) => {
			actions.updating();
			try {
				await applyUpdate(channel);
				actions.updateDone();
			} catch (err) {
				const e = err as { message?: string };
				actions.error({ code: "UPDATE_FAILED", message: e.message ?? "Update failed" });
			}
		},
		[actions],
	);

	const handleRepair = useCallback(async () => {
		try {
			await repairInstall();
		} catch {
			/* best-effort */
		}
	}, []);

	const handleResetCache = useCallback(async () => {
		try {
			await resetCache();
		} catch {
			/* best-effort */
		}
	}, []);

	const handleActivateWorkspace = useCallback(
		async (id: string) => {
			try {
				await activateWorkspace(id);
				actions.workspaceActivated(id);
			} catch {
				/* ignore */
			}
		},
		[actions],
	);

	const handleRunDiag = useCallback(async () => {
		actions.diagStart();
		try {
			const result = await runDiagnostics();
			actions.diagDone(result.checks);
		} catch {
			actions.diagDone([
				{ id: "err", label: "Diagnostics failed", status: "fail", detail: "Could not reach bridge" },
			]);
		}
	}, [actions]);

	// ---------------------------------------------------------------------------
	// omp-missing recovery card. Rendered BEFORE the dashboard so the user is
	// never invited to "Enter chat" without an installed omp behind it.
	// ---------------------------------------------------------------------------
	if (detect && !detect.found) {
		return (
			<div className="lnc-page">
				<div className="lnc-topbar">
					<div className="lnc-topbar-left">
						<div className="lnc-lockup">
							<div className="lnc-lockup-mark" />
							oh-my-pi
						</div>
					</div>
				</div>
				<div className="lnc-body" style={{ display: "flex", justifyContent: "center", padding: 32 }}>
					<div className="lnc-card" style={{ maxWidth: 560, textAlign: "left" }}>
						<div className="lnc-error-title" style={{ fontSize: 16, marginBottom: 8 }}>
							⚠ omp not detected
						</div>
						<div className="lnc-error-detail">
							The launcher needs omp installed on this machine. We searched <code>$PATH</code> and the standard
							install locations (Bun global, %LOCALAPPDATA%\omp, Homebrew, mise shims, …) and didn't find it.
						</div>
						{detect.candidatesTried.length > 0 && (
							<details style={{ marginTop: 8 }}>
								<summary style={{ cursor: "pointer", fontSize: 11, color: "var(--fg-faint)" }}>
									Locations tried ({detect.candidatesTried.length})
								</summary>
								<ul style={{ fontFamily: "var(--font-mono)", fontSize: 11, marginTop: 6, paddingLeft: 16 }}>
									{detect.candidatesTried.map(c => (
										<li key={c}>{c}</li>
									))}
								</ul>
							</details>
						)}
						<div style={{ display: "flex", gap: 8, marginTop: 16 }}>
							<button type="button" className="lnc-btn lnc-btn-primary" onClick={onBackToInstaller}>
								← Re-run installer
							</button>
							<button type="button" className="lnc-btn" onClick={recheckOmp} disabled={detectChecking}>
								{detectChecking ? "Re-checking…" : "Re-check"}
							</button>
						</div>
					</div>
				</div>
			</div>
		);
	}

	// ---------------------------------------------------------------------------
	// Enter Chat gate
	// ---------------------------------------------------------------------------
	const canEnterChat = state.phase === "running_healthy";
	const canEnterWithWarning = state.phase === "running_degraded";

	return (
		<div className="lnc-page">
			{/* Top bar */}
			<div className="lnc-topbar">
				<div className="lnc-topbar-left">
					<div className="lnc-lockup">
						<div className="lnc-lockup-mark" />
						oh-my-pi
					</div>
					{state.version && <span className="lnc-version-chip">{state.version}</span>}
					{state.updateInfo?.available && (
						<span style={{ fontSize: 11, color: "var(--accent)" }}>↑ Update available</span>
					)}
				</div>
				<div className="lnc-topbar-right">
					<button className="lnc-btn" onClick={actions.toggleLogs} style={{ fontSize: 11 }}>
						{state.logsOpen ? "✕ Logs" : "📋 Logs"}
						{state.logs.length > 0 && (
							<span
								style={{
									marginLeft: 4,
									background: "var(--accent)",
									color: "var(--accent-fg)",
									borderRadius: 8,
									padding: "0 5px",
									fontSize: 9,
									fontWeight: 600,
								}}
							>
								{state.logs.length > 99 ? "99+" : state.logs.length}
							</span>
						)}
					</button>
					<button className="lnc-btn" onClick={onBackToInstaller} style={{ fontSize: 11 }}>
						← Installer
					</button>
				</div>
			</div>

			{/* Body: 2-col grid */}
			<div className="lnc-body">
				{/* Row 1 */}
				<RuntimeStatusCard
					phase={state.phase}
					endpoint={state.endpoint}
					healthy={state.healthy}
					version={state.version}
					lastStartedAt={state.lastStartedAt}
					metrics={state.metrics}
				/>

				<LaunchControlCard
					phase={state.phase}
					onStart={handleStart}
					onStop={handleStop}
					onRestart={handleRestart}
					onSafeMode={handleSafeMode}
				/>

				{/* Row 2 */}
				<WorkspaceCard
					workspaces={state.workspaces}
					activeId={state.activeWorkspaceId}
					onActivate={handleActivateWorkspace}
				/>

				<UpdateMaintenanceCard
					updateInfo={state.updateInfo}
					updateChecking={state.updateChecking}
					updating={state.updating}
					onCheckUpdate={handleCheckUpdate}
					onApplyUpdate={handleApplyUpdate}
					onRepair={handleRepair}
					onResetCache={handleResetCache}
				/>

				{/* Row 3 — full width */}
				<DiagnosticsCard checks={state.diagChecks} running={state.diagRunning} onRunDiag={handleRunDiag} />

				{/* Error card — full width */}
				{state.error && (
					<div className="lnc-card lnc-error-card lnc-card-span">
						<div className="lnc-error-title">{state.error.code}</div>
						<div className="lnc-error-detail">{state.error.message}</div>
						{state.error.detail && (
							<div className="lnc-error-detail" style={{ opacity: 0.7 }}>
								{state.error.detail}
							</div>
						)}
						<div style={{ display: "flex", gap: 8, marginTop: 4 }}>
							<button className="lnc-btn" onClick={actions.clearError}>
								Dismiss
							</button>
							<button className="lnc-btn" onClick={handleStart}>
								Retry Start
							</button>
							<button className="lnc-btn" onClick={handleSafeMode}>
								Safe Mode
							</button>
						</div>
					</div>
				)}
			</div>

			{/* Footer — Enter Chat CTA */}
			<div className="lnc-footer">
				<div className="lnc-enter-chat-hint">
					{canEnterChat && "Service is healthy — ready to enter chat."}
					{canEnterWithWarning && "⚠ Service is degraded — entering chat may be unstable."}
					{!canEnterChat && !canEnterWithWarning && "Start the service to enter chat."}
				</div>

				<div className="lnc-enter-chat">
					{canEnterWithWarning && (
						<button
							className="lnc-btn lnc-btn-large"
							onClick={onEnterChat}
							style={{ color: "var(--warn)", borderColor: "var(--warn)" }}
						>
							Enter Chat (degraded) →
						</button>
					)}

					<button className="lnc-btn lnc-btn-primary lnc-btn-large" onClick={onEnterChat} disabled={!canEnterChat}>
						Enter Main Chat →
					</button>
				</div>
			</div>

			{/* Log drawer */}
			<LauncherLogDrawer
				logs={state.logs}
				open={state.logsOpen}
				onClose={actions.toggleLogs}
				onClear={actions.clearLogs}
			/>
		</div>
	);
}
