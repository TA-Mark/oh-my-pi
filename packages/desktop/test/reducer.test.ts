import { describe, expect, test } from "bun:test";
import { appendUserMessage, engineInterrupted, initialViewModel, reduce, type ViewModel } from "../src/lib/reducer";
import type { EngineEvent, EngineMessage } from "../src/lib/rpc-protocol";

function assistant(text: string, extra: Partial<EngineMessage> = {}): EngineMessage {
	return { role: "assistant", content: [{ type: "text", text }], ...extra };
}

function apply(state: ViewModel, ...events: EngineEvent[]): ViewModel {
	return events.reduce((s, e) => reduce(s, e), state);
}

describe("streaming assistant correlation (0.1)", () => {
	test("caps rendered transcript memory while retaining the newest messages", () => {
		let state = initialViewModel;
		for (let index = 0; index < 2_050; index++) state = appendUserMessage(state, `message-${index}`);
		expect(state.messages).toHaveLength(2_000);
		expect(state.messages[0]?.text).toBe("message-50");
		expect(state.messages.at(-1)?.text).toBe("message-2049");
	});

	test("single stream: start → update → end targets one message", () => {
		const s = apply(
			initialViewModel,
			{ type: "message_start", message: assistant("") },
			{ type: "message_update", message: assistant("hel") },
			{ type: "message_update", message: assistant("hello") },
			{ type: "message_end", message: assistant("hello") },
		);
		const assistants = s.messages.filter(m => m.role === "assistant");
		expect(assistants).toHaveLength(1);
		expect(assistants[0].text).toBe("hello");
		expect(s.streamingAssistantId).toBeUndefined();
	});

	test("two sequential turns do not overwrite each other", () => {
		let s = apply(
			initialViewModel,
			{ type: "message_start", message: assistant("first") },
			{ type: "message_end", message: assistant("first") },
		);
		s = apply(
			s,
			{ type: "message_start", message: assistant("") },
			{ type: "message_update", message: assistant("second") },
			{ type: "message_end", message: assistant("second") },
		);
		const texts = s.messages.filter(m => m.role === "assistant").map(m => m.text);
		expect(texts).toEqual(["first", "second"]);
	});

	test("update without a start opens a fresh assistant instead of dropping", () => {
		const s = apply(initialViewModel, { type: "message_update", message: assistant("orphan") });
		const assistants = s.messages.filter(m => m.role === "assistant");
		expect(assistants).toHaveLength(1);
		expect(assistants[0].text).toBe("orphan");
	});

	test("interleaved update after end does not overwrite the closed turn", () => {
		let s = apply(
			initialViewModel,
			{ type: "message_start", message: assistant("") },
			{ type: "message_end", message: assistant("done") },
		);
		// A late update (no open stream) must create a new row, not mutate "done".
		s = apply(s, { type: "message_update", message: assistant("late") });
		const texts = s.messages.filter(m => m.role === "assistant").map(m => m.text);
		expect(texts).toEqual(["done", "late"]);
	});
});

describe("tool card fallback + dedupe (0.2, 0.3)", () => {
	test("tool_execution_end without a start creates a fallback card", () => {
		const s = apply(initialViewModel, {
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "bash",
			result: "ok",
		});
		const tools = s.messages.filter(m => m.role === "tool");
		expect(tools).toHaveLength(1);
		expect(tools[0].id).toBe("t_c1");
		expect(tools[0].toolRunning).toBe(false);
	});

	test("duplicate tool_execution_start yields a single card", () => {
		const start: EngineEvent = { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { a: 1 } };
		const s = apply(initialViewModel, start, start);
		expect(s.messages.filter(m => m.role === "tool")).toHaveLength(1);
	});

	test("update before start creates a running card, later end finalizes it", () => {
		const s = apply(
			initialViewModel,
			{ type: "tool_execution_update", toolCallId: "c1", toolName: "bash", partialResult: "part" },
			{ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: "done" },
		);
		const tools = s.messages.filter(m => m.role === "tool");
		expect(tools).toHaveLength(1);
		expect(tools[0].toolRunning).toBe(false);
	});
});

describe("engine interruption (0.4)", () => {
	test("clears streaming flag and finalizes running tool cards", () => {
		const streaming = apply(
			initialViewModel,
			{ type: "agent_start" },
			{ type: "message_start", message: assistant("thinking") },
			{ type: "tool_execution_start", toolCallId: "c1", toolName: "bash" },
		);
		expect(streaming.streaming).toBe(true);

		const s = engineInterrupted(streaming, "Engine stopped");
		expect(s.streaming).toBe(false);
		expect(s.streamingAssistantId).toBeUndefined();
		const tool = s.messages.find(m => m.role === "tool");
		expect(tool?.toolRunning).toBe(false);
		expect(s.messages.at(-1)?.role).toBe("system");
		expect(s.messages.at(-1)?.text).toBe("Engine stopped");
	});
});

describe("session event parity", () => {
	test("renders compaction and retry outcomes with their exact result", () => {
		const state = apply(
			initialViewModel,
			{ type: "auto_compaction_start", reason: "overflow", action: "shake" },
			{ type: "auto_compaction_end", action: "shake", aborted: false, willRetry: true },
			{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1_000, errorMessage: "rate limited" },
			{ type: "auto_retry_end", success: false, attempt: 3, finalError: "quota exhausted" },
		);
		expect(state.messages.map(message => message.text)).toEqual([
			"Auto-shake completed; retrying the turn.",
			"Retry failed after 3 attempts: quota exhausted",
		]);
		expect(state.messages.at(-1)?.error).toBe(true);
	});

	test("renders fallback, TTSR, and todo payloads", () => {
		const state = apply(
			initialViewModel,
			{ type: "retry_fallback_applied", from: "primary", to: "fallback", role: "worker" },
			{ type: "retry_fallback_succeeded", model: "fallback", role: "worker" },
			{ type: "ttsr_triggered", rules: [{ name: "no-secrets" }] },
			{
				type: "todo_reminder",
				todos: [{ content: "Run tests", status: "pending" }],
				attempt: 1,
				maxAttempts: 2,
			},
		);
		expect(state.messages.map(message => message.text)).toEqual([
			"Fallback for worker: primary → fallback.",
			"Fallback succeeded for worker on fallback.",
			"TTSR interrupted the turn: no-secrets",
			"Todo reminder (1/2). Run tests",
		]);
	});

	test("renders visible IRC messages and ignores hidden ones", () => {
		const state = apply(
			initialViewModel,
			{
				type: "irc_message",
				message: { role: "custom", customType: "irc", content: "Agent joined", display: true, timestamp: 1 },
			},
			{
				type: "irc_message",
				message: { role: "custom", customType: "irc", content: "hidden", display: false, timestamp: 2 },
			},
		);
		expect(state.messages.map(message => message.text)).toEqual(["[irc] Agent joined"]);
	});

	test("renders goal lifecycle and todo auto-clear updates", () => {
		const state = apply(
			initialViewModel,
			{
				type: "goal_updated",
				goal: {
					id: "goal-1",
					objective: "Finish desktop parity",
					status: "active",
					tokensUsed: 10,
					timeUsedSeconds: 5,
				},
			},
			{ type: "todo_auto_clear" },
			{ type: "goal_updated", goal: null },
		);
		expect(state.messages.map(message => message.text)).toEqual([
			"Goal active: Finish desktop parity",
			"Completed todos were cleared automatically.",
			"Goal mode cleared.",
		]);
	});
});

describe("assistant error passthrough", () => {
	test("provider error with no text surfaces the errorMessage", () => {
		const s = apply(initialViewModel, {
			type: "message_end",
			message: { role: "assistant", content: [], stopReason: "error", errorMessage: "boom" },
		});
		const a = s.messages.find(m => m.role === "assistant");
		expect(a?.error).toBe(true);
		expect(a?.text).toBe("boom");
	});
});

describe("user message append", () => {
	test("appendUserMessage adds a user row", () => {
		const s = appendUserMessage(initialViewModel, "hi");
		expect(s.messages.at(-1)).toMatchObject({ role: "user", text: "hi" });
	});
});
