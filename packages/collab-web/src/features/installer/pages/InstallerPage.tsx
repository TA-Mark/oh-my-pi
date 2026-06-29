/**
 * InstallerPage — Desktop WebUI wrapper installer screen.
 * Orchestrates: method discovery → preflight → install → success.
 * Never imports oh-my-pi core. All system ops go through installerApi.
 */

import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	cancelInstall,
	detectOmp,
	getInstallMethods,
	repairInstall,
	runPreflight,
	startInstall,
	subscribeToJobStream,
} from "../api/installerApi";
import { InstallChoicesCard } from "../components/InstallChoicesCard";
import { InstallerActionBar } from "../components/InstallerActionBar";
import { InstallProgressCard } from "../components/InstallProgressCard";
import { PreflightChecklistCard } from "../components/PreflightChecklistCard";
import { SourceSetupCard } from "../components/SourceSetupCard";
import { useInstallerStateMachine } from "../hooks/useInstallerStateMachine";
import type { InstallerError, InstallMethodId, StreamEvent } from "../types/installer";
import "../components/installer.css";

interface Props {
	/** Called when install succeeds and user clicks "Open Launcher" */
	onInstallerDone(): void;
}

function formatElapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function InstallerPage({ onInstallerDone }: Props): ReactNode {
	const [state, actions] = useInstallerStateMachine();
	const streamRef = useRef<{ close(): void } | null>(null);
	const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const startTsRef = useRef<number>(0);
	const [methodsError, setMethodsError] = useState<string | null>(null);

	// Fetch install methods on mount.
	useEffect(() => {
		let cancelled = false;
		getInstallMethods()
			.then(res => {
				if (!cancelled) {
					actions.setMethods(res);
					setMethodsError(null);
				}
			})
			.catch((err: unknown) => {
				if (!cancelled) {
					const msg = err instanceof Error ? err.message : String(err);
					setMethodsError(`Could not fetch install methods: ${msg}`);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [actions]);

	// Elapsed timer
	useEffect(() => {
		if (state.phase === "checking" || state.phase === "installing") {
			startTsRef.current = Date.now() - state.elapsedMs;
			timerRef.current = setInterval(() => {
				actions.tick(Date.now() - startTsRef.current);
			}, 1000);
		} else {
			if (timerRef.current) {
				clearInterval(timerRef.current);
				timerRef.current = null;
			}
		}
		return () => {
			if (timerRef.current) clearInterval(timerRef.current);
		};
	}, [state.phase]); // eslint-disable-line react-hooks/exhaustive-deps

	// Cleanup WS on unmount
	useEffect(() => {
		return () => {
			streamRef.current?.close();
		};
	}, []);

	// --- handlers ---

	const handleStartChecks = useCallback(async () => {
		actions.startChecking();
		try {
			// Seed placeholder checks immediately for visual feedback
			const placeholders = [
				{ id: "net", label: "Network reachable (omp.sh)", status: "running" as const },
				{ id: "perm", label: "Write permission", status: "running" as const },
			];
			for (const c of placeholders) actions.updateCheck(c);

			const result = await runPreflight({
				installPath: state.installPath,
				method: state.selectedMethod ?? undefined,
			});
			actions.checksDone(result.allPassed, result.checks);
		} catch (err) {
			const e = err as InstallerError & { message?: string };
			actions.checksDone(false, [
				{
					id: "bridge",
					label: "Desktop bridge connection",
					status: "fail",
					detail: e.message ?? "Could not reach desktop bridge",
					fixHint: "Make sure the oh-my-pi desktop bridge is running on port 8787.",
				},
			]);
		}
	}, [state.installPath, state.selectedMethod, actions]);

	/**
	 * Wire a job's WS lifecycle into the state machine. Used by both fresh
	 * installs and repair runs so we don't duplicate the success/failed
	 * routing in two places.
	 */
	const subscribeJobLifecycle = useCallback(
		(jobId: string) => {
			const sub = subscribeToJobStream(
				jobId,
				(event: StreamEvent) => {
					if (event.type === "log") {
						actions.appendLog(event.line);
					} else if (event.type === "phase_change") {
						if (event.phase === "success") {
							sub.close();
							actions.installSuccess();
							// Resolve where omp actually landed — most methods ignore
							// installPath, so we ask the bridge to do `where omp` +
							// known-location lookup and report the real path back.
							detectOmp()
								.then(r => {
									if (r.found && r.path) actions.setInstalledPath(r.path);
								})
								.catch(() => {
									/* best-effort: success card will fall back to installPath */
								});
						} else if (event.phase === "failed") {
							sub.close();
							actions.installFailed({
								code: "INSTALL_FAILED",
								message: "Installation failed. Check logs for details.",
								actions: [
									{ label: "Retry", action: "retry" },
									{ label: "View Logs", action: "logs" },
								],
							});
						}
					}
				},
				(err: Error) => {
					actions.installFailed({
						code: "STREAM_ERROR",
						message: err.message,
						actions: [{ label: "Retry", action: "retry" }],
					});
				},
			);
			streamRef.current = sub;
		},
		[actions],
	);

	const handleInstall = useCallback(async () => {
		try {
			// installPath is only meaningful for the Windows Binary path. Omit
			// it for every other method so the backend cannot mistake the
			// textbox for a directive when the official installer ignores it.
			const isBinary = state.selectedMethod === "windows-irm";
			const job = await startInstall({
				method: state.selectedMethod ?? undefined,
				...(isBinary && state.installPath ? { installPath: state.installPath } : {}),
			});
			actions.startInstalling(job.jobId, job.logFile ?? null);
			subscribeJobLifecycle(job.jobId);
		} catch (err) {
			const e = err as InstallerError & { message?: string };
			actions.installFailed({
				code: (e as { code?: string }).code ?? "START_FAILED",
				message: e.message ?? "Failed to start installation.",
				actions: [{ label: "Retry", action: "retry" }],
			});
		}
	}, [state.installPath, state.selectedMethod, actions, subscribeJobLifecycle]);

	const handleCancel = useCallback(async () => {
		streamRef.current?.close();
		streamRef.current = null;
		if (state.jobId) {
			await cancelInstall(state.jobId).catch(() => {
				/* best-effort */
			});
		}
		actions.cancel();
	}, [state.jobId, actions]);

	const handleRetry = useCallback(async () => {
		streamRef.current?.close();
		streamRef.current = null;
		// If a prior job failed and the bridge still remembers its params,
		// ask for a `--force` rerun; otherwise reset to idle so the user can
		// pick the method again.
		if (state.jobId && state.phase === "failed") {
			try {
				const next = await repairInstall(state.jobId);
				actions.startInstalling(next.jobId, next.logFile ?? null);
				subscribeJobLifecycle(next.jobId);
				return;
			} catch {
				/* fall through to soft reset */
			}
		}
		actions.retry();
	}, [state.jobId, state.phase, actions, subscribeJobLifecycle]);

	const handleSelectMethod = useCallback(
		(id: InstallMethodId) => {
			actions.selectMethod(id);
		},
		[actions],
	);

	const phaseLabel: Record<string, string> = {
		idle: "Ready",
		checking: "Checking…",
		check_fail: "Check failed",
		ready: "Ready to install",
		installing: "Installing…",
		success: "Installation complete",
		failed: "Installation failed",
		cancelled: "Cancelled",
	};

	return (
		<div className="ins-page">
			{/* Top bar */}
			<div className="ins-topbar">
				<div className="ins-topbar-left">
					<div className="ins-lockup">
						<div className="ins-lockup-mark" />
						oh-my-pi installer
					</div>
					<span className="ins-env-badge">Stable</span>
				</div>
				<div className="ins-topbar-right">
					<span style={{ fontSize: 11, color: "var(--fg-faint)" }}>
						{state.methods ? state.methods.platform : "…"}
					</span>
				</div>
			</div>

			{/* Body */}
			<div className="ins-body">
				<div className="ins-main">
					{/* Success screen */}
					{state.phase === "success" ? (
						<div className="ins-card">
							<div className="ins-success">
								<div className="ins-success-icon">✓</div>
								<div className="ins-success-title">Installation Complete</div>
								<div className="ins-success-sub">
									{state.installedPath ? (
										<>
											omp resolved at{" "}
											<code style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
												{state.installedPath}
											</code>
										</>
									) : (
										<>
											Locating omp on this machine…{" "}
											<code style={{ fontFamily: "var(--font-mono)", fontSize: 12, opacity: 0.6 }}>
												{state.installPath}
											</code>
										</>
									)}
								</div>
							</div>
						</div>
					) : (
						<>
							<SourceSetupCard
								installPath={state.installPath}
								phase={state.phase}
								selectedMethod={state.selectedMethod}
								methodDef={
									state.methods?.methods.find(
										m => m.id === (state.selectedMethod ?? state.methods?.recommended),
									) ?? null
								}
								onInstallPathChange={actions.setInstallPath}
							/>

							{/* Method picker — shown once methods are fetched */}
							{state.methods ? (
								<InstallChoicesCard
									methods={state.methods}
									installPath={state.installPath}
									busy={state.phase === "installing" || state.phase === "checking"}
									selectedId={state.selectedMethod}
									onSelect={handleSelectMethod}
									onInstall={handleInstall}
								/>
							) : methodsError ? (
								<div className="ins-card ins-error-card">
									<div className="ins-error-title">Could not load install methods</div>
									<div className="ins-error-detail">{methodsError}</div>
								</div>
							) : (
								<div className="ins-card">
									<div className="ins-card-title">Loading install methods…</div>
								</div>
							)}

							<PreflightChecklistCard checks={state.checks} running={state.phase === "checking"} />

							{(state.phase === "installing" || state.phase === "failed") && (
								<InstallProgressCard
									steps={state.steps}
									logs={state.logs}
									progress={state.progress}
									currentStep={state.currentStep}
									failed={state.phase === "failed"}
									logFile={state.logFile}
								/>
							)}

							{/* Error card */}
							{state.error && (
								<div className="ins-card ins-error-card">
									<div className="ins-error-title">Error: {state.error.code}</div>
									<div className="ins-error-detail">{state.error.message}</div>
									{state.error.detail && (
										<div className="ins-error-detail" style={{ opacity: 0.75 }}>
											{state.error.detail}
										</div>
									)}
								</div>
							)}
						</>
					)}

					{/* Action bar */}
					<InstallerActionBar
						phase={state.phase}
						onStartChecks={handleStartChecks}
						onInstall={handleInstall}
						onCancel={handleCancel}
						onRetry={handleRetry}
						onOpenLauncher={onInstallerDone}
					/>
				</div>

				{/* Help panel */}
				<aside className="ins-help">
					<div className="ins-help-section">
						<div className="ins-help-title">What this does</div>
						<div className="ins-help-text">
							Runs the official omp.sh installer — the exact same one-liner you would paste into a terminal. No
							wrapper script in between, no repo clone. Your machine ends up in the same state as a manual
							install.
						</div>
					</div>
					<div className="ins-help-section">
						<div className="ins-help-title">Security</div>
						<div className="ins-help-text">
							Only the official omp.sh installer endpoint is contacted. The bridge never holds any GitHub tokens
							or credentials.
						</div>
					</div>
					<div className="ins-help-section">
						<div className="ins-help-title">Requirements</div>
						<div className="ins-help-text">
							Internet connection, write access to the install path. Method-specific requirements are listed
							under each option above.
						</div>
					</div>
					<div className="ins-help-section">
						<div className="ins-help-title">Troubleshooting</div>
						<a
							className="ins-help-link"
							href="https://github.com/can1357/oh-my-pi"
							target="_blank"
							rel="noreferrer"
						>
							omp.sh docs ↗
						</a>
					</div>
				</aside>
			</div>

			{/* Status bar */}
			<div className="ins-statusbar">
				<span>{phaseLabel[state.phase] ?? state.phase}</span>
				{state.elapsedMs > 0 && <span>Elapsed: {formatElapsed(state.elapsedMs)}</span>}
			</div>
		</div>
	);
}
