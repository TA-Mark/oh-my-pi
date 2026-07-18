import { describe, expect, test } from "bun:test";
import { artifactIdsFromMessage } from "../src/components/SubagentTranscript";
import type { SubagentMessagesSnapshot } from "../src/lib/rpc-protocol";
import { mergeSubagentTranscript } from "../src/lib/subagent-transcript";

function snapshot(fromByte: number, nextByte: number, label: string, reset = false): SubagentMessagesSnapshot {
	return {
		sessionFile: "agent.jsonl",
		fromByte,
		nextByte,
		reset,
		entries: [{ label }],
		messages: [{ role: "assistant", content: label }],
	};
}

describe("incremental subagent transcript", () => {
	test("appends complete deltas while preserving the original cursor", () => {
		const merged = mergeSubagentTranscript(snapshot(0, 20, "first"), snapshot(20, 40, "second"));
		expect(merged.fromByte).toBe(0);
		expect(merged.nextByte).toBe(40);
		expect(merged.messages).toHaveLength(2);
	});

	test("replaces accumulated data when the core reports truncation reset", () => {
		const replacement = snapshot(0, 12, "replacement", true);
		expect(mergeSubagentTranscript(snapshot(0, 40, "stale"), replacement)).toBe(replacement);
	});

	test("ignores duplicate or stale deltas", () => {
		const current = snapshot(0, 40, "current");
		expect(mergeSubagentTranscript(current, snapshot(40, 40, "empty"))).toBe(current);
	});

	test("discovers unique artifact references from message text and tool details", () => {
		expect(
			artifactIdsFromMessage({
				role: "toolResult",
				content: "Preview artifact://12 and artifact://12",
				details: { artifactId: "13" },
			}),
		).toEqual(["12", "13"]);
	});
});
