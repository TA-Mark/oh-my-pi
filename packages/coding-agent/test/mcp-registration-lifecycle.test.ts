import { describe, expect, test } from "bun:test";
import { MCPManager, sanitizeMcpDiagnosticError } from "../src/mcp/manager";
import type { MCPStdioServerConfig } from "../src/mcp/types";

describe("MCP registration lifecycle", () => {
	test("redacts credentials before connection errors reach GUI status", () => {
		expect(
			sanitizeMcpDiagnosticError(
				"Bearer abc123 token=secret-value https://example.test/mcp?apiKey=top-secret&mode=connect",
			),
		).toBe("Bearer [redacted] token=[redacted] https://example.test/mcp?apiKey=[redacted]&mode=connect");
	});

	test("a UI disable disconnect preserves the known server for a later enable", async () => {
		const manager = new MCPManager(process.cwd());
		const config: MCPStdioServerConfig = {
			type: "stdio",
			command: process.execPath,
			enabled: false,
		};
		manager.setServerConfig("desktop-test", config);

		expect(manager.getStatusSnapshot()).toContainEqual(
			expect.objectContaining({
				name: "desktop-test",
				enabled: false,
				status: "disconnected",
				auth: expect.objectContaining({ credentialAvailable: false }),
			}),
		);
		await manager.disconnectServer("desktop-test", { preserveRegistration: true });
		expect(manager.getServerConfig("desktop-test")).toEqual(config);
		expect(manager.getAllServerNames()).toContain("desktop-test");

		await manager.disconnectServer("desktop-test");
		expect(manager.getServerConfig("desktop-test")).toBeUndefined();
		expect(manager.getAllServerNames()).not.toContain("desktop-test");
	});
});
