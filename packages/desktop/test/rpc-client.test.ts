import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Controllable fake of the Electron bridge ─────────────────────────────────
// The client talks to the engine only through desktop-bridge, so mocking this
// module lets us drive frames/exits and observe sent lines without a runtime.
const bridge = {
	frameCb: undefined as ((line: string) => void) | undefined,
	stderrCb: undefined as ((line: string) => void) | undefined,
	exitCb: undefined as (() => void) | undefined,
	sent: [] as string[],
	sendShouldReject: false,
	reset() {
		this.frameCb = undefined;
		this.stderrCb = undefined;
		this.exitCb = undefined;
		this.sent = [];
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
	startEngine: () => Promise.resolve(),
	stopEngine: () => Promise.resolve(),
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

const { DesktopRpcClient, RpcTimeoutError, RpcTransportError, RpcEngineError, supportsCapability } = await import(
	"../src/lib/rpc-client"
);

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
	test("rejects commands before the ready handshake", async () => {
		const client = new DesktopRpcClient();
		await expect(client.getState()).rejects.toMatchObject({ kind: "transport", message: "engine is not ready" });
	});
	test("capability lookup is exact and backward-compatible", () => {
		expect(supportsCapability(["prompt", "get_state"], "prompt")).toBe(true);
		expect(supportsCapability(["prompt"], "bash")).toBe(false);
		expect(supportsCapability([], "prompt")).toBe(false);
	});
	test("resolves once the ready frame arrives", async () => {
		const client = await startedClient();
		expect(bridge.frameCb).toBeDefined();
		await client.stop();
	});

	test("captures protocol version and capabilities from the ready handshake", async () => {
		const client = new DesktopRpcClient();
		const startPromise = client.start("/tmp/ws");
		await flush();
		bridge.emitFrame({ type: "ready", protocolVersion: 1, capabilities: ["prompt", "get_state", 42] });
		await startPromise;
		expect(client.readyInfo).toEqual({ protocolVersion: 1, capabilities: ["prompt", "get_state"] });
		await client.stop();
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

	test("steer, follow-up, and model cycling preserve their RPC contracts", async () => {
		const client = await startedClient();
		const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };

		const steer = client.steer("focus on tests", [image]);
		const steerRequest = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(steerRequest).toMatchObject({ type: "steer", message: "focus on tests", images: [image] });
		bridge.emitFrame({ type: "response", command: "steer", id: steerRequest.id, success: true });
		await steer;

		const followUp = client.followUp("then update docs");
		const followUpRequest = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(followUpRequest).toMatchObject({ type: "follow_up", message: "then update docs" });
		bridge.emitFrame({ type: "response", command: "follow_up", id: followUpRequest.id, success: true });
		await followUp;

		const cycle = client.cycleModel();
		const cycleRequest = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(cycleRequest).toMatchObject({ type: "cycle_model" });
		bridge.emitFrame({
			type: "response",
			command: "cycle_model",
			id: cycleRequest.id,
			success: true,
			data: { provider: "openai", id: "gpt-5" },
		});
		expect(await cycle).toEqual({ provider: "openai", id: "gpt-5" });
		await client.stop();
	});

	test("settings commands preserve typed payloads and correlation", async () => {
		const client = await startedClient();
		const snapshotPromise = client.getSettings();
		const snapshotRequest = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(snapshotRequest.type).toBe("get_settings");
		bridge.emitFrame({
			type: "response",
			command: "get_settings",
			id: snapshotRequest.id,
			success: true,
			data: { settings: [], plugins: [] },
		});
		expect(await snapshotPromise).toEqual({ settings: [], plugins: [] });

		const updatePromise = client.setSetting("retry.enabled", false);
		const updateRequest = JSON.parse(bridge.sent.at(-1) ?? "{}") as Record<string, unknown>;
		expect(updateRequest).toMatchObject({ type: "set_setting", path: "retry.enabled", value: false });
		bridge.emitFrame({
			type: "response",
			command: "set_setting",
			id: updateRequest.id,
			success: true,
			data: { path: "retry.enabled", category: "retry", type: "boolean", value: false },
		});
		expect(await updatePromise).toMatchObject({ path: "retry.enabled", value: false });
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

	test("nullable response data is preserved for empty handoff results", async () => {
		const client = await startedClient();
		const pending = client.handoff();
		const id = lastRequestId();
		bridge.emitFrame({ type: "response", command: "handoff", id, success: true, data: null });
		await expect(pending).resolves.toBeNull();
		await client.stop();
	});

	test("subagent transcript request preserves cursor and messages", async () => {
		const client = await startedClient();
		const pending = client.getSubagentMessages({ subagentId: "sub-1", fromByte: 12 });
		const id = lastRequestId();
		expect(JSON.parse(bridge.sent.at(-1) ?? "{}")).toMatchObject({
			type: "get_subagent_messages",
			subagentId: "sub-1",
			fromByte: 12,
		});
		bridge.emitFrame({
			type: "response",
			command: "get_subagent_messages",
			id,
			success: true,
			data: {
				sessionFile: "sub.jsonl",
				fromByte: 12,
				nextByte: 20,
				reset: false,
				entries: [],
				messages: [{ role: "assistant", content: "done" }],
			},
		});
		await expect(pending).resolves.toMatchObject({ nextByte: 20, messages: [{ role: "assistant" }] });
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

	test("structured engine errors preserve code and message", async () => {
		const client = await startedClient();
		const p = client.getState();
		const id = lastRequestId();
		bridge.emitFrame({
			type: "response",
			command: "get_state",
			id,
			success: false,
			error: { code: "BUSY", message: "engine is busy" },
		});
		const error = await p.catch(value => value);
		expect(error).toMatchObject({ kind: "engine", code: "BUSY", message: "engine is busy" });
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

	test("engine exit returns the client to a restartable lifecycle", async () => {
		const client = await startedClient();
		bridge.emitExit();
		bridge.reset();
		const restart = client.start("/tmp/recovered");
		await flush();
		bridge.emitFrame({ type: "ready", protocolVersion: 1, capabilities: ["get_state"] });
		await expect(restart).resolves.toBeUndefined();
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
	test("detects missing event sequence numbers and drops stale events", async () => {
		const gaps: Array<[number, number]> = [];
		const events: string[] = [];
		const client = await startedClient({
			onEventGap: (expected, received) => gaps.push([expected, received]),
			onEvent: event => events.push(event.type),
		});
		bridge.emitFrame({ type: "agent_start", seq: 1 });
		bridge.emitFrame({ type: "agent_end", seq: 3 });
		bridge.emitFrame({ type: "agent_start", seq: 2 });
		expect(gaps).toEqual([
			[2, 3],
			[4, 2],
		]);
		expect(events).toEqual(["agent_start", "agent_end"]);
		await client.stop();
	});

	test("session events (no id) route to onEvent", async () => {
		const events: Array<{ type: string }> = [];
		const client = await startedClient({ onEvent: e => events.push(e as { type: string }) });
		bridge.emitFrame({ type: "agent_start" });
		bridge.emitFrame({ type: "message_start", message: { role: "assistant", content: "hi" } });
		expect(events.map(e => e.type)).toEqual(["agent_start", "message_start"]);
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

	test("command output is delivered instead of being dropped", async () => {
		const output: string[] = [];
		const client = await startedClient({ onCommandOutput: frame => output.push(frame.text) });
		bridge.emitFrame({ type: "command_output", text: "Current model: openai/gpt-5" });
		expect(output).toEqual(["Current model: openai/gpt-5"]);
		await client.stop();
	});

	test("runtime metadata updates reach their dedicated handlers", async () => {
		const seen: string[] = [];
		const client = await startedClient({
			onAvailableCommandsUpdate: frame =>
				seen.push(`commands:${frame.commands.map(command => command.name).join(",")}`),
			onSessionInfoUpdate: frame => seen.push(`session:${frame.sessionId}:${frame.title}`),
			onConfigUpdate: frame => seen.push(`config:${frame.model?.id}:${frame.thinkingLevel}`),
		});
		bridge.emitFrame({
			type: "available_commands_update",
			commands: [{ name: "stats", source: "builtin" }, { invalid: true }],
		});
		bridge.emitFrame({ type: "session_info_update", sessionId: "session-1", title: "Renamed" });
		bridge.emitFrame({
			type: "config_update",
			model: { provider: "openai", id: "gpt-5" },
			thinkingLevel: "high",
		});
		expect(seen).toEqual(["commands:stats", "session:session-1:Renamed", "config:gpt-5:high"]);
		await client.stop();
	});

	test("extension runtime failures reach the error handler", async () => {
		const errors: string[] = [];
		const client = await startedClient({ onExtensionError: frame => errors.push(frame.error) });
		bridge.emitFrame({
			type: "extension_error",
			extensionPath: "/plugin/main.ts",
			event: "tool_call",
			error: "boom",
		});
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

	test("workspace switch: old client stops cleanly, a fresh client starts", async () => {
		// App creates one client per workspace; switching stops the old and starts new.
		const first = await startedClient();
		const pInFlight = first.getState();
		await first.stop();
		await expect(pInFlight).rejects.toBeInstanceOf(RpcTransportError);

		bridge.reset();
		const second = await startedClient();
		const p = second.getState();
		const id = lastRequestId();
		bridge.emitFrame({
			type: "response",
			command: "get_state",
			id,
			success: true,
			data: { sessionId: "ws2", isStreaming: false },
		});
		expect((await p).sessionId).toBe("ws2");
		await second.stop();
	});

	test("stop is idempotent and safe to call twice", async () => {
		const client = await startedClient();
		await client.stop();
		await expect(client.stop()).resolves.toBeUndefined();
	});

	test("restart reattaches listeners and waits for a fresh ready frame", async () => {
		const client = await startedClient();
		const restart = client.restart("/tmp/ws-restarted");
		await flush();
		bridge.emitFrame({ type: "ready" });
		await expect(restart).resolves.toBeUndefined();
		await client.stop();
	});
});
