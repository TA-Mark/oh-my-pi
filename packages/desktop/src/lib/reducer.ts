/**
 * Pure reducer: folds engine events into an immutable view model the React
 * layer renders. Handles streaming assistant text, tool lifecycle (args →
 * partial → result, fed to the reused collab-web ToolView), and notices.
 */
import type { ContentPart, EngineEvent, EngineMessage, ImageContent, SessionMessage } from "./rpc-protocol";

export type ChatRole = "user" | "assistant" | "tool" | "system";

export interface ChatMessage {
	id: string;
	role: ChatRole;
	text: string;
	/** Assistant turn failed (provider error) — render with error styling. */
	error?: boolean;
	/** Images attached to a user message (multimodal input). */
	images?: ImageContent[];
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
			.flatMap(part => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
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

/** Assistant text + error state. Falls back to the provider errorMessage when the turn failed with no text. */
function assistantView(message: EngineMessage): { text: string; error: boolean } {
	const text = messageText(message);
	const error = message.stopReason === "error" || Boolean(message.errorMessage);
	if (!text && message.errorMessage) return { text: message.errorMessage, error: true };
	return { text, error };
}

function updateLastAssistant(messages: ChatMessage[], view: { text: string; error: boolean }): ChatMessage[] {
	const next = [...messages];
	for (let i = next.length - 1; i >= 0; i--) {
		if (next[i].role === "assistant") {
			next[i] = { ...next[i], text: view.text, error: view.error };
			return next;
		}
	}
	next.push({ id: newId("a"), role: "assistant", text: view.text, error: view.error });
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
			const view = assistantView(event.message);
			return {
				...state,
				messages: [...state.messages, { id: newId("a"), role: "assistant", text: view.text, error: view.error }],
			};
		}
		case "message_update":
		case "message_end": {
			if (event.message.role !== "assistant") return state;
			return { ...state, messages: updateLastAssistant(state.messages, assistantView(event.message)) };
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

export function appendUserMessage(state: ViewModel, text: string, images?: ImageContent[]): ViewModel {
	return {
		...state,
		messages: [
			...state.messages,
			{ id: newId("u"), role: "user", text, images: images && images.length > 0 ? images : undefined },
		],
	};
}

export function appendStderr(state: ViewModel, line: string): ViewModel {
	return { ...state, stderr: [...state.stderr, line].slice(-200) };
}

/** Concatenate the text parts of a persisted message's content. */
function partsText(content: ContentPart[] | string | undefined): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap(part => (part.type === "text" ? [String(part.text ?? "")] : [])).join("");
}

/** Extract image parts from a persisted message's content (for re-seeded transcripts). */
function imageParts(content: ContentPart[] | string | undefined): ImageContent[] {
	if (!Array.isArray(content)) return [];
	const out: ImageContent[] = [];
	for (const part of content) {
		if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
			out.push({ type: "image", data: part.data, mimeType: part.mimeType });
		}
	}
	return out;
}

/**
 * Rebuild the transcript from a session's persisted messages (from `get_messages`).
 * Assistant messages carry inline `toolCall` parts (args); a later `toolResult`
 * message fills the matching card's result — the same pairing the streaming path
 * does via `toolCallId`.
 */
export function seedMessages(messages: SessionMessage[]): ViewModel {
	const out: ChatMessage[] = [];
	const toolIndex = new Map<string, number>();

	for (const message of messages) {
		if (message.role === "user") {
			const text = partsText(message.content);
			const images = imageParts(message.content);
			if (text || images.length > 0) {
				out.push({ id: newId("u"), role: "user", text, images: images.length > 0 ? images : undefined });
			}
			continue;
		}
		if (message.role === "assistant") {
			const view = assistantView({
				role: "assistant",
				content: (message.content as EngineMessage["content"]) ?? "",
				errorMessage: message.errorMessage,
				stopReason: message.stopReason,
			});
			if (view.text || view.error) {
				out.push({ id: newId("a"), role: "assistant", text: view.text, error: view.error });
			}
			if (Array.isArray(message.content)) {
				for (const part of message.content) {
					if (part.type !== "toolCall" || typeof part.id !== "string") continue;
					toolIndex.set(part.id, out.length);
					out.push({
						id: `t_${part.id}`,
						role: "tool",
						text: "",
						toolName: typeof part.name === "string" ? part.name : "tool",
						toolArgs: part.arguments,
						toolIntent: typeof part.intent === "string" ? part.intent : undefined,
						toolRunning: false,
					});
				}
			}
			continue;
		}
		if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			const at = toolIndex.get(message.toolCallId);
			const result = finalResult({ content: message.content, details: message.details }, message.isError);
			if (at !== undefined && out[at]) {
				out[at] = { ...out[at], toolResult: result, toolName: message.toolName ?? out[at].toolName };
			} else {
				out.push({
					id: `t_${message.toolCallId}`,
					role: "tool",
					text: "",
					toolName: message.toolName ?? "tool",
					toolResult: result,
					toolRunning: false,
				});
			}
		}
	}

	return { ...initialViewModel, messages: out };
}
