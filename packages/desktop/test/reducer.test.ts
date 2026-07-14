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
