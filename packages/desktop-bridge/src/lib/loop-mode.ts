/**
 * loop-mode — bridge-level loop mode implementation.
 *
 * Mirrors OMP TUI `/loop` by:
 * 1. Parsing limit args (iterations or duration) via loop-limit utilities
 * 2. Subscribing to OMP frame stream for `agent_end` events
 * 3. Re-sending the loop prompt on each turn completion until limit is hit
 *
 * State is per-session, stored in a Map. The `unsub` function tears down
 * the frame listener when the loop stops.
 */

import type { OmpFrameEnvelope } from "./omp-manager";

export interface LoopLimitConfig {
	kind: "iterations" | "duration";
	iterations?: number;
	durationMs?: number;
}

export interface LoopLimitRuntime {
	kind: "iterations" | "duration";
	initial?: number;
	remaining?: number;
	durationMs?: number;
	deadlineMs?: number;
}

export interface LoopState {
	active: boolean;
	prompt: string;
	limit: LoopLimitRuntime | undefined;
	turnCount: number;
	paused: boolean;
	unsub?: () => void;
}

const loopStates = new Map<string, LoopState>();

export function getLoopState(sessionId: string): LoopState | null {
	return loopStates.get(sessionId) ?? null;
}

export function setLoopState(sessionId: string, state: LoopState | null): void {
	if (state) loopStates.set(sessionId, state);
	else loopStates.delete(sessionId);
}

export function clearLoopState(sessionId: string): void {
	const state = loopStates.get(sessionId);
	if (state?.unsub) state.unsub();
	loopStates.delete(sessionId);
}

// ─── Limit parsing (inline, mirrors coding-agent/src/modes/loop-limit.ts) ───

const TIME_UNITS_MS = new Map<string, number>([
	["s", 1_000],
	["sec", 1_000],
	["secs", 1_000],
	["second", 1_000],
	["seconds", 1_000],
	["m", 60_000],
	["min", 60_000],
	["mins", 60_000],
	["minute", 60_000],
	["minutes", 60_000],
	["h", 3_600_000],
	["hr", 3_600_000],
	["hrs", 3_600_000],
	["hour", 3_600_000],
	["hours", 3_600_000],
]);

export interface ParsedLoopArgs {
	limit?: LoopLimitConfig;
	prompt?: string;
}

export function parseLoopArgs(args: string): ParsedLoopArgs | string {
	const trimmed = args.trim();
	if (!trimmed) return {};

	const firstSpace = trimmed.search(/\s/);
	const firstToken = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
	const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
	const token = firstToken.toLowerCase();

	if (!/^[+-]?\d/.test(token)) {
		return { prompt: trimmed };
	}

	if (/^\d+$/.test(token)) {
		if (rest) {
			const restTokens = rest.split(/\s+/);
			const unitMs = TIME_UNITS_MS.get(restTokens[0].toLowerCase());
			if (unitMs !== undefined) {
				const ms = Number(token) * unitMs;
				if (ms <= 0) return "Loop duration must be positive.";
				return {
					limit: { kind: "duration", durationMs: ms },
					prompt: restTokens.slice(1).join(" ").trim() || undefined,
				};
			}
		}
		const n = Number(token);
		if (!Number.isSafeInteger(n) || n <= 0) return "Loop count must be a positive integer.";
		return { limit: { kind: "iterations", iterations: n }, prompt: rest || undefined };
	}

	// Compact duration: "10m", "1h30m"
	if (/^(?:\d+[a-z]+)+$/.test(token)) {
		const segments = token.match(/\d+[a-z]+/g);
		if (!segments) return "Usage: /loop [count|duration]. Examples: /loop 10, /loop 10m";
		let totalMs = 0;
		for (const seg of segments) {
			const match = /^(\d+)([a-z]+)$/.exec(seg);
			if (!match) return "Usage: /loop [count|duration].";
			const unitMs = TIME_UNITS_MS.get(match[2]);
			if (!unitMs) return "Duration unit must be seconds, minutes, or hours.";
			totalMs += Number(match[1]) * unitMs;
		}
		if (totalMs <= 0) return "Loop duration must be positive.";
		return { limit: { kind: "duration", durationMs: totalMs }, prompt: rest || undefined };
	}

	return "Usage: /loop [count|duration]. Examples: /loop 10, /loop 10m, /loop 10min.";
}

export function createLoopRuntime(
	config: LoopLimitConfig | undefined,
	nowMs = Date.now(),
): LoopLimitRuntime | undefined {
	if (!config) return undefined;
	if (config.kind === "iterations" && config.iterations) {
		return { kind: "iterations", initial: config.iterations, remaining: config.iterations };
	}
	if (config.kind === "duration" && config.durationMs) {
		return { kind: "duration", durationMs: config.durationMs, deadlineMs: nowMs + config.durationMs };
	}
	return undefined;
}

export function consumeIteration(limit: LoopLimitRuntime | undefined, nowMs = Date.now()): boolean {
	if (!limit) return true;
	if (limit.kind === "duration") {
		return nowMs < (limit.deadlineMs ?? 0);
	}
	if ((limit.remaining ?? 0) <= 0) return false;
	limit.remaining = (limit.remaining ?? 0) - 1;
	return true;
}

export function describeLimit(limit: LoopLimitRuntime | undefined): string {
	if (!limit) return "unbounded";
	if (limit.kind === "iterations") {
		return `${limit.remaining}/${limit.initial} iterations remaining`;
	}
	const remainMs = Math.max(0, (limit.deadlineMs ?? 0) - Date.now());
	const remainSec = Math.ceil(remainMs / 1000);
	if (remainSec >= 3600) return `${Math.floor(remainSec / 3600)}h ${Math.floor((remainSec % 3600) / 60)}m remaining`;
	if (remainSec >= 60) return `${Math.floor(remainSec / 60)}m ${remainSec % 60}s remaining`;
	return `${remainSec}s remaining`;
}

export function stopLoop(sessionId: string): void {
	clearLoopState(sessionId);
}

export interface OmpBridge {
	send(id: string, frame: unknown): boolean;
	subscribe(id: string, listener: (envelope: OmpFrameEnvelope) => void, replay: boolean): () => void;
}

/**
 * Sets up a loop: parses args, creates runtime, subscribes to agent_end frames,
 * and sends the initial prompt. Returns status object or error string.
 */
export function startLoop(
	sessionId: string,
	args: string,
	promptOverride: string | undefined,
	omp: OmpBridge,
): { ok: true; state: LoopState } | { ok: false; error: string } {
	// Stop existing loop if any
	clearLoopState(sessionId);

	const parsed = parseLoopArgs(args);
	if (typeof parsed === "string") return { ok: false, error: parsed };

	const limit = createLoopRuntime(parsed.limit);
	const prompt =
		promptOverride ||
		parsed.prompt ||
		"Continue working on the current task. If the task is complete, report completion.";

	const state: LoopState = {
		active: true,
		prompt,
		limit,
		turnCount: 0,
		paused: false,
	};

	const unsub = omp.subscribe(
		sessionId,
		(envelope: OmpFrameEnvelope) => {
			if (envelope.type !== "frame") return;
			const frame = envelope.frame as { type?: string } | undefined;
			if (frame?.type !== "agent_end") return;

			const current = getLoopState(sessionId);
			if (!current?.active || current.paused) return;

			current.turnCount += 1;

			if (!consumeIteration(current.limit)) {
				current.active = false;
				if (current.unsub) current.unsub();
				current.unsub = undefined;
				setLoopState(sessionId, current);
				return;
			}

			omp.send(sessionId, {
				id: `bridge-loop-${Date.now()}`,
				type: "prompt",
				message: `<loop_context>\n<iteration>${current.turnCount + 1}</iteration>\n<limit>${describeLimit(current.limit)}</limit>\n</loop_context>\n\n${current.prompt}`,
			});
		},
		false,
	);

	state.unsub = unsub;
	setLoopState(sessionId, state);

	// Send initial prompt
	omp.send(sessionId, {
		id: `bridge-loop-start-${Date.now()}`,
		type: "prompt",
		message: `<loop_context>\n<iteration>1</iteration>\n<limit>${describeLimit(limit)}</limit>\n</loop_context>\n\n${prompt}`,
	});

	return { ok: true, state };
}
