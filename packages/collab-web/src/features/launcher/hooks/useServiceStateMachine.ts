/**
 * useServiceStateMachine
 * Manages launcher service lifecycle state.
 * Desktop WebUI wrapper only — never imports oh-my-pi core.
 *
 * State machine:
 *   stopped -> starting -> running_healthy | running_degraded | error
 *   running_* -> stopping -> stopped
 *   error -> starting (retry) | stopped (safe mode)
 *   any -> updating -> running_healthy | error
 */

import { useCallback, useReducer } from 'react';
import type {
  LauncherPhase,
  ResourceMetrics,
  DiagCheck,
  LogLine,
  LauncherError,
  WorkspaceProfile,
  UpdateInfo,
} from '../types/launcher';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface LauncherState {
  phase: LauncherPhase;
  endpoint: string | null;
  healthy: boolean;
  version: string;
  lastStartedAt: string | null;
  metrics: ResourceMetrics | null;
  logs: LogLine[];
  error: LauncherError | null;
  diagChecks: DiagCheck[];
  diagRunning: boolean;
  workspaces: WorkspaceProfile[];
  activeWorkspaceId: string | null;
  updateInfo: UpdateInfo | null;
  updateChecking: boolean;
  updating: boolean;
  logsOpen: boolean;
}

const initial: LauncherState = {
  phase: 'stopped',
  endpoint: null,
  healthy: false,
  version: '',
  lastStartedAt: null,
  metrics: null,
  logs: [],
  error: null,
  diagChecks: [],
  diagRunning: false,
  workspaces: [],
  activeWorkspaceId: null,
  updateInfo: null,
  updateChecking: false,
  updating: false,
  logsOpen: false,
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type Action =
  | { type: 'STARTING' }
  | { type: 'RUNNING'; endpoint: string; version: string; lastStartedAt: string }
  | { type: 'DEGRADED'; endpoint: string; error: string }
  | { type: 'ERROR'; error: LauncherError }
  | { type: 'STOPPING' }
  | { type: 'STOPPED' }
  | { type: 'UPDATING' }
  | { type: 'UPDATE_DONE' }
  | { type: 'HEALTH_CHANGE'; healthy: boolean }
  | { type: 'METRICS'; metrics: ResourceMetrics }
  | { type: 'APPEND_LOG'; line: LogLine }
  | { type: 'CLEAR_LOGS' }
  | { type: 'DIAG_START' }
  | { type: 'DIAG_DONE'; checks: DiagCheck[] }
  | { type: 'WORKSPACES_LOADED'; workspaces: WorkspaceProfile[] }
  | { type: 'WORKSPACE_ACTIVATED'; id: string }
  | { type: 'UPDATE_CHECK_START' }
  | { type: 'UPDATE_CHECK_DONE'; info: UpdateInfo }
  | { type: 'TOGGLE_LOGS' }
  | { type: 'CLEAR_ERROR' };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

const MAX_LOGS = 500;

function reducer(state: LauncherState, action: Action): LauncherState {
  switch (action.type) {
    case 'STARTING':
      return { ...state, phase: 'starting', error: null };

    case 'RUNNING':
      return {
        ...state,
        phase: 'running_healthy',
        healthy: true,
        endpoint: action.endpoint,
        version: action.version,
        lastStartedAt: action.lastStartedAt,
        error: null,
      };

    case 'DEGRADED':
      return {
        ...state,
        phase: 'running_degraded',
        healthy: false,
        endpoint: action.endpoint,
        error: { code: 'DEGRADED', message: action.error },
      };

    case 'ERROR':
      return { ...state, phase: 'error', healthy: false, error: action.error };

    case 'STOPPING':
      return { ...state, phase: 'stopping' };

    case 'STOPPED':
      return { ...state, phase: 'stopped', healthy: false, endpoint: null, metrics: null };

    case 'UPDATING':
      return { ...state, phase: 'updating', updating: true };

    case 'UPDATE_DONE':
      return { ...state, updating: false };

    case 'HEALTH_CHANGE':
      return {
        ...state,
        healthy: action.healthy,
        phase: action.healthy
          ? 'running_healthy'
          : state.phase === 'running_healthy' ? 'running_degraded' : state.phase,
      };

    case 'METRICS':
      return { ...state, metrics: action.metrics };

    case 'APPEND_LOG': {
      const logs = [...state.logs, action.line];
      if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
      return { ...state, logs };
    }

    case 'CLEAR_LOGS':
      return { ...state, logs: [] };

    case 'DIAG_START':
      return { ...state, diagRunning: true, diagChecks: [] };

    case 'DIAG_DONE':
      return { ...state, diagRunning: false, diagChecks: action.checks };

    case 'WORKSPACES_LOADED':
      return { ...state, workspaces: action.workspaces };

    case 'WORKSPACE_ACTIVATED':
      return {
        ...state,
        activeWorkspaceId: action.id,
        workspaces: state.workspaces.map(w => ({ ...w, isActive: w.id === action.id })),
      };

    case 'UPDATE_CHECK_START':
      return { ...state, updateChecking: true };

    case 'UPDATE_CHECK_DONE':
      return { ...state, updateChecking: false, updateInfo: action.info };

    case 'TOGGLE_LOGS':
      return { ...state, logsOpen: !state.logsOpen };

    case 'CLEAR_ERROR':
      return { ...state, error: null };

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface ServiceActions {
  starting(): void;
  running(endpoint: string, version: string, lastStartedAt: string): void;
  degraded(endpoint: string, error: string): void;
  error(error: LauncherError): void;
  stopping(): void;
  stopped(): void;
  updating(): void;
  updateDone(): void;
  healthChange(healthy: boolean): void;
  metrics(m: ResourceMetrics): void;
  appendLog(line: LogLine): void;
  clearLogs(): void;
  diagStart(): void;
  diagDone(checks: DiagCheck[]): void;
  workspacesLoaded(workspaces: WorkspaceProfile[]): void;
  workspaceActivated(id: string): void;
  updateCheckStart(): void;
  updateCheckDone(info: UpdateInfo): void;
  toggleLogs(): void;
  clearError(): void;
}

export function useServiceStateMachine(): [LauncherState, ServiceActions] {
  const [state, dispatch] = useReducer(reducer, initial);

  const actions: ServiceActions = {
    starting:          useCallback(() => dispatch({ type: 'STARTING' }), []),
    running:           useCallback((e, v, t) => dispatch({ type: 'RUNNING', endpoint: e, version: v, lastStartedAt: t }), []),
    degraded:          useCallback((e, err) => dispatch({ type: 'DEGRADED', endpoint: e, error: err }), []),
    error:             useCallback((err) => dispatch({ type: 'ERROR', error: err }), []),
    stopping:          useCallback(() => dispatch({ type: 'STOPPING' }), []),
    stopped:           useCallback(() => dispatch({ type: 'STOPPED' }), []),
    updating:          useCallback(() => dispatch({ type: 'UPDATING' }), []),
    updateDone:        useCallback(() => dispatch({ type: 'UPDATE_DONE' }), []),
    healthChange:      useCallback((h) => dispatch({ type: 'HEALTH_CHANGE', healthy: h }), []),
    metrics:           useCallback((m) => dispatch({ type: 'METRICS', metrics: m }), []),
    appendLog:         useCallback((l) => dispatch({ type: 'APPEND_LOG', line: l }), []),
    clearLogs:         useCallback(() => dispatch({ type: 'CLEAR_LOGS' }), []),
    diagStart:         useCallback(() => dispatch({ type: 'DIAG_START' }), []),
    diagDone:          useCallback((c) => dispatch({ type: 'DIAG_DONE', checks: c }), []),
    workspacesLoaded:  useCallback((w) => dispatch({ type: 'WORKSPACES_LOADED', workspaces: w }), []),
    workspaceActivated:useCallback((id) => dispatch({ type: 'WORKSPACE_ACTIVATED', id }), []),
    updateCheckStart:  useCallback(() => dispatch({ type: 'UPDATE_CHECK_START' }), []),
    updateCheckDone:   useCallback((i) => dispatch({ type: 'UPDATE_CHECK_DONE', info: i }), []),
    toggleLogs:        useCallback(() => dispatch({ type: 'TOGGLE_LOGS' }), []),
    clearError:        useCallback(() => dispatch({ type: 'CLEAR_ERROR' }), []),
  };

  return [state, actions];
}
