import type { ChatMessage } from "./reducer";

const PREVIEW_TITLE_LENGTH = 90;
const PREVIEW_DETAIL_LENGTH = 170;

export interface SessionWorkTurn {
	id: string;
	targetMessageId: string;
	title: string;
	detail?: string;
	toolCount: number;
}

function snippet(text: string, limit: number): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= limit) return compact;
	return `${compact.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function transcriptMessageDomId(messageId: string): string {
	return `transcript-message-${encodeURIComponent(messageId)}`;
}

export function sessionWorkTurns(messages: readonly ChatMessage[]): SessionWorkTurn[] {
	const turns: SessionWorkTurn[] = [];
	let current: SessionWorkTurn | undefined;

	for (const message of messages) {
		const text = message.text.trim();
		if (message.role === "user" && text) {
			current = {
				id: message.id,
				targetMessageId: message.id,
				title: snippet(text, PREVIEW_TITLE_LENGTH),
				toolCount: 0,
			};
			turns.push(current);
			continue;
		}

		if (!current && (text || message.toolName)) {
			current = {
				id: message.id,
				targetMessageId: message.id,
				title: message.role === "tool" ? "Tool activity" : "Session activity",
				toolCount: 0,
			};
			turns.push(current);
		}
		if (!current) continue;

		if (message.role === "assistant" && text) {
			current.detail = snippet(text, PREVIEW_DETAIL_LENGTH);
			continue;
		}

		if (message.role === "tool" && (message.toolName || text)) {
			current.toolCount += 1;
			if (!current.detail) {
				current.detail = snippet(
					`${message.toolRunning ? "Running" : "Used"} ${message.toolName || "tool"}`,
					PREVIEW_DETAIL_LENGTH,
				);
			}
		}
	}

	return turns;
}

export function sessionWorkPreview(messages: readonly ChatMessage[]): SessionWorkTurn | undefined {
	return sessionWorkTurns(messages).at(-1);
}
