import { describe, expect, test } from "bun:test";
import { MCPManager } from "../src/mcp/manager";
import { resolveRpcMcpOAuthEndpoints } from "../src/mcp/rpc-oauth";

describe("RPC MCP OAuth", () => {
	test("rejects stdio transports before opening a browser or touching credentials", async () => {
		const manager = new MCPManager(process.cwd());
		await expect(
			resolveRpcMcpOAuthEndpoints(manager, { type: "stdio", command: "mcp-remote", args: ["https://example.test"] }),
		).rejects.toThrow("requires an HTTP or SSE server transport");
	});
});
