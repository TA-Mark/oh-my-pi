/**
 * useInstallerStateMachine
 * Manages the full installer lifecycle state machine.
 * Desktop WebUI wrapper only — never imports oh-my-pi core.
 *
 * State machine:
 *   IDLE -> CHECKING -> CHECK_FAIL | READY
 *   READY -> INSTALLING -> SUCCESS | FAILED | CANCELLED
 *   FAILED -> INSTALLING (retry)
 *   CANCELLED -> IDLE
 */

import { useCallback, useReducer } from 'react';
import type {
  InstallerPhase,
  PreflightCheck,
  InstallStep,
  InstallerError,
  LogLine,
} from '../types/installer';

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface InstallerState {
  phase: InstallerPhase;
  repoUrl: string;
  branch: string;
  installPath: string;
  /** Preflight results */
  checks: PreflightCheck[];
  /** Install step list */
  steps: InstallStep[];
  progress: number;
  currentStep: string;
  /** Buffered log lines */
  logs: LogLine[];
  error: InstallerError | null;
  jobId: string | null;
  elapsedMs: number;
}

const DEFAULT_REPO = 'https://github.com/myorg/oh-my-pi.git';
const DEFAULT_BRANCH = 'main';
const DEFAULT_PATH = 'C:\\oh-my-pi';

const initialState: InstallerState = {
  phase: 'idle',
  repoUrl: DEFAULT_REPO,
  branch: DEFAULT_BRANCH,
  installPath: DEFAULT_PATH,
  checks: [],
  steps: [],
  progress: 0,
  currentStep: '',
  logs: [],
  error: null,
  jobId: null,
  elapsedMs: 0,
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type Action =
  | { type: 'SET_SOURCE'; repoUrl: string; branch: string; installPath: string }
  | { type: 'START_CHECKING' }
  | { type: 'UPDATE_CHECK'; check: PreflightCheck }
  | { type: 'CHECKS_DONE'; allPassed: boolean; checks: PreflightCheck[] }
  | { type: 'START_INSTALLING'; jobId: string }
  | { type: 'UPDATE_STEP'; step: InstallStep; progress: number; currentStep: string }
  | { type: 'APPEND_LOG'; line: LogLine }
  | { type: 'INSTALL_SUCCESS' }
  | { type: 'INSTALL_FAILED'; error: InstallerError }
  | { type: 'CANCEL' }
  | { type: 'RETRY' }
  | { type: 'RESET' }
  | { type: 'TICK'; elapsedMs: number };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function reducer(state: InstallerState, action: Action): InstallerState {
  switch (action.type) {
    case 'SET_SOURCE':
      if (state.phase !== 'idle' && state.phase !== 'check_fail') return state;
      return { ...state, repoUrl: action.repoUrl, branch: action.branch, installPath: action.installPath };

    case 'START_CHECKING':
      return { ...state, phase: 'checking', checks: [], error: null, elapsedMs: 0 };

    case 'UPDATE_CHECK': {
      const idx = state.checks.findIndex(c => c.id === action.check.id);
      const checks = idx >= 0
        ? state.checks.map((c, i) => (i === idx ? action.check : c))
        : [...state.checks, action.check];
      return { ...state, checks };
    }

    case 'CHECKS_DONE':
      return {
        ...state,
        phase: action.allPassed ? 'ready' : 'check_fail',
        checks: action.checks,
      };

    case 'START_INSTALLING':
      return {
        ...state,
        phase: 'installing',
        jobId: action.jobId,
        steps: [],
        logs: [],
        progress: 0,
        currentStep: '',
        error: null,
        elapsedMs: 0,
      };

    case 'UPDATE_STEP': {
      const idx = state.steps.findIndex(s => s.id === action.step.id);
      const steps = idx >= 0
        ? state.steps.map((s, i) => (i === idx ? action.step : s))
        : [...state.steps, action.step];
      return { ...state, steps, progress: action.progress, currentStep: action.currentStep };
    }

    case 'APPEND_LOG':
      return { ...state, logs: [...state.logs, action.line] };

    case 'INSTALL_SUCCESS':
      return { ...state, phase: 'success', progress: 100 };

    case 'INSTALL_FAILED':
      return { ...state, phase: 'failed', error: action.error };

    case 'CANCEL':
      return { ...state, phase: 'cancelled' };

    case 'RETRY':
      return { ...state, phase: 'idle', error: null, progress: 0, steps: [], logs: [], jobId: null };

    case 'RESET':
      return { ...initialState };

    case 'TICK':
      return { ...state, elapsedMs: action.elapsedMs };

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface InstallerActions {
  setSource(repoUrl: string, branch: string, installPath: string): void;
  startChecking(): void;
  updateCheck(check: PreflightCheck): void;
  checksDone(allPassed: boolean, checks: PreflightCheck[]): void;
  startInstalling(jobId: string): void;
  updateStep(step: InstallStep, progress: number, currentStep: string): void;
  appendLog(line: LogLine): void;
  installSuccess(): void;
  installFailed(error: InstallerError): void;
  cancel(): void;
  retry(): void;
  reset(): void;
  tick(elapsedMs: number): void;
}

export function useInstallerStateMachine(): [InstallerState, InstallerActions] {
  const [state, dispatch] = useReducer(reducer, initialState);

  const actions: InstallerActions = {
    setSource: useCallback((repoUrl, branch, installPath) =>
      dispatch({ type: 'SET_SOURCE', repoUrl, branch, installPath }), []),
    startChecking: useCallback(() => dispatch({ type: 'START_CHECKING' }), []),
    updateCheck: useCallback((check) => dispatch({ type: 'UPDATE_CHECK', check }), []),
    checksDone: useCallback((allPassed, checks) => dispatch({ type: 'CHECKS_DONE', allPassed, checks }), []),
    startInstalling: useCallback((jobId) => dispatch({ type: 'START_INSTALLING', jobId }), []),
    updateStep: useCallback((step, progress, currentStep) =>
      dispatch({ type: 'UPDATE_STEP', step, progress, currentStep }), []),
    appendLog: useCallback((line) => dispatch({ type: 'APPEND_LOG', line }), []),
    installSuccess: useCallback(() => dispatch({ type: 'INSTALL_SUCCESS' }), []),
    installFailed: useCallback((error) => dispatch({ type: 'INSTALL_FAILED', error }), []),
    cancel: useCallback(() => dispatch({ type: 'CANCEL' }), []),
    retry: useCallback(() => dispatch({ type: 'RETRY' }), []),
    reset: useCallback(() => dispatch({ type: 'RESET' }), []),
    tick: useCallback((elapsedMs) => dispatch({ type: 'TICK', elapsedMs }), []),
  };

  return [state, actions];
}
