import type { SubagentMessagesSnapshot } from "./rpc-protocol";

export function mergeSubagentTranscript(
	previous: SubagentMessagesSnapshot | null,
	next: SubagentMessagesSnapshot,
): SubagentMessagesSnapshot {
	if (!previous || next.reset || next.fromByte === 0) return next;
	if (next.nextByte <= previous.nextByte) return previous;
	return {
		...next,
		fromByte: previous.fromByte,
		entries: [...previous.entries, ...next.entries],
		messages: [...previous.messages, ...next.messages],
	};
}
