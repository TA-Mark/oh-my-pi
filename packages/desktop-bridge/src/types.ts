/**
 * Wire types — must match the contracts in
 * `packages/collab-web/src/features/{installer,launcher,chat}/types/*.ts`.
 *
 * Kept local so the bridge has no dependency on the React package.
 */

// ─── Installer ──────────────────────────────────────────────────────────────

export type InstallerPhase =
	| "idle"
	| "checking"
	| "check_fail"
	| "ready"
	| "installing"
	| "success"
	| "failed"
	| "cancelled";

export type CheckStatus = "pending" | "running" | "pass" | "fail" | "warn";

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface PreflightCheck {
	id: string;
	label: string;
	status: CheckStatus;
	detail?: string;
	fixHint?: string;
}

export interface PreflightResponse {
	checks: PreflightCheck[];
	allPassed: boolean;
	hasWarnings: boolean;
}

export interface InstallRequest {
	repoUrl: string;
	branch: string;
	installPath: string;
	windowsInstallPath?: string;
}

export interface InstallStep {
	id: string;
	label: string;
	status: CheckStatus;
	startedAt?: string;
	completedAt?: string;
}

export interface InstallerError {
	code: string;
	message: string;
	detail?: string;
	actions?: Array<{ label: string; action: "retry" | "repair" | "cancel" | "logs" }>;
}

export interface InstallStatusResponse {
	jobId: string;
	phase: InstallerPhase;
	progress: number;
	currentStep: string;
	steps: InstallStep[];
	error?: InstallerError;
}

export interface LogLine {
	ts: string;
	level: LogLevel;
	message: string;
	raw?: string;
	source?: string;
}

export type InstallerStreamEvent =
	| { type: "log"; jobId: string; line: LogLine }
	| { type: "phase_change"; jobId: string; phase: InstallerPhase; progress: number };

// ─── Launcher ───────────────────────────────────────────────────────────────

export type ServiceStatus = "stopped" | "starting" | "running" | "degraded" | "error" | "updating";

export type LauncherPhase =
	| "stopped"
	| "starting"
	| "running_healthy"
	| "running_degraded"
	| "error"
	| "updating"
	| "stopping";

export interface ResourceMetrics {
	cpuPct: number;
	memMb: number;
	uptimeMs: number;
}

export interface RuntimeStatusResponse {
	status: ServiceStatus;
	phase: LauncherPhase;
	endpoint: string | null;
	healthy: boolean;
	lastStartedAt: string | null;
	metrics: ResourceMetrics | null;
	version: string;
	error: string | null;
}

export type UpdateChannel = "stable" | "beta" | "nightly";

export interface UpdateInfo {
	available: boolean;
	currentVersion: string;
	latestVersion: string | null;
	channel: UpdateChannel;
	releaseNotes: string | null;
	checkedAt: string;
}

export interface WorkspaceProfile {
	id: string;
	name: string;
	path: string;
	lastOpenedAt: string | null;
	isActive: boolean;
}

export type DiagCheckStatus = "ok" | "warn" | "fail" | "running";

export interface DiagCheck {
	id: string;
	label: string;
	status: DiagCheckStatus;
	detail?: string;
	fixHint?: string;
}

export interface DiagnosticsResponse {
	overallStatus: "ok" | "warn" | "fail";
	checks: DiagCheck[];
	runAt: string;
}

export type LauncherStreamEvent =
	| { type: "log"; line: LogLine }
	| { type: "status_change"; status: ServiceStatus; phase: LauncherPhase }
	| { type: "metrics"; metrics: ResourceMetrics }
	| { type: "health"; healthy: boolean; error?: string };

// ─── Chat ───────────────────────────────────────────────────────────────────

export interface ChatSession {
	id: string;
	name: string;
	link: string;
	createdAt: string;
	lastActiveAt: string | null;
	messageCount: number;
	isActive: boolean;
}

export type DataSourceStatus = "connected" | "disconnected" | "error" | "loading";

export interface DataSource {
	id: string;
	name: string;
	type: string;
	status: DataSourceStatus;
	detail?: string;
}

export interface RuntimeConfig {
	model: string;
	mode: "normal" | "safe" | "debug";
	thinkingEnabled: boolean;
	maxTokens: number;
}

export interface RuntimeConfigResponse extends RuntimeConfig {
	availableModels: string[];
}

// ─── Generic envelope ───────────────────────────────────────────────────────

export interface ApiError {
	code: string;
	message: string;
	detail?: string;
}

/** A WebSocket peer subscribed to a topic (jobId or "launcher"). */
export interface WsTopic {
	topic: string;
}
