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

/** README-documented install methods. Each maps to one shell command. */
export type InstallMethodId = "windows-irm" | "macos-curl" | "homebrew" | "bun-global" | "mise";

export interface InstallMethod {
	id: InstallMethodId;
	label: string;
	command: string;
	platforms: Array<"win32" | "darwin" | "linux">;
	requires: string[];
	notes?: string;
	/**
	 * Human-readable destination omp lands at when this method runs on the
	 * current host (factors in default paths and detected Bun). The UI shows
	 * this in place of the user-editable path textbox for methods that
	 * ignore PI_INSTALL_DIR.
	 */
	targetHint?: string;
}

export interface InstallMethodsResponse {
	methods: InstallMethod[];
	recommended: InstallMethodId;
	platform: NodeJS.Platform;
	/**
	 * Platform-correct default path for Binary mode (PI_INSTALL_DIR). The UI
	 * uses this as the textbox seed so it matches the official installer's
	 * default — only honored by `windows-irm` (Binary path); other methods
	 * ignore it.
	 */
	defaultInstallPath: string;
}

/**
 * Install request. All README methods are global installers — omp lands on
 * $PATH. `installPath` is only honored by `windows-irm` (as `PI_INSTALL_DIR`)
 * and is ignored by every other method, so it is optional here. The bridge
 * still requires it when the chosen method is `windows-irm`.
 */
export interface InstallRequest {
	method?: InstallMethodId;
	installPath?: string;
	/** Legacy fields kept for back-compat; ignored by the dispatch logic. */
	repoUrl?: string;
	branch?: string;
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

export type ServiceStatus = "stopped" | "starting" | "running" | "degraded" | "error" | "updating" | "installing";

export type LauncherPhase =
	| "stopped"
	| "starting"
	| "running_healthy"
	| "running_degraded"
	| "error"
	| "updating"
	| "stopping"
	| "installing";

export interface InstallProgress {
	jobId: string;
	percent: number;
	message: string;
	logTail?: string[];
}

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
	installProgress?: InstallProgress | null;
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
	| { type: "health"; healthy: boolean; error?: string }
	| { type: "install_progress"; progress: InstallProgress };

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

// ─── OMP shared config (~/.omp/agent/config.yml) ───────────────────────────

export type OmpThemeRef = string;
export type OmpModelRoleKey = "default" | "smol" | "slow" | "plan" | "commit";
export type OmpQueueMode = "one-at-a-time" | "all";
export type OmpInterruptMode = "immediate" | "wait";
export type OmpDiscoveryMode = "auto" | "manual";

export interface OmpSearxng {
	endpoint?: string;
	token?: string;
	basicUsername?: string;
	basicPassword?: string;
}

/**
 * Shape we read/write to `~/.omp/agent/config.yml`. All fields optional —
 * missing keys fall through to omp's built-in defaults. Stays in sync with
 * the public spec at https://omp.sh/docs/settings.
 */
export interface OmpConfig {
	theme?: { dark?: OmpThemeRef; light?: OmpThemeRef };
	modelRoles?: Partial<Record<OmpModelRoleKey, string>>;
	steeringMode?: OmpQueueMode;
	followUpMode?: OmpQueueMode;
	interruptMode?: OmpInterruptMode;
	tools?: { discoveryMode?: OmpDiscoveryMode };
	debug?: { enabled?: boolean };
	extensions?: string[];
	skills?: Record<string, boolean>;
	images?: { autoResize?: boolean };
	searxng?: OmpSearxng;
	memory?: { backend?: string };
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
