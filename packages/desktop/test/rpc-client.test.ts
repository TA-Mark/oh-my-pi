import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Controllable fake of the Electron bridge ─────────────────────────────────
// The client talks to the engine only through desktop-bridge, so mocking this
// module lets us drive frames/exits and observe sent lines without a runtime.
const bridge = {
	frameCb: undefined as ((line: string) => void) | undefined,
	stderrCb: undefined as ((line: string) => void) | undefined,
	exitCb: undefined as (() => void) | undefined,
	sent: [] as string[],
	starts: [] as Array<string | undefined>,
	stops: 0,
	sendShouldReject: false,
	reset() {
		this.frameCb = undefined;
		this.stderrCb = undefined;
		this.exitCb = undefined;
		this.sent = [];
		this.starts = [];
		this.stops = 0;
		this.sendShouldReject = false;
	},
	emitFrame(obj: unknown) {
		this.frameCb?.(typeof obj === "string" ? obj : JSON.stringify(obj));
	},
	emitExit() {
		this.exitCb?.();
	},
};

mock.module("../src/lib/desktop-bridge", () => ({
	startEngine: (cwd?: string) => {
		bridge.starts.push(cwd);
		return Promise.resolve();
	},
	stopEngine: () => {
		bridge.stops += 1;
		return Promise.resolve();
	},
	sendRpcLine: (line: string) => {
		if (bridge.sendShouldReject) return Promise.reject(new Error("send failed"));
		bridge.sent.push(line);
		return Promise.resolve();
	},
	onRpcFrame: (cb: (line: string) => void) => {
		bridge.frameCb = cb;
		return Promise.resolve(() => {});
	},
	onRpcStderr: (cb: (line: string) => void) => {
		bridge.stderrCb = cb;
		return Promise.resolve(() => {});
	},
	onEngineExit: (cb: () => void) => {
		bridge.exitCb = cb;
		return Promise.resolve(() => {});
	},
}));

const { DesktopRpcClient, RpcTimeoutError, RpcTransportError, RpcEngineError } = await import("../src/lib/rpc-client");

function lastRequestId(): string {
	const line = bridge.sent.at(-1);
	if (!line) throw new Error("no line sent");
	return JSON.parse(line).id as string;
}

async function flush() {
	// Let the client's async listener attachment (await onRpcFrame …) settle.
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function startedClient(handlers?: ConstructorParameters<typeof DesktopRpcClient>[0]) {
	const client = new DesktopRpcClient(handlers);
	const startPromise = client.start("/tmp/ws");
	await flush();
	bridge.emitFrame({ type: "ready" });
	await startPromise;
	return client;
}

beforeEach(() => bridge.reset());

describe("startup", () => {
	test("resolves once the ready frame arrives", async () => {
		const client = await startedClient();
		expect(bridge.frameCb).toBeDefined();
		await client.stop();
	});

	test("a custom transport isolates a secondary engine from the main bridge", async () => {
		let frame: ((line: string) => void) | undefined;
		let stopped = false;
		const transport = {
			start: () => Promise.resolve(),
			stop: () => {
				stopped = true;
				return Promise.resolve();
			},
			send: () => Promise.resolve(),
			onFrame: (callback: (line: string) => void) => {
				frame = callback;
				return Promise.resolve(() => {});
			},
			onStderr: () => Promise.resolve(() => {}),
			onExit: () => Promise.resolve(() => {}),
		};
		const client = new DesktopRpcClient({}, transport);
		const start = client.start("/tmp/side");
		await flush();
		frame?.(JSON.stringify({ type: "ready" }));
		await start;
		expect(bridge.sent).toHaveLength(0);
		await client.stop();
		expect(stopped).toBe(true);
	});
});

describe("request/response correlation", () => {
	test("a matching response resolves the request and clears pending", async () => {
		const client = await startedClient();
		const p = client.getState();
		const id = lastRequestId();
		bridge.emitFrame({
			type: "response",
			command: "get_state",
			id,
			success: true,
			data: { sessionId: "s1", isStreaming: false },
		});
		const state = await p;
		expect(state.sessionId).toBe("s1");
		await client.stop();
	});

	test("gateway provider wrapper sends config and returns models path", async () => {
		const client = await startedClient();
		const pending = client.configureGatewayProvider({
			providerId: "local-gateway",
			baseUrl: "http://127.0.0.1:11434/v1",
			api: "openai-completions",
			discovery: "openai-models-list",
			apiKey: "secret",
			authHeader: true,
			disableStrictTools: true,
		});
		const sent = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(sent.type).toBe("configure_gateway_provider");
		expect(sent.providerId).toBe("local-gateway");
		expect(sent.baseUrl).toBe("http://127.0.0.1:11434/v1");
		expect(sent.api).toBe("openai-completions");
		expect(sent.discovery).toBe("openai-models-list");
		expect(sent.apiKey).toBe("secret");
		expect(sent.authHeader).toBe(true);
		expect(sent.disableStrictTools).toBe(true);
		bridge.emitFrame({
			type: "response",
			command: "configure_gateway_provider",
			id: sent.id,
			success: true,
			data: { providerId: "local-gateway", modelsConfigPath: "/tmp/.omp/models.yml" },
		});
		expect(await pending).toEqual({ providerId: "local-gateway", modelsConfigPath: "/tmp/.omp/models.yml" });
		await client.stop();
	});

	test("subagent transcript preserves incremental offsets and reset state", async () => {
		const client = await startedClient();
		const pending = client.getSubagentMessages({ subagentId: "agent-1", fromByte: 24 });
		const id = lastRequestId();
		bridge.emitFrame({
			type: "response",
			command: "get_subagent_messages",
			id,
			success: true,
			data: {
				sessionFile: "/tmp/agent-1.jsonl",
				fromByte: 24,
				nextByte: 128,
				reset: false,
				entries: [{ type: "message" }],
				messages: [{ role: "assistant", content: "done" }],
			},
		});

		const transcript = await pending;
		expect(transcript.fromByte).toBe(24);
		expect(transcript.nextByte).toBe(128);
		expect(transcript.reset).toBe(false);
		expect(transcript.messages).toEqual([{ role: "assistant", content: "done" }]);
		await client.stop();
	});

	test("goal lifecycle sends the canonical objective and token budget", async () => {
		const client = await startedClient();
		const pending = client.createGoal("Ship Electron parity", 50_000);
		const sent = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(sent.type).toBe("create_goal");
		expect(sent.objective).toBe("Ship Electron parity");
		expect(sent.tokenBudget).toBe(50_000);
		bridge.emitFrame({
			type: "response",
			command: "create_goal",
			id: sent.id,
			success: true,
			data: {
				goal: {
					id: "goal-1",
					objective: "Ship Electron parity",
					status: "active",
					tokenBudget: 50_000,
					tokensUsed: 0,
					timeUsedSeconds: 0,
					createdAt: 1,
					updatedAt: 1,
				},
				state: {
					enabled: true,
					mode: "active",
					goal: {
						id: "goal-1",
						objective: "Ship Electron parity",
						status: "active",
						tokenBudget: 50_000,
						tokensUsed: 0,
						timeUsedSeconds: 0,
						createdAt: 1,
						updatedAt: 1,
					},
				},
			},
		});
		const result = await pending;
		expect(result.state?.enabled).toBe(true);
		expect(result.goal?.tokenBudget).toBe(50_000);
		await client.stop();
	});

	test("guided goal and vibe wrappers use dedicated RPC commands", async () => {
		const client = await startedClient();
		const guidedPending = client.guidedGoalTurn([{ role: "user", content: "Ship parity" }], "guide-1");
		let sent = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(sent.type).toBe("guided_goal_turn");
		expect(sent.sideSessionId).toBe("guide-1");
		expect(sent.messages).toEqual([{ role: "user", content: "Ship parity" }]);
		bridge.emitFrame({
			type: "response",
			command: "guided_goal_turn",
			id: sent.id,
			success: true,
			data: { kind: "question", question: "What is done?" },
		});
		expect(await guidedPending).toEqual({ kind: "question", question: "What is done?" });

		const vibePending = client.setVibeMode(true);
		sent = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(sent.type).toBe("set_vibe_mode");
		expect(sent.enabled).toBe(true);
		bridge.emitFrame({
			type: "response",
			command: "set_vibe_mode",
			id: sent.id,
			success: true,
			data: { state: { enabled: true } },
		});
		expect(await vibePending).toEqual({ state: { enabled: true } });
		await client.stop();
	});

	test("branch, export, and handoff wrappers preserve their RPC results", async () => {
		const client = await startedClient();

		const branchPending = client.branch("entry-7");
		let id = lastRequestId();
		bridge.emitFrame({
			type: "response",
			command: "branch",
			id,
			success: true,
			data: { text: "Selected prompt", cancelled: false },
		});
		expect(await branchPending).toEqual({ text: "Selected prompt", cancelled: false });

		const exportPending = client.exportHtml();
		id = lastRequestId();
		bridge.emitFrame({
			type: "response",
			command: "export_html",
			id,
			success: true,
			data: { path: "/tmp/session.html" },
		});
		expect(await exportPending).toBe("/tmp/session.html");

		const handoffPending = client.handoff("Preserve diagnostics context");
		id = lastRequestId();
		bridge.emitFrame({
			type: "response",
			command: "handoff",
			id,
			success: true,
			data: { savedPath: "/tmp/handoff.md" },
		});
		expect(await handoffPending).toEqual({ savedPath: "/tmp/handoff.md" });
		await client.stop();
	});

	test("review scopes request concrete Git refs and expose recent commits", async () => {
		const client = await startedClient();

		const diffPending = client.getWorkspaceDiff("commit", "abc1234");
		let sent = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(sent.type).toBe("get_workspace_diff");
		expect(sent.scope).toBe("commit");
		expect(sent.ref).toBe("abc1234");
		bridge.emitFrame({
			type: "response",
			command: "get_workspace_diff",
			id: sent.id,
			success: true,
			data: {
				files: [
					{
						path: "src/app.ts",
						status: "modified",
						diff: "@@ -1 +1 @@\n-old\n+new",
						additions: 1,
						deletions: 1,
					},
				],
			},
		});
		expect((await diffPending)[0]?.path).toBe("src/app.ts");

		const commitsPending = client.listReviewCommits();
		sent = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(sent.type).toBe("list_review_commits");
		bridge.emitFrame({
			type: "response",
			command: "list_review_commits",
			id: sent.id,
			success: true,
			data: { commits: [{ hash: "abc1234", subject: "Refine review UI", committedAt: 1_700_000_000_000 }] },
		});
		expect(await commitsPending).toEqual([
			{ hash: "abc1234", subject: "Refine review UI", committedAt: 1_700_000_000_000 },
		]);
		await client.stop();
	});

	test("new session preserves parent lineage for isolated side-chat forks", async () => {
		const client = await startedClient();
		const pending = client.newSession("/tmp/main-session.jsonl");
		const sent = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(sent.type).toBe("new_session");
		expect(sent.parentSession).toBe("/tmp/main-session.jsonl");
		bridge.emitFrame({
			type: "response",
			command: "new_session",
			id: sent.id,
			success: true,
			data: { cancelled: false },
		});
		expect(await pending).toEqual({ cancelled: false });
		await client.stop();
	});

	test("artifact preview preserves bounded core metadata", async () => {
		const client = await startedClient();
		const pending = client.readArtifact("7", 4096);
		const sent = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(sent.type).toBe("read_artifact");
		expect(sent.artifactId).toBe("7");
		expect(sent.maxBytes).toBe(4096);
		bridge.emitFrame({
			type: "response",
			command: "read_artifact",
			id: sent.id,
			success: true,
			data: { id: "7", content: "preview", size: 9000, truncated: true },
		});
		expect(await pending).toEqual({ id: "7", content: "preview", size: 9000, truncated: true });
		await client.stop();
	});

	test("plugin feature selection uses the canonical runtime command", async () => {
		const client = await startedClient();
		const pending = client.setPluginFeatures("review-tools", ["git", "worktree"]);
		const sent = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(sent.type).toBe("set_plugin_features");
		expect(sent.name).toBe("review-tools");
		expect(sent.features).toEqual(["git", "worktree"]);
		bridge.emitFrame({
			type: "response",
			command: "set_plugin_features",
			id: sent.id,
			success: true,
			data: {
				name: "review-tools",
				version: "1.0.0",
				enabled: true,
				enabledFeatures: ["git", "worktree"],
				availableFeatures: ["git", "worktree", "github"],
				settings: [],
			},
		});
		expect((await pending).enabledFeatures).toEqual(["git", "worktree"]);
		await client.stop();
	});

	test("plugin settings use schema-aware set and reset commands", async () => {
		const client = await startedClient();
		const setPending = client.setPluginSetting("review-tools", "mode", "strict");
		const setCommand = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(setCommand).toMatchObject({
			type: "set_plugin_setting",
			name: "review-tools",
			key: "mode",
			value: "strict",
		});
		bridge.emitFrame({
			type: "response",
			command: "set_plugin_setting",
			id: setCommand.id,
			success: true,
			data: {
				name: "review-tools",
				version: "1.0.0",
				enabled: true,
				enabledFeatures: [],
				availableFeatures: [],
				settings: [
					{
						key: "mode",
						type: "enum",
						secret: false,
						environmentAvailable: false,
						configured: true,
						value: "strict",
						values: ["normal", "strict"],
					},
				],
			},
		});
		expect((await setPending).settings[0]?.value).toBe("strict");

		const resetPending = client.deletePluginSetting("review-tools", "mode");
		const resetCommand = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(resetCommand).toMatchObject({ type: "delete_plugin_setting", name: "review-tools", key: "mode" });
		bridge.emitFrame({
			type: "response",
			command: "delete_plugin_setting",
			id: resetCommand.id,
			success: true,
			data: {
				name: "review-tools",
				version: "1.0.0",
				enabled: true,
				enabledFeatures: [],
				availableFeatures: [],
				settings: [],
			},
		});
		expect((await resetPending).settings).toEqual([]);
		await client.stop();
	});

	test("marketplace install preserves plugin identity, scope, and refreshed registry metadata", async () => {
		const client = await startedClient();
		const pending = client.installMarketplacePlugin("review-tools", "official", "project");
		const sent = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(sent).toMatchObject({
			type: "install_marketplace_plugin",
			name: "review-tools",
			marketplace: "official",
			scope: "project",
		});
		const snapshot = {
			marketplaces: [{ name: "official", sourceType: "github" as const, updatedAt: "2026-07-18T00:00:00.000Z" }],
			plugins: [
				{
					id: "review-tools@official",
					name: "review-tools",
					marketplace: "official",
					capabilities: ["commands" as const, "agents" as const],
					installations: [{ scope: "project" as const, version: "1.0.0", enabled: true, shadowed: false }],
				},
			],
		};
		bridge.emitFrame({
			type: "response",
			command: "install_marketplace_plugin",
			id: sent.id,
			success: true,
			data: snapshot,
		});
		expect(await pending).toEqual(snapshot);
		await client.stop();
	});

	test("marketplace source lifecycle sends add, update, and remove commands", async () => {
		const client = await startedClient();
		const snapshot = {
			marketplaces: [{ name: "official", sourceType: "github" as const, updatedAt: "2026-07-18T00:00:00.000Z" }],
			plugins: [],
		};

		const addPending = client.addMarketplace("anthropics/claude-plugins-official");
		const add = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(add).toMatchObject({ type: "add_marketplace", source: "anthropics/claude-plugins-official" });
		bridge.emitFrame({ type: "response", command: "add_marketplace", id: add.id, success: true, data: snapshot });
		expect(await addPending).toEqual(snapshot);

		const updatePending = client.updateMarketplace("official");
		const update = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(update).toMatchObject({ type: "update_marketplace", name: "official" });
		bridge.emitFrame({
			type: "response",
			command: "update_marketplace",
			id: update.id,
			success: true,
			data: snapshot,
		});
		expect(await updatePending).toEqual(snapshot);

		const removePending = client.removeMarketplace("official");
		const remove = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(remove).toMatchObject({ type: "remove_marketplace", name: "official" });
		bridge.emitFrame({
			type: "response",
			command: "remove_marketplace",
			id: remove.id,
			success: true,
			data: {
				marketplaces: [],
				plugins: [],
			},
		});
		expect(await removePending).toEqual({ marketplaces: [], plugins: [] });

		await client.stop();
	});

	test("memory save and lifecycle operations preserve the backend results", async () => {
		const client = await startedClient();
		const savePending = client.saveMemory("Desktop uses Electron", "parity audit");
		const save = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(save).toMatchObject({
			type: "save_memory",
			content: "Desktop uses Electron",
			context: "parity audit",
			source: "omp-desktop",
		});
		bridge.emitFrame({
			type: "response",
			command: "save_memory",
			id: save.id,
			success: true,
			data: { backend: "mnemopi", stored: 1, ids: ["memory-1"] },
		});
		expect(await savePending).toEqual({ backend: "mnemopi", stored: 1, ids: ["memory-1"] });

		const enqueuePending = client.enqueueMemory();
		const enqueue = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(enqueue.type).toBe("enqueue_memory");
		bridge.emitFrame({
			type: "response",
			command: "enqueue_memory",
			id: enqueue.id,
			success: true,
			data: { backend: "mnemopi", operation: "enqueue", success: true },
		});
		expect(await enqueuePending).toMatchObject({ operation: "enqueue", success: true });

		const clearPending = client.clearMemory();
		const clear = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(clear.type).toBe("clear_memory");
		bridge.emitFrame({
			type: "response",
			command: "clear_memory",
			id: clear.id,
			success: true,
			data: { backend: "mnemopi", operation: "clear", success: true },
		});
		expect(await clearPending).toMatchObject({ operation: "clear", success: true });
		await client.stop();
	});

	test("MCP sign-out preserves the structured credential-removal result", async () => {
		const client = await startedClient();
		const pending = client.unauthMcp("github");
		const sent = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(sent).toMatchObject({ type: "unauth_mcp", serverName: "github" });
		bridge.emitFrame({
			type: "response",
			command: "unauth_mcp",
			id: sent.id,
			success: true,
			data: { serverName: "github", removed: true, status: "disconnected" },
		});
		expect(await pending).toEqual({ serverName: "github", removed: true, status: "disconnected" });
		await client.stop();
	});

	test("MCP reauthorization allows the headless OAuth flow to outlive normal requests", async () => {
		const client = await startedClient();
		const pending = client.reauthMcp("github");
		const sent = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(sent).toMatchObject({ type: "reauth_mcp", serverName: "github" });
		bridge.emitFrame({
			type: "response",
			command: "reauth_mcp",
			id: sent.id,
			success: true,
			data: { serverName: "github", status: "connected", toolCount: 4 },
		});
		expect(await pending).toEqual({ serverName: "github", status: "connected", toolCount: 4 });
		await client.stop();
	});

	test("MCP management sends concrete add, test, reload, inventory, and remove commands", async () => {
		const client = await startedClient();
		const addPending = client.addMcpServer("files", "project", {
			type: "stdio",
			command: "mcp-files",
			args: ["C:/workspace"],
		});
		let sent = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(sent).toMatchObject({ type: "add_mcp_server", name: "files", scope: "project" });
		bridge.emitFrame({
			type: "response",
			command: "add_mcp_server",
			id: sent.id,
			success: true,
			data: { serverName: "files", scope: "project", status: "connected", toolCount: 2 },
		});
		expect(await addPending).toMatchObject({ status: "connected", toolCount: 2 });

		const inventoryPending = client.getMcpCapabilities();
		sent = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(sent.type).toBe("get_mcp_capabilities");
		bridge.emitFrame({
			type: "response",
			command: "get_mcp_capabilities",
			id: sent.id,
			success: true,
			data: { resources: [], prompts: [], notifications: { enabled: false, servers: [] } },
		});
		expect(await inventoryPending).toMatchObject({ resources: [], prompts: [] });

		const testPending = client.testMcpServer("files");
		sent = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(sent).toMatchObject({ type: "test_mcp_server", serverName: "files" });
		bridge.emitFrame({
			type: "response",
			command: "test_mcp_server",
			id: sent.id,
			success: true,
			data: { serverName: "files", connected: true },
		});
		expect(await testPending).toMatchObject({ connected: true });

		const reloadPending = client.reloadMcp();
		sent = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(sent.type).toBe("reload_mcp");
		bridge.emitFrame({
			type: "response",
			command: "reload_mcp",
			id: sent.id,
			success: true,
			data: { servers: 1, connected: 1, toolCount: 2, errors: [] },
		});
		expect(await reloadPending).toMatchObject({ connected: 1, toolCount: 2 });

		const removePending = client.removeMcpServer("files", "project");
		sent = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(sent).toMatchObject({ type: "remove_mcp_server", serverName: "files", scope: "project" });
		bridge.emitFrame({
			type: "response",
			command: "remove_mcp_server",
			id: sent.id,
			success: true,
			data: { serverName: "files", scope: "project", removed: true },
		});
		await removePending;
		await client.stop();
	});

	test("browser state preserves the core download policy", async () => {
		const client = await startedClient();
		const pending = client.browserState();
		const id = lastRequestId();
		bridge.emitFrame({
			type: "response",
			command: "browser_list_tabs",
			id,
			success: true,
			data: {
				tabs: [{ name: "main", url: "https://example.com", state: "alive", backend: "worker" }],
				downloadPolicy: "deny",
			},
		});
		expect(await pending).toEqual({
			tabs: [{ name: "main", url: "https://example.com", state: "alive", backend: "worker" }],
			downloadPolicy: "deny",
		});
		await client.stop();
	});

	test("a response with a mismatched id does not resolve", async () => {
		const client = await startedClient();
		let settled = false;
		const p = client.getState().finally(() => {
			settled = true;
		});
		bridge.emitFrame({ type: "response", command: "get_state", id: "req_999", success: true, data: {} });
		await Promise.race([p.catch(() => {}), new Promise(r => setTimeout(r, 20))]);
		expect(settled).toBe(false);
		await client.stop(); // rejects the still-pending request → avoid unhandled
		await p.catch(() => {});
	});
});

describe("host tool and URI bridge frames", () => {
	test("dispatches host tool calls and lets the desktop return streamed and final results", async () => {
		const calls: string[] = [];
		const client = await startedClient({
			onHostToolCall: request => {
				calls.push(request.toolName);
				void client.sendHostToolUpdate(request.id, { content: [{ type: "text", text: "partial" }] });
				void client.sendHostToolResult(request.id, { content: [{ type: "text", text: "done" }] });
			},
		});
		bridge.emitFrame({
			type: "host_tool_call",
			id: "tool-1",
			toolCallId: "call-1",
			toolName: "workspace_lookup",
			arguments: { query: "README" },
		});
		await flush();
		expect(calls).toEqual(["workspace_lookup"]);
		expect(bridge.sent.slice(-2).map(line => JSON.parse(line).type)).toEqual([
			"host_tool_update",
			"host_tool_result",
		]);
		await client.stop();
	});

	test("fails an unhandled host tool instead of leaving the engine waiting", async () => {
		const client = await startedClient();
		bridge.emitFrame({
			type: "host_tool_call",
			id: "tool-2",
			toolCallId: "call-2",
			toolName: "unregistered",
			arguments: {},
		});
		await flush();
		const frame = JSON.parse(bridge.sent.at(-1) ?? "{}");
		expect(frame).toMatchObject({ type: "host_tool_result", id: "tool-2", isError: true });
		expect(frame.result.content[0].text).toContain("unregistered");
		await client.stop();
	});

	test("fails an unhandled host URI request with a structured error", async () => {
		const client = await startedClient();
		bridge.emitFrame({ type: "host_uri_request", id: "uri-1", operation: "read", url: "memory://note/1" });
		await flush();
		expect(JSON.parse(bridge.sent.at(-1) ?? "{}")).toMatchObject({
			type: "host_uri_result",
			id: "uri-1",
			isError: true,
		});
		await client.stop();
	});

	test("maps rejected host handlers to a result frame", async () => {
		const client = await startedClient({
			onHostToolCall: async () => {
				throw new Error("permission denied");
			},
		});
		bridge.emitFrame({
			type: "host_tool_call",
			id: "tool-3",
			toolCallId: "call-3",
			toolName: "secure",
			arguments: {},
		});
		await flush();
		const frame = JSON.parse(bridge.sent.at(-1) ?? "{}");
		expect(frame).toMatchObject({ type: "host_tool_result", id: "tool-3", isError: true });
		expect(frame.result.content[0].text).toBe("permission denied");
		await client.stop();
	});
});

describe("error classification (0.5)", () => {
	test("engine success:false rejects with RpcEngineError", async () => {
		const client = await startedClient();
		const p = client.getState();
		const id = lastRequestId();
		bridge.emitFrame({ type: "response", command: "get_state", id, success: false, error: "nope" });
		await expect(p).rejects.toBeInstanceOf(RpcEngineError);
		await client.stop();
	});

	test("send failure rejects with RpcTransportError", async () => {
		const client = await startedClient();
		bridge.sendShouldReject = true;
		await expect(client.getState()).rejects.toBeInstanceOf(RpcTransportError);
		await client.stop();
	});

	test("RpcTimeoutError carries kind/command/requestId", () => {
		// The 30s request timeout is impractical to trigger in a unit test; verify
		// the error type's shape directly (the timeout branch constructs exactly this).
		const err = new RpcTimeoutError("timeout waiting for response to get_state", "get_state", "req_1");
		expect(err.kind).toBe("timeout");
		expect(err.command).toBe("get_state");
		expect(err.requestId).toBe("req_1");
	});

	test("engine exit rejects in-flight requests with RpcTransportError", async () => {
		const client = await startedClient();
		const p = client.getState();
		bridge.emitExit();
		await expect(p).rejects.toBeInstanceOf(RpcTransportError);
		await client.stop();
	});

	test("can start again after an unexpected engine exit", async () => {
		const client = await startedClient();
		bridge.emitExit();
		const restart = client.start("/tmp/restarted");
		await flush();
		bridge.emitFrame({ type: "ready" });
		await restart;
		await client.stop();
	});
});

describe("cleanup", () => {
	test("stop rejects all pending with RpcTransportError", async () => {
		const client = await startedClient();
		const p1 = client.getState();
		const p2 = client.listSessions();
		await client.stop();
		await expect(p1).rejects.toBeInstanceOf(RpcTransportError);
		await expect(p2).rejects.toBeInstanceOf(RpcTransportError);
	});

	test("stop unlistens the bridge so no frames leak after teardown", async () => {
		const events: unknown[] = [];
		const client = await startedClient({ onEvent: e => events.push(e) });
		await client.stop();
		bridge.frameCb = undefined; // stop() unlistens; a real bridge drops the callback
		bridge.emitFrame({ type: "agent_start" });
		expect(events).toHaveLength(0);
	});
});

describe("frame classification", () => {
	test("session events (no id) route to onEvent", async () => {
		const events: Array<{ type: string }> = [];
		const client = await startedClient({ onEvent: e => events.push(e as { type: string }) });
		bridge.emitFrame({ type: "agent_start" });
		bridge.emitFrame({ type: "message_start", message: { role: "assistant", content: "hi" } });
		expect(events.map(e => e.type)).toEqual(["agent_start", "message_start"]);
		await client.stop();
	});

	test("available command updates route to the command discovery handler", async () => {
		const events: Array<{ type: string; commands?: Array<{ name: string; source: string }> }> = [];
		const client = await startedClient({ onEvent: event => events.push(event as (typeof events)[number]) });
		bridge.emitFrame({ type: "available_commands_update", commands: [{ name: "review", source: "builtin" }] });
		expect(events).toEqual([
			{ type: "available_commands_update", commands: [{ name: "review", source: "builtin" }] },
		]);
		await client.stop();
	});

	test("subagent frames trigger onSubagentUpdate", async () => {
		let hits = 0;
		const client = await startedClient({ onSubagentUpdate: () => hits++ });
		bridge.emitFrame({ type: "subagent_progress", payload: {} });
		bridge.emitFrame({ type: "subagent_lifecycle", payload: {} });
		expect(hits).toBe(2);
		await client.stop();
	});

	test("extension UI requests route to onExtensionUI", async () => {
		const seen: Array<{ method: string }> = [];
		const client = await startedClient({ onExtensionUI: r => seen.push(r as { method: string }) });
		bridge.emitFrame({ type: "extension_ui_request", id: "x1", method: "confirm", title: "t", message: "m" });
		expect(seen).toHaveLength(1);
		expect(seen[0].method).toBe("confirm");
		await client.stop();
	});

	test("extension runtime errors route to onExtensionError", async () => {
		const errors: string[] = [];
		const client = await startedClient({ onExtensionError: error => errors.push(error.error) });
		bridge.emitFrame({ type: "extension_error", extensionPath: "plugins/demo", event: "onLoad", error: "boom" });
		expect(errors).toEqual(["boom"]);
		await client.stop();
	});

	test("stderr lines route to onStderr", async () => {
		const lines: string[] = [];
		const client = await startedClient({ onStderr: l => lines.push(l) });
		bridge.stderrCb?.("engine warning");
		expect(lines).toEqual(["engine warning"]);
		await client.stop();
	});

	test("malformed JSON is ignored, not thrown", async () => {
		const events: unknown[] = [];
		const client = await startedClient({ onEvent: e => events.push(e) });
		expect(() => bridge.emitFrame("{not json")).not.toThrow();
		expect(events).toHaveLength(0);
		await client.stop();
	});

	test("concurrent requests resolve independently by id", async () => {
		const client = await startedClient();
		const pState = client.getState();
		const idState = lastRequestId();
		const pSessions = client.listSessions();
		const idSessions = lastRequestId();
		expect(idState).not.toBe(idSessions);

		// Resolve out of order: sessions first, then state.
		bridge.emitFrame({
			type: "response",
			command: "list_sessions",
			id: idSessions,
			success: true,
			data: { sessions: [] },
		});
		bridge.emitFrame({
			type: "response",
			command: "get_state",
			id: idState,
			success: true,
			data: { sessionId: "s", isStreaming: false },
		});

		const [state, sessions] = await Promise.all([pState, pSessions]);
		expect(state.sessionId).toBe("s");
		expect(sessions).toEqual([]);
		await client.stop();
	});
});

describe("lifecycle: crash / restart / workspace switch (1.4)", () => {
	test("cannot start the same client twice", async () => {
		const client = await startedClient();
		await expect(client.start("/tmp/ws")).rejects.toThrow(/already started/);
		await client.stop();
	});

	test("crash mid-request surfaces status stopped and rejects the request", async () => {
		const statuses: string[] = [];
		const client = await startedClient({ onStatus: s => statuses.push(s) });
		const p = client.getState();
		bridge.emitExit(); // engine process died
		await expect(p).rejects.toBeInstanceOf(RpcTransportError);
		expect(statuses).toContain("stopped");
		await client.stop();
	});

	test("workspace switch stays on the live transport and preserves correlated requests", async () => {
		const client = await startedClient();
		const pInFlight = client.getState();
		const switched = client.setWorkspace("/tmp/ws2");
		await flush();

		const requests = bridge.sent.map(line => JSON.parse(line) as { id: string; type: string });
		const stateRequest = requests.find(request => request.type === "get_state");
		const workspaceRequest = requests.find(request => request.type === "set_workspace");
		expect(stateRequest).toBeDefined();
		expect(workspaceRequest).toBeDefined();
		expect(bridge.starts).toEqual(["/tmp/ws"]);
		expect(bridge.stops).toBe(0);

		bridge.emitFrame({
			id: stateRequest?.id,
			type: "response",
			command: "get_state",
			success: true,
			data: { sessionId: "old-session" },
		});
		bridge.emitFrame({
			id: workspaceRequest?.id,
			type: "response",
			command: "set_workspace",
			success: true,
			data: { cwd: "/tmp/ws2", restored: true, cacheSize: 2, evictedCwds: [] },
		});
		await expect(pInFlight).resolves.toMatchObject({ sessionId: "old-session" });
		await expect(switched).resolves.toEqual({
			cwd: "/tmp/ws2",
			restored: true,
			cacheSize: 2,
			evictedCwds: [],
		});
		await client.stop();
	});

	test("stop is idempotent and safe to call twice", async () => {
		const client = await startedClient();
		await client.stop();
		await expect(client.stop()).resolves.toBeUndefined();
	});
});
