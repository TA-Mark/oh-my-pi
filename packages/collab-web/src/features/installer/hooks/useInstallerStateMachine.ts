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

import { useCallback, useReducer } from "react";
import type {
	InstallerError,
	InstallerPhase,
	InstallMethod,
	InstallMethodId,
	InstallMethodsResponse,
	InstallStep,
	LogLine,
	PreflightCheck,
} from "../types/installer";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface InstallerState {
	phase: InstallerPhase;
	/** Selected install method id (null = use backend recommended). */
	selectedMethod: InstallMethodId | null;
	/** Methods list from /installer/methods (null = not fetched yet). */
	methods: InstallMethodsResponse | null;
	/** User-editable target path; only honored by the Binary-mode installer. */
	installPath: string;
	/**
	 * Where omp actually landed on disk after a successful install, resolved
	 * by the bridge via `where omp` + known-location lookup. Null until the
	 * install succeeds — the success card prefers this over `installPath`
	 * because most methods (bun-global, homebrew, mise) ignore the textbox.
	 */
	installedPath: string | null;
	/**
	 * Absolute path to the persisted install log file (set by JobManager).
	 * Shown as a footer in InstallProgressCard so the user can copy/share it
	 * when debugging a failure.
	 */
	logFile: string | null;
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

/**
 * The browser cannot know the host's LOCALAPPDATA / HOME until the bridge
 * tells us. We seed an empty string and let SET_METHODS fill it in from
 * `methods.defaultInstallPath` so the textbox shows exactly the path the
 * official installer would write to.
 */
const initialState: InstallerState = {
	phase: "idle",
	selectedMethod: null,
	methods: null,
	installPath: "",
	installedPath: null,
	logFile: null,
	checks: [],
	steps: [],
	progress: 0,
	currentStep: "",
	logs: [],
	error: null,
	jobId: null,
	elapsedMs: 0,
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type Action =
	| { type: "SET_METHODS"; methods: InstallMethodsResponse }
	| { type: "SELECT_METHOD"; method: InstallMethodId }
	| { type: "SET_INSTALL_PATH"; installPath: string }
	| { type: "START_CHECKING" }
	| { type: "UPDATE_CHECK"; check: PreflightCheck }
	| { type: "CHECKS_DONE"; allPassed: boolean; checks: PreflightCheck[] }
	| { type: "START_INSTALLING"; jobId: string; logFile: string | null }
	| { type: "UPDATE_STEP"; step: InstallStep; progress: number; currentStep: string }
	| { type: "APPEND_LOG"; line: LogLine }
	| { type: "INSTALL_SUCCESS" }
	| { type: "SET_INSTALLED_PATH"; installedPath: string }
	| { type: "INSTALL_FAILED"; error: InstallerError }
	| { type: "CANCEL" }
	| { type: "RETRY" }
	| { type: "RESET" }
	| { type: "TICK"; elapsedMs: number };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function reducer(state: InstallerState, action: Action): InstallerState {
	switch (action.type) {
		case "SET_METHODS":
			// Don't clobber a user selection on re-fetch. Seed installPath from
			// the bridge's platform-correct default only if the user has not
			// typed anything yet.
			return {
				...state,
				methods: action.methods,
				selectedMethod: state.selectedMethod ?? action.methods.recommended,
				installPath: state.installPath === "" ? action.methods.defaultInstallPath : state.installPath,
			};

		case "SELECT_METHOD":
			if (state.phase !== "idle" && state.phase !== "check_fail" && state.phase !== "ready") return state;
			return { ...state, selectedMethod: action.method };

		case "SET_INSTALL_PATH":
			if (state.phase !== "idle" && state.phase !== "check_fail" && state.phase !== "ready") return state;
			return { ...state, installPath: action.installPath };

		case "START_CHECKING":
			return { ...state, phase: "checking", checks: [], error: null, elapsedMs: 0 };

		case "UPDATE_CHECK": {
			const idx = state.checks.findIndex(c => c.id === action.check.id);
			const checks =
				idx >= 0 ? state.checks.map((c, i) => (i === idx ? action.check : c)) : [...state.checks, action.check];
			return { ...state, checks };
		}

		case "CHECKS_DONE":
			return {
				...state,
				phase: action.allPassed ? "ready" : "check_fail",
				checks: action.checks,
			};

		case "START_INSTALLING":
			return {
				...state,
				phase: "installing",
				jobId: action.jobId,
				logFile: action.logFile,
				steps: [],
				logs: [],
				progress: 0,
				currentStep: "",
				error: null,
				installedPath: null,
				elapsedMs: 0,
			};

		case "UPDATE_STEP": {
			const idx = state.steps.findIndex(s => s.id === action.step.id);
			const steps =
				idx >= 0 ? state.steps.map((s, i) => (i === idx ? action.step : s)) : [...state.steps, action.step];
			return { ...state, steps, progress: action.progress, currentStep: action.currentStep };
		}

		case "APPEND_LOG":
			return { ...state, logs: [...state.logs, action.line] };

		case "INSTALL_SUCCESS":
			return { ...state, phase: "success", progress: 100 };

		case "SET_INSTALLED_PATH":
			return { ...state, installedPath: action.installedPath };

		case "INSTALL_FAILED":
			return { ...state, phase: "failed", error: action.error };

		case "CANCEL":
			return { ...state, phase: "cancelled" };

		case "RETRY":
			return { ...state, phase: "idle", error: null, progress: 0, steps: [], logs: [], jobId: null };

		case "RESET":
			return { ...initialState };

		case "TICK":
			return { ...state, elapsedMs: action.elapsedMs };

		default:
			return state;
	}
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface InstallerActions {
	setMethods(methods: InstallMethodsResponse): void;
	selectMethod(method: InstallMethodId): void;
	setInstallPath(installPath: string): void;
	startChecking(): void;
	updateCheck(check: PreflightCheck): void;
	checksDone(allPassed: boolean, checks: PreflightCheck[]): void;
	startInstalling(jobId: string, logFile: string | null): void;
	updateStep(step: InstallStep, progress: number, currentStep: string): void;
	appendLog(line: LogLine): void;
	installSuccess(): void;
	setInstalledPath(installedPath: string): void;
	installFailed(error: InstallerError): void;
	cancel(): void;
	retry(): void;
	reset(): void;
	tick(elapsedMs: number): void;
}

export function useInstallerStateMachine(): [InstallerState, InstallerActions] {
	const [state, dispatch] = useReducer(reducer, initialState);

	const actions: InstallerActions = {
		setMethods: useCallback(methods => dispatch({ type: "SET_METHODS", methods }), []),
		selectMethod: useCallback(method => dispatch({ type: "SELECT_METHOD", method }), []),
		setInstallPath: useCallback(installPath => dispatch({ type: "SET_INSTALL_PATH", installPath }), []),
		startChecking: useCallback(() => dispatch({ type: "START_CHECKING" }), []),
		updateCheck: useCallback(check => dispatch({ type: "UPDATE_CHECK", check }), []),
		checksDone: useCallback((allPassed, checks) => dispatch({ type: "CHECKS_DONE", allPassed, checks }), []),
		startInstalling: useCallback((jobId, logFile) => dispatch({ type: "START_INSTALLING", jobId, logFile }), []),
		updateStep: useCallback(
			(step, progress, currentStep) => dispatch({ type: "UPDATE_STEP", step, progress, currentStep }),
			[],
		),
		appendLog: useCallback(line => dispatch({ type: "APPEND_LOG", line }), []),
		installSuccess: useCallback(() => dispatch({ type: "INSTALL_SUCCESS" }), []),
		setInstalledPath: useCallback(installedPath => dispatch({ type: "SET_INSTALLED_PATH", installedPath }), []),
		installFailed: useCallback(error => dispatch({ type: "INSTALL_FAILED", error }), []),
		cancel: useCallback(() => dispatch({ type: "CANCEL" }), []),
		retry: useCallback(() => dispatch({ type: "RETRY" }), []),
		reset: useCallback(() => dispatch({ type: "RESET" }), []),
		tick: useCallback(elapsedMs => dispatch({ type: "TICK", elapsedMs }), []),
	};

	return [state, actions];
}

// Re-export for convenience so the page doesn't need a separate import.
export type { InstallMethod, InstallMethodId, InstallMethodsResponse };
