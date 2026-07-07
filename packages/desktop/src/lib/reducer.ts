/**
 * Pure reducer: folds engine events into an immutable view model the React
 * layer renders. Handles streaming assistant text, tool lifecycle (args →
 * partial → result, fed to the reused collab-web ToolView), and notices.
 */
import type { EngineEvent, EngineMessage } from "./rpc-protocol";

export type ChatRole = "user" | "assistant" | "tool" | "system";

export interface ChatMessage {
	id: string;
	role: ChatRole;
	text: string;
	/** Tool-only fields (role === "tool"), consumed by <ToolView>. */
	toolName?: string;
	toolArgs?: unknown;
	toolResult?: unknown;
	toolRunning?: boolean;
	toolIntent?: string;
	toolPartial?: string;
}

export interface ViewModel {
	messages: ChatMessage[];
	streaming: boolean;
	stderr: string[];
}

export const initialViewModel: ViewModel = {
	messages: [],
	streaming: false,
	stderr: [],
};

let seq = 0;
function newId(prefix: string): string {
	seq += 1;
	return `${prefix}_${seq}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Concatenate the text parts of an assistant message snapshot. */
function messageText(message: EngineMessage): string {
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("");
}

/** Extract a text tail from a (partial) tool result for the streaming preview. */
function resultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (isRecord(result) && Array.isArray(result.content)) {
		return result.content
			.flatMap(part =>
				isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
			)
			.join("");
	}
	return "";
}

/** Normalize a tool result into the `{ content, details?, isError? }` shape ToolView reads. */
function finalResult(result: unknown, isError?: boolean): unknown {
	if (isRecord(result)) {
		return isError && result.isError !== true ? { ...result, isError: true } : result;
	}
	if (typeof result === "string") {
		return { content: [{ type: "text", text: result }], isError: Boolean(isError) };
	}
	return { content: [], isError: Boolean(isError) };
}

function updateLastAssistant(messages: ChatMessage[], text: string): ChatMessage[] {
	const next = [...messages];
	for (let i = next.length - 1; i >= 0; i--) {
		if (next[i].role === "assistant") {
			next[i] = { ...next[i], text };
			return next;
		}
	}
	next.push({ id: newId("a"), role: "assistant", text });
	return next;
}

function patchTool(messages: ChatMessage[], toolCallId: string, patch: Partial<ChatMessage>): ChatMessage[] {
	const id = `t_${toolCallId}`;
	return messages.map(message => (message.id === id ? { ...message, ...patch } : message));
}

export function reduce(state: ViewModel, event: EngineEvent): ViewModel {
	switch (event.type) {
		case "agent_start":
			return { ...state, streaming: true };
		case "agent_end":
			return { ...state, streaming: false };
		case "message_start": {
			if (event.message.role !== "assistant") return state;
			return {
				...state,
				messages: [...state.messages, { id: newId("a"), role: "assistant", text: messageText(event.message) }],
			};
		}
		case "message_update":
		case "message_end": {
			if (event.message.role !== "assistant") return state;
			return { ...state, messages: updateLastAssistant(state.messages, messageText(event.message)) };
		}
		case "tool_execution_start":
			return {
				...state,
				messages: [
					...state.messages,
					{
						id: `t_${event.toolCallId}`,
						role: "tool",
						text: "",
						toolName: event.toolName,
						toolArgs: event.args,
						toolIntent: event.intent,
						toolRunning: true,
					},
				],
			};
		case "tool_execution_update":
			return {
				...state,
				messages: patchTool(state.messages, event.toolCallId, {
					...(event.args !== undefined ? { toolArgs: event.args } : {}),
					toolPartial: resultText(event.partialResult) || undefined,
				}),
			};
		case "tool_execution_end":
			return {
				...state,
				messages: patchTool(state.messages, event.toolCallId, {
					toolResult: finalResult(event.result, event.isError),
					toolRunning: false,
					toolPartial: undefined,
				}),
			};
		case "notice": {
			const text = event.message ?? event.text ?? "";
			if (!text) return state;
			return { ...state, messages: [...state.messages, { id: newId("n"), role: "system", text }] };
		}
		default:
			return state;
	}
}

export function appendUserMessage(state: ViewModel, text: string): ViewModel {
	return { ...state, messages: [...state.messages, { id: newId("u"), role: "user", text }] };
}

export function appendStderr(state: ViewModel, line: string): ViewModel {
	return { ...state, stderr: [...state.stderr, line].slice(-200) };
}
