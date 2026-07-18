import { describe, expect, test } from "bun:test";
import {
	composePromptWithContext,
	contextBreakdownRows,
	describeContextWarning,
	estimateContextTokens,
} from "../src/components/ContextInspector";

describe("context inspector contract", () => {
	test("staged file mentions and selections are included in the outgoing prompt", () => {
		const prompt = composePromptWithContext("Review this", [
			{ id: "file", kind: "file", path: "src/app.tsx" },
			{ id: "selection", kind: "selection", path: "memory://record", content: "remember this decision" },
		]);
		expect(prompt).toBe("Review this\n\n@src/app.tsx\n\nmemory://record\nremember this decision");
	});

	test("token estimate accounts for staged text and images", () => {
		expect(
			estimateContextTokens(
				[{ id: "selection", kind: "selection", path: "src/app.tsx", content: "x".repeat(400) }],
				[{ type: "image", mimeType: "image/png", data: "AA==" }],
			),
		).toBe(1124);
	});

	test("authoritative core usage takes precedence over staged-token thresholds", () => {
		expect(describeContextWarning({ tokens: 90_000, contextWindow: 100_000, percent: 90 }, 100)).toEqual({
			danger: true,
			message: "Authoritative model context is 90% full and may require compaction.",
		});
		expect(describeContextWarning({ tokens: 10_000, contextWindow: 100_000, percent: 10 }, 48_000)).toEqual({
			danger: true,
			message: "Staged context is getting large and may require compaction.",
		});
	});

	test("maps the authoritative core breakdown without recomputing categories", () => {
		expect(
			contextBreakdownRows({
				contextWindow: 100_000,
				anchored: true,
				usedTokens: 50_000,
				systemPromptTokens: 1_000,
				systemToolsTokens: 2_000,
				systemContextTokens: 3_000,
				skillsTokens: 4_000,
				messagesTokens: 40_000,
			}),
		).toEqual([
			{ label: "System prompt", tokens: 1_000 },
			{ label: "Tools", tokens: 2_000 },
			{ label: "System context", tokens: 3_000 },
			{ label: "Skills", tokens: 4_000 },
			{ label: "Messages", tokens: 40_000 },
		]);
	});
});
