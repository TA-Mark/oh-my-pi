import { describe, expect, test } from "bun:test";
import { validateClipboardText, validateExternalUrl, validateHostArguments } from "../src/lib/host-policy";

describe("host permission policy", () => {
	test("allows only http(s) external URLs", () => {
		expect(validateExternalUrl("https://example.com")).toBeNull();
		expect(validateExternalUrl("javascript:alert(1)")).toBe("Only http(s) URLs are allowed");
	});

	test("rejects oversized host payloads and clipboard content", () => {
		expect(validateHostArguments({ value: "x".repeat(64 * 1024) })).toBe("Host tool arguments exceed 64 KiB");
		expect(validateClipboardText("x".repeat(1024 * 1024 + 1))).toBe("Clipboard text exceeds 1 MiB");
	});
});
