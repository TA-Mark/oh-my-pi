/**
 * plan-mode — bridge-level plan mode implementation.
 *
 * Mirrors OMP TUI plan mode logic using available RPC commands:
 * 1. Save current model
 * 2. Switch to plan-role model via set_model RPC
 * 3. Track plan mode state per session
 * 4. On exit, restore original model
 *
 * Limitation vs OMP TUI: no tool restriction (RPC doesn't expose set_tools).
 * The planner is instructed via system prefix to only read, not write.
 */

import { readConfig } from "./omp-config";

export interface PlanModeState {
	active: boolean;
	originalModel: { provider: string; id: string } | null;
	planModel: { provider: string; id: string } | null;
	objective: string | null;
}

export interface GoalModeState {
	active: boolean;
	objective: string;
	turnCount: number;
	paused: boolean;
}

const planStates = new Map<string, PlanModeState>();
const goalStates = new Map<string, GoalModeState>();

export function getPlanState(sessionId: string): PlanModeState {
	return planStates.get(sessionId) ?? { active: false, originalModel: null, planModel: null, objective: null };
}

export function setPlanState(sessionId: string, state: PlanModeState): void {
	planStates.set(sessionId, state);
}

export function getGoalState(sessionId: string): GoalModeState | null {
	return goalStates.get(sessionId) ?? null;
}

export function setGoalState(sessionId: string, state: GoalModeState | null): void {
	if (state) goalStates.set(sessionId, state);
	else goalStates.delete(sessionId);
}

export function clearSessionStates(sessionId: string): void {
	planStates.delete(sessionId);
	goalStates.delete(sessionId);
}

/**
 * Read modelRoles from ~/.omp/agent/config.yml via the shared omp-config layer
 * (single source of truth — same file the omp CLI writes via `omp config set`).
 */
export function readModelRoles(): Record<string, string> {
	const roles = readConfig().modelRoles ?? {};
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(roles)) {
		if (typeof v === "string") out[k] = v;
	}
	return out;
}

/**
 * Build the plan mode system prefix — instructs the planner to be read-only.
 */
export function buildPlanPromptPrefix(objective: string): string {
	return [
		"You are in PLAN MODE. Your job is to create a detailed implementation plan.",
		"",
		"Rules for plan mode:",
		"- Read files to understand the codebase — use read, search, find, lsp tools freely",
		"- Do NOT modify any files — do not use write, edit, bash with destructive commands",
		"- Draft your plan as a structured document with clear steps",
		"- When you are satisfied with the plan, present it for approval",
		"",
		`Objective: ${objective}`,
	].join("\n");
}

/**
 * Build the goal mode continuation steer — hidden re-prompt after each turn.
 */
export function buildGoalContinuation(goal: GoalModeState): string {
	return [
		`<goal_context>`,
		`<objective>${goal.objective}</objective>`,
		`<turns_elapsed>${goal.turnCount}</turns_elapsed>`,
		`</goal_context>`,
		"",
		"Continue working toward the objective above. If you believe the goal is complete,",
		"verify each deliverable against the current repo state and report completion.",
		"If not complete, take the next logical step.",
	].join("\n");
}
