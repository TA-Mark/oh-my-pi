import { describe, expect, test } from "bun:test";
import { canQueueComposer, canSubmitComposer } from "../src/components/Composer";

describe("composer submission contract", () => {
	test("requires non-empty text or an image while the engine is idle", () => {
		expect(canSubmitComposer(false, false, "", 0)).toBe(false);
		expect(canSubmitComposer(false, false, "  ", 0)).toBe(false);
		expect(canSubmitComposer(false, false, "build it", 0)).toBe(true);
		expect(canSubmitComposer(false, false, "", 1)).toBe(true);
	});

	test("blocks a second prompt while a turn is streaming or the engine is unavailable", () => {
		expect(canSubmitComposer(true, false, "build it", 0)).toBe(false);
		expect(canSubmitComposer(false, true, "follow up", 0)).toBe(false);
	});

	test("allows queue actions only while a turn is streaming", () => {
		expect(canQueueComposer(false, true, "guide the current turn", 0)).toBe(true);
		expect(canQueueComposer(false, true, "", 1)).toBe(true);
		expect(canQueueComposer(false, false, "follow up", 0)).toBe(false);
		expect(canQueueComposer(true, true, "follow up", 0)).toBe(false);
	});
});
