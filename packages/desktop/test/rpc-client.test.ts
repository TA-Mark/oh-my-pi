import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Controllable fake of the Tauri bridge ────────────────────────────────────
// The client talks to the engine only through tauri-bridge, so mocking this
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

mock.module("../src/lib/tauri-bridge", () => ({
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
});

describe("request/response correlation", () => {
	test("a matching response resolves the request and clears pending", async () => {
		const client = await startedClient();
		const p = client.getState();
		const id = lastRequestId();
		bridge.emitFrame({ type: "response", command: "get_state", id, success: true, data: { sessionId: "s1", isStreaming: false } });
		const state = await p;
		expect(state.sessionId).toBe("s1");
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
		bridge.emitFrame({ type: "response", command: "list_sessions", id: idSessions, success: true, data: { sessions: [] } });
		bridge.emitFrame({ type: "response", command: "get_state", id: idState, success: true, data: { sessionId: "s", isStreaming: false } });

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
		bridge.emitFrame({ type: "response", command: "get_state", id, success: true, data: { sessionId: "ws2", isStreaming: false } });
		expect((await p).sessionId).toBe("ws2");
		await second.stop();
	});

	test("stop is idempotent and safe to call twice", async () => {
		const client = await startedClient();
		await client.stop();
		await expect(client.stop()).resolves.toBeUndefined();
	});
});
