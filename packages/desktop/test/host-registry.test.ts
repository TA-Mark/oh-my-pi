import { describe, expect, test } from "bun:test";
import { executeDesktopHostTool, parseDesktopHostRegistry, resolveWorkspaceHostUri } from "../src/lib/host-registry";
import type { DesktopHostToolConfig, HostToolCallRequest, WorkspaceFileContent } from "../src/lib/rpc-protocol";

function config(action: DesktopHostToolConfig["action"]): DesktopHostToolConfig {
	return {
		name: `desktop_${action}`,
		description: action,
		parameters: { type: "object" },
		action,
		requiresApproval: true,
	};
}

function request(toolName: string, args: Record<string, unknown>): HostToolCallRequest {
	return { type: "host_tool_call", id: "host-1", toolCallId: "call-1", toolName, arguments: args };
}

function file(path: string, content: string): WorkspaceFileContent {
	return { path, content, size: content.length, truncated: false };
}

describe("Electron host registry", () => {
	test("parses persisted registry conservatively and keeps approval enabled by default", () => {
		const parsed = parseDesktopHostRegistry({
			workspaceUriEnabled: true,
			tools: [
				{ name: "safe", description: "Safe", parameters: { type: "object" }, action: "copy_text" },
				{ name: "bad", description: "Bad", parameters: [], action: "copy_text" },
				{ name: "unknown", description: "Unknown", parameters: {}, action: "shell" },
			],
		});
		expect(parsed.workspaceUriEnabled).toBe(true);
		expect(parsed.tools).toHaveLength(1);
		expect(parsed.tools[0]).toMatchObject({ name: "safe", action: "copy_text", requiresApproval: true });
	});

	test("executes only the mapped desktop action and returns a structured result", async () => {
		const opened: string[] = [];
		const result = await executeDesktopHostTool(
			config("open_external_url"),
			request("desktop_open_external_url", { url: "https://omp.sh/" }),
			{
				openExternalUrl: async url => {
					opened.push(url);
				},
				revealItem: async () => {},
				writeClipboardText: async () => {},
				readWorkspaceFile: async path => file(path, "unused"),
			},
		);
		expect(opened).toEqual(["https://omp.sh/"]);
		expect(result.content).toEqual([{ type: "text", text: "Opened https://omp.sh/" }]);
	});

	test("rejects malformed tool arguments before invoking the host", async () => {
		let called = false;
		await expect(
			executeDesktopHostTool(config("copy_text"), request("desktop_copy_text", {}), {
				openExternalUrl: async () => {},
				revealItem: async () => {},
				writeClipboardText: async () => {
					called = true;
				},
				readWorkspaceFile: async path => file(path, "unused"),
			}),
		).rejects.toThrow('argument "text"');
		expect(called).toBe(false);
	});

	test("workspace URI resolves a normalized relative path through the guarded file RPC", async () => {
		const paths: string[] = [];
		const result = await resolveWorkspaceHostUri(
			{ type: "host_uri_request", id: "uri-1", operation: "read", url: "workspace:///docs/README.md" },
			async path => {
				paths.push(path);
				return file(path, "hello");
			},
		);
		expect(paths).toEqual(["docs/README.md"]);
		expect(result).toMatchObject({ content: "hello", contentType: "text/plain", immutable: false });
	});

	test("workspace URI rejects writes before touching the workspace", async () => {
		let called = false;
		await expect(
			resolveWorkspaceHostUri(
				{ type: "host_uri_request", id: "uri-2", operation: "write", url: "workspace:///README.md", content: "x" },
				async path => {
					called = true;
					return file(path, "unused");
				},
			),
		).rejects.toThrow("read-only");
		expect(called).toBe(false);
	});
});
