/**
 * Launcher phase — TypeScript contracts.
 * Desktop WebUI wrapper only. Never imports oh-my-pi core.
 */

// ---------------------------------------------------------------------------
// Service / runtime state
// ---------------------------------------------------------------------------

export type ServiceStatus = 'stopped' | 'starting' | 'running' | 'degraded' | 'error' | 'updating';

export type LauncherPhase =
  | 'stopped'
  | 'starting'
  | 'running_healthy'
  | 'running_degraded'
  | 'error'
  | 'updating'
  | 'stopping';

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

// ---------------------------------------------------------------------------
// Service control
// ---------------------------------------------------------------------------

export interface ServiceActionResponse {
  ok: boolean;
  jobId?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Update & maintenance
// ---------------------------------------------------------------------------

export type UpdateChannel = 'stable' | 'beta' | 'nightly';

export interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion: string | null;
  channel: UpdateChannel;
  releaseNotes: string | null;
  checkedAt: string;
}

export interface UpdateActionResponse {
  ok: boolean;
  jobId?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Workspace / session
// ---------------------------------------------------------------------------

export interface WorkspaceProfile {
  id: string;
  name: string;
  path: string;
  lastOpenedAt: string | null;
  isActive: boolean;
}

export interface WorkspaceListResponse {
  workspaces: WorkspaceProfile[];
}

// ---------------------------------------------------------------------------
// Health diagnostics
// ---------------------------------------------------------------------------

export type DiagCheckStatus = 'ok' | 'warn' | 'fail' | 'running';

export interface DiagCheck {
  id: string;
  label: string;
  status: DiagCheckStatus;
  detail?: string;
  fixHint?: string;
}

export interface DiagnosticsResponse {
  overallStatus: 'ok' | 'warn' | 'fail';
  checks: DiagCheck[];
  runAt: string;
}

// ---------------------------------------------------------------------------
// Log streaming
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogLine {
  ts: string;
  level: LogLevel;
  message: string;
  source?: string;
}

// ---------------------------------------------------------------------------
// WS stream events
// ---------------------------------------------------------------------------

export type LauncherStreamEvent =
  | { type: 'log'; line: LogLine }
  | { type: 'status_change'; status: ServiceStatus; phase: LauncherPhase }
  | { type: 'metrics'; metrics: ResourceMetrics }
  | { type: 'health'; healthy: boolean; error?: string };

// ---------------------------------------------------------------------------
// Launcher error
// ---------------------------------------------------------------------------

export interface LauncherError {
  code: string;
  message: string;
  detail?: string;
  actions?: Array<{ label: string; action: string }>;
}
