/**
 * Installer domain contracts — Desktop WebUI wrapper layer.
 * Do NOT import or reference oh-my-pi core internals here.
 */

// ---------------------------------------------------------------------------
// Enums / literals
// ---------------------------------------------------------------------------

export type InstallerPhase =
  | 'idle'
  | 'checking'
  | 'check_fail'
  | 'ready'
  | 'installing'
  | 'success'
  | 'failed'
  | 'cancelled';

export type CheckStatus = 'pending' | 'running' | 'pass' | 'fail' | 'warn';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

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
  repoUrl: string;
  branch: string;
  installPath: string;
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
  repoUrl: string;
  branch: string;
  installPath: string;
  /** Windows-first: absolute path e.g. C:\oh-my-pi */
  windowsInstallPath?: string;
}

export interface InstallJobCreated {
  jobId: string;
  startedAt: string; // ISO 8601
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
  type: 'log';
  jobId: string;
  line: LogLine;
}

/** WS / SSE event shape for phase transitions */
export interface PhaseChangeEvent {
  type: 'phase_change';
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
  actions?: Array<{ label: string; action: 'retry' | 'repair' | 'cancel' | 'logs' }>;
}
