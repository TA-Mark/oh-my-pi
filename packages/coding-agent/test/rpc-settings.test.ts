import { describe, expect, test } from "bun:test";
import { Settings } from "../src/config/settings";
import { getRpcSettingDescriptor, setRpcSetting } from "../src/modes/rpc/rpc-settings";

describe("RPC settings contract", () => {
	test("updates an allowlisted setting and returns its normalized descriptor", async () => {
		const settings = Settings.isolated();
		const descriptor = await setRpcSetting(settings, "retry.enabled", false);
		expect(descriptor).toMatchObject({
			path: "retry.enabled",
			category: "retry",
			type: "boolean",
			value: false,
			configured: true,
		});
		expect(settings.get("retry.enabled")).toBe(false);
	});

	test("rejects values outside the canonical schema type", async () => {
		const settings = Settings.isolated();
		await expect(setRpcSetting(settings, "retry.maxRetries", "five")).rejects.toThrow(
			"retry.maxRetries must be a finite number",
		);
	});

	test("rejects paths outside the desktop configuration allowlist", async () => {
		const settings = Settings.isolated();
		await expect(setRpcSetting(settings, "setupVersion", "ignored")).rejects.toThrow(
			"Setting is not available over RPC: setupVersion",
		);
		await expect(setRpcSetting(settings, "not.real", true)).rejects.toThrow("Unknown setting: not.real");
	});

	test("never exposes secret-bearing settings", () => {
		const settings = Settings.isolated();
		expect(() => getRpcSettingDescriptor(settings, "auth.broker.token")).toThrow(
			"Setting is not available over RPC: auth.broker.token",
		);
	});

	test("keeps retry and compaction controls in their conceptual desktop tabs", () => {
		const settings = Settings.isolated();
		expect(getRpcSettingDescriptor(settings, "retry.maxRetries").category).toBe("retry");
		expect(getRpcSettingDescriptor(settings, "compaction.strategy").category).toBe("compaction");
		expect(getRpcSettingDescriptor(settings, "compaction.thresholdTokens")).toMatchObject({
			category: "compaction",
			type: "number",
		});
	});

	test("keeps MCP discovery controls in the MCP tab with restart activation", () => {
		const settings = Settings.isolated();
		expect(getRpcSettingDescriptor(settings, "mcp.enableProjectConfig")).toMatchObject({
			category: "mcp",
			activation: "next_engine_restart",
		});
		expect(getRpcSettingDescriptor(settings, "mcp.notifications")).toMatchObject({
			category: "mcp",
			activation: "immediate",
		});
	});

	test("exposes runtime file and model settings to GUI hosts", () => {
		const settings = Settings.isolated();
		expect(getRpcSettingDescriptor(settings, "read.defaultLimit").category).toBe("tools");
		expect(getRpcSettingDescriptor(settings, "lsp.enabled").category).toBe("tools");
		expect(getRpcSettingDescriptor(settings, "browser.enabled").category).toBe("tools");
	});
});
