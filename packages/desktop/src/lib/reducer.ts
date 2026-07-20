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
	/**
	 * Id of the assistant message currently being streamed (between `message_start`
	 * and `message_end`), or undefined when no assistant turn is open. Streaming
	 * `message_update`/`message_end` frames carry no stable engine id, so the reducer
	 * owns this correlation: it targets the open assistant by id instead of blindly
	 * patching the last one, so interleaved streams can't overwrite each other.
	 */
	streamingAssistantId?: string;
}

export const initialViewModel: ViewModel = {
	messages: [],
	streaming: false,
	stderr: [],
	streamingAssistantId: undefined,
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

function summarize(value: unknown, maxLength = 240): string {
	if (typeof value === "string") return value.slice(0, maxLength);
	try {
		const text = JSON.stringify(value);
		return text ? text.slice(0, maxLength) : "";
	} catch {
		return "";
	}
}

function appendSystemNotice(state: ViewModel, text: string): ViewModel {
	return text ? { ...state, messages: [...state.messages, { id: newId("n"), role: "system", text }] } : state;
}

/** Assistant text + error state. Falls back to the provider errorMessage when the turn failed with no text. */
function assistantView(message: EngineMessage): { text: string; error: boolean; cancelled: boolean } {
	const text = messageText(message);
	const cancelled = message.stopReason === "aborted" && message.errorMessage === "Interrupted by user";
	if (cancelled) return { text, error: false, cancelled: true };
	const error = message.stopReason === "error" || Boolean(message.errorMessage);
	if (!text && message.errorMessage) return { text: message.errorMessage, error: true, cancelled: false };
	return { text, error, cancelled: false };
}

/**
 * Update the streaming assistant identified by `id`. When the id is unknown
 * (update/end arrived without a matching `message_start`), append a fresh
 * assistant row so a snapshot is never silently dropped.
 */
function updateAssistantById(
	messages: ChatMessage[],
	id: string,
	view: { text: string; error: boolean; cancelled: boolean },
): ChatMessage[] {
	let found = false;
	const next = messages
		.map(message => {
			if (message.id === id && message.role === "assistant") {
				found = true;
				if (view.cancelled && !view.text) return null;
				return { ...message, text: view.text, error: view.error };
			}
			return message;
		})
		.filter((message): message is ChatMessage => message !== null);
	if (found && view.cancelled && !view.text) return next;
	if (!found) next.push({ id, role: "assistant", text: view.text, error: view.error });
	return next;
}

/**
 * Patch the tool card keyed by `toolCallId`, creating one from `seed` if none
 * exists yet (an update/end arriving before/without its `start`). This mirrors
 * the persisted-replay path, which also synthesizes a fallback card.
 */
function patchTool(
	messages: ChatMessage[],
	toolCallId: string,
	patch: Partial<ChatMessage>,
	seed: Partial<ChatMessage>,
): ChatMessage[] {
	const id = `t_${toolCallId}`;
	let found = false;
	const next = messages.map(message => {
		if (message.id === id) {
			found = true;
			return { ...message, ...patch };
		}
		return message;
	});
	if (!found) next.push({ id, role: "tool", text: "", ...seed, ...patch });
	return next;
}

export function reduce(state: ViewModel, event: EngineEvent): ViewModel {
	switch (event.type) {
		case "agent_start":
			return { ...state, streaming: true };
		case "agent_end":
			return { ...state, streaming: false, streamingAssistantId: undefined };
		case "message_start": {
			if (event.message.role !== "assistant") return state;
			const view = assistantView(event.message);
			const id = newId("a");
			return {
				...state,
				streamingAssistantId: id,
				messages: [...state.messages, { id, role: "assistant", text: view.text, error: view.error }],
			};
		}
		case "message_update":
		case "message_end": {
			if (event.message.role !== "assistant") return state;
			// Target the open streaming assistant by id; fall back to opening a new
			// one if no message_start was seen (updateAssistantById appends).
			const id = state.streamingAssistantId ?? newId("a");
			const messages = updateAssistantById(state.messages, id, assistantView(event.message));
			return {
				...state,
				messages,
				streamingAssistantId: event.type === "message_end" ? undefined : id,
			};
		}
		case "tool_execution_start":
			// Dedupe: a repeated start for the same toolCallId updates the existing
			// card in place instead of appending a duplicate that later patches hit.
			return {
				...state,
				messages: patchTool(
					state.messages,
					event.toolCallId,
					{
						toolName: event.toolName,
						toolArgs: event.args,
						toolIntent: event.intent,
						toolRunning: true,
					},
					{ toolName: event.toolName, toolArgs: event.args, toolIntent: event.intent, toolRunning: true },
				),
			};
		case "tool_execution_update":
			return {
				...state,
				messages: patchTool(
					state.messages,
					event.toolCallId,
					{
						...(event.args !== undefined ? { toolArgs: event.args } : {}),
						toolPartial: resultText(event.partialResult) || undefined,
					},
					{ toolName: event.toolName, toolRunning: true },
				),
			};
		case "tool_execution_end":
			return {
				...state,
				messages: patchTool(
					state.messages,
					event.toolCallId,
					{
						toolResult: finalResult(event.result, event.isError),
						toolRunning: false,
						toolPartial: undefined,
					},
					{ toolName: event.toolName, toolRunning: false },
				),
			};
		case "notice": {
			const text = event.message ?? event.text ?? "";
			return appendSystemNotice(state, text);
		}
		case "auto_compaction_start":
			return appendSystemNotice(state, `Context compaction started (${event.action}, ${event.reason}).`);
		case "auto_compaction_end": {
			if (event.skipped) return appendSystemNotice(state, "Context compaction skipped.");
			if (event.errorMessage) return appendSystemNotice(state, `Context compaction failed: ${event.errorMessage}`);
			if (event.aborted) return appendSystemNotice(state, "Context compaction was cancelled.");
			return appendSystemNotice(
				state,
				event.willRetry ? "Context compacted; retrying the request." : "Context compaction completed.",
			);
		}
		case "auto_retry_start":
			return appendSystemNotice(
				state,
				`Retrying request (${event.attempt}/${event.maxAttempts}) in ${event.delayMs}ms: ${event.errorMessage}`,
			);
		case "auto_retry_end":
			return appendSystemNotice(
				state,
				event.success
					? `Retry recovered on attempt ${event.attempt}.`
					: `Retry failed after attempt ${event.attempt}${event.finalError ? `: ${event.finalError}` : "."}`,
			);
		case "retry_fallback_applied":
			return appendSystemNotice(state, `Retry fallback applied for ${event.role}: ${event.from} → ${event.to}.`);
		case "retry_fallback_succeeded":
			return appendSystemNotice(state, `Retry fallback succeeded for ${event.role} with ${event.model}.`);
		case "ttsr_triggered":
			return appendSystemNotice(
				state,
				`TTSR triggered (${event.rules.length} rule${event.rules.length === 1 ? "" : "s"}).`,
			);
		case "todo_reminder":
			return appendSystemNotice(
				state,
				`Todo reminder (${event.attempt}/${event.maxAttempts}): ${event.todos.length} item${event.todos.length === 1 ? "" : "s"} remain.`,
			);
		case "todo_auto_clear":
			return appendSystemNotice(state, "Todo list cleared automatically.");
		case "irc_message":
			return appendSystemNotice(state, `IRC message: ${summarize(event.message)}`);
		case "thinking_level_changed":
			return appendSystemNotice(
				state,
				`Thinking level changed to ${event.configured ?? event.thinkingLevel ?? event.resolved ?? "default"}.`,
			);
		case "goal_updated":
			return appendSystemNotice(
				state,
				event.goal === null ? "Goal cleared." : `Goal updated: ${summarize(event.goal)}`,
			);
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

/**
 * Transport-level interruption (engine exited or errored) with no `agent_end`.
 * Clears the streaming flag so the UI doesn't hang on a spinner, finalizes any
 * still-running tool cards as interrupted, and appends a system notice.
 */
export function engineInterrupted(state: ViewModel, reason: string): ViewModel {
	const messages = state.messages.map(message =>
		message.role === "tool" && message.toolRunning
			? {
					...message,
					toolRunning: false,
					toolPartial: undefined,
					toolResult: message.toolResult ?? { content: [{ type: "text", text: reason }], isError: true },
				}
			: message,
	);
	const lastMessage = messages.at(-1);
	const nextMessages =
		lastMessage?.role === "system" && lastMessage.text === reason
			? messages
			: [...messages, { id: newId("n"), role: "system" as const, text: reason }];
	return {
		...state,
		streaming: false,
		streamingAssistantId: undefined,
		messages: nextMessages,
	};
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
