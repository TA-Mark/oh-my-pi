/**
 * Installer domain contracts — Desktop WebUI wrapper layer.
 * Do NOT import or reference oh-my-pi core internals here.
 */

// ---------------------------------------------------------------------------
// Install methods
// ---------------------------------------------------------------------------

export type InstallMethodId = "windows-irm" | "macos-curl" | "homebrew" | "bun-global" | "mise";

export interface InstallMethod {
	id: InstallMethodId;
	label: string;
	command: string;
	platforms: Array<"win32" | "darwin" | "linux">;
	requires: string[];
	notes?: string;
	/** Human-readable destination omp lands at — see backend type for detail. */
	targetHint?: string;
}

export interface InstallMethodsResponse {
	methods: InstallMethod[];
	recommended: InstallMethodId;
	platform: "win32" | "darwin" | "linux";
	/**
	 * Platform-correct default install path supplied by the bridge — only
	 * honored by the `windows-irm` Binary path (PI_INSTALL_DIR). Other
	 * methods (bun-global, homebrew, mise, …) ignore it.
	 */
	defaultInstallPath: string;
}

// ---------------------------------------------------------------------------
// Enums / literals
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export interface PreflightCheck {
	id: string;
	label: string;
	status: CheckStatus;
	detail?: string;
	fixHint?: string;
}

export interface PreflightRequest {
	installPath: string;
	method?: InstallMethodId;
}

export interface PreflightResponse {
	checks: PreflightCheck[];
	allPassed: boolean;
	hasWarnings: boolean;
}

// ---------------------------------------------------------------------------
// Install job
// ---------------------------------------------------------------------------

export interface InstallRequest {
	/**
	 * Only required when `method === "windows-irm"` (maps to `PI_INSTALL_DIR`
	 * for the Binary path). Other methods are global installers that ignore
	 * the textbox completely — the UI omits this field for them.
	 */
	installPath?: string;
	method?: InstallMethodId;
	/** Legacy alias for `installPath`; kept for back-compat. */
	windowsInstallPath?: string;
	/** Legacy fields kept for back-compat; ignored by the backend. */
	repoUrl?: string;
	branch?: string;
}

export interface InstallJobCreated {
	jobId: string;
	startedAt: string; // ISO 8601
	method?: InstallMethodId;
	logFile?: string | null;
}

export interface InstallStep {
	id: string;
	label: string;
	status: CheckStatus;
	startedAt?: string;
	completedAt?: string;
}

export interface InstallStatusResponse {
	jobId: string;
	phase: InstallerPhase;
	progress: number; // 0-100
	currentStep: string;
	steps: InstallStep[];
	error?: InstallerError;
}

// ---------------------------------------------------------------------------
// Log streaming
// ---------------------------------------------------------------------------

export interface LogLine {
	ts: string; // ISO 8601
	level: LogLevel;
	message: string;
	raw?: string;
}

/** WS / SSE event shape for log streaming */
export interface LogStreamEvent {
	type: "log";
	jobId: string;
	line: LogLine;
}

/** WS / SSE event shape for phase transitions */
export interface PhaseChangeEvent {
	type: "phase_change";
	jobId: string;
	phase: InstallerPhase;
	progress: number;
}

export type StreamEvent = LogStreamEvent | PhaseChangeEvent;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface InstallActionResponse {
	jobId: string;
	ok: boolean;
	message?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface InstallerError {
	code: string;
	message: string;
	detail?: string;
	/** Suggested recovery actions */
	actions?: Array<{ label: string; action: "retry" | "repair" | "cancel" | "logs" }>;
}
