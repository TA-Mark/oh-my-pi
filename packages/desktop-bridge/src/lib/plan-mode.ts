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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "./yaml-minimal";

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
 * Read modelRoles from ~/.omp/agent/config.yml.
 * Returns the raw role→model-string map.
 */
export function readModelRoles(): Record<string, string> {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	const configPath = join(
		process.env.PI_CODING_AGENT_DIR ?? join(home, ".omp", "agent"),
		"config.yml",
	);
	try {
		const raw = readFileSync(configPath, "utf8");
		const parsed = parseYaml(raw);
		if (parsed && typeof parsed === "object" && "modelRoles" in parsed) {
			const roles = (parsed as Record<string, unknown>).modelRoles;
			if (roles && typeof roles === "object") {
				return roles as Record<string, string>;
			}
		}
	} catch { /* config not found or malformed */ }
	return {};
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
