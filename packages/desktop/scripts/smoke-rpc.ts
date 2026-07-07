// Runtime contract probe (drift guard): spawn the engine in rpc-ui mode and
// exercise the command/response contract the desktop client depends on:
//   1. `ready` frame appears
//   2. get_state → { sessionId: string, isStreaming: boolean }
//   3. set_thinking_level "low" → response.success (Phase 2 mutating path)
//   4. get_state → thinkingLevel === "low"
//   5. set_subagent_subscription "progress" → success (Phase 3)
//   6. get_subagents → { subagents: [...] } (Phase 3)
//   7. get_login_providers → { providers: [...] } (Phase 4)
// Exits non-zero on any drift. Keep in sync with src/lib/rpc-protocol.ts.
import * as path from "node:path";

const cliPath = path.join(import.meta.dir, "..", "..", "coding-agent", "src", "cli.ts");

const child = Bun.spawn(["bun", cliPath, "--mode", "rpc-ui"], {
	stdin: "pipe",
	stdout: "pipe",
	stderr: "ignore",
	cwd: process.cwd(),
});

function fail(message: string): never {
	console.error(`FAIL: ${message}`);
	child.kill();
	process.exit(1);
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function send(command: Record<string, unknown>): void {
	child.stdin.write(`${JSON.stringify(command)}\n`);
	child.stdin.flush();
}

const timeout = setTimeout(() => fail("contract not satisfied within 30s"), 30_000);

const decoder = new TextDecoder();
let buffer = "";
try {
	for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
		buffer += decoder.decode(chunk, { stream: true });
		let nl = buffer.indexOf("\n");
		while (nl !== -1) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			nl = buffer.indexOf("\n");
			if (!line) continue;
			let frame: unknown;
			try {
				frame = JSON.parse(line);
			} catch {
				continue;
			}
			if (!isRecord(frame)) continue;

			if (frame.type === "ready") {
				console.log("OK: engine emitted `ready` frame");
				send({ type: "get_state", id: "s1" });
				continue;
			}
			if (frame.type !== "response") continue;

			if (frame.id === "s1") {
				if (frame.success !== true || !isRecord(frame.data)) fail(`get_state failed: ${line}`);
				const data = frame.data as Record<string, unknown>;
				if (typeof data.sessionId !== "string") fail("get_state.sessionId not a string");
				if (typeof data.isStreaming !== "boolean") fail("get_state.isStreaming not a boolean");
				console.log("OK: get_state contract holds (sessionId, isStreaming)");
				send({ type: "set_thinking_level", level: "low", id: "s2" });
			} else if (frame.id === "s2") {
				if (frame.success !== true) fail(`set_thinking_level failed: ${line}`);
				console.log("OK: set_thinking_level accepted");
				send({ type: "get_state", id: "s3" });
			} else if (frame.id === "s3") {
				const data = isRecord(frame.data) ? (frame.data as Record<string, unknown>) : {};
				if (data.thinkingLevel !== "low") fail(`thinkingLevel not applied: ${JSON.stringify(data.thinkingLevel)}`);
				console.log("OK: thinking level applied (thinkingLevel === 'low')");
				send({ type: "set_subagent_subscription", level: "progress", id: "s4" });
			} else if (frame.id === "s4") {
				if (frame.success !== true) fail(`set_subagent_subscription failed: ${line}`);
				console.log("OK: set_subagent_subscription accepted");
				send({ type: "get_subagents", id: "s5" });
			} else if (frame.id === "s5") {
				if (frame.success !== true || !isRecord(frame.data)) fail(`get_subagents failed: ${line}`);
				if (!Array.isArray((frame.data as Record<string, unknown>).subagents)) {
					fail("get_subagents.data.subagents is not an array");
				}
				console.log("OK: get_subagents contract holds (subagents array)");
				send({ type: "get_login_providers", id: "s6" });
			} else if (frame.id === "s6") {
				if (frame.success !== true || !isRecord(frame.data)) fail(`get_login_providers failed: ${line}`);
				if (!Array.isArray((frame.data as Record<string, unknown>).providers)) {
					fail("get_login_providers.data.providers is not an array");
				}
				console.log("OK: get_login_providers contract holds (providers array)");
				clearTimeout(timeout);
				child.kill();
				process.exit(0);
			}
		}
	}
} finally {
	clearTimeout(timeout);
	child.kill();
}
fail("engine stdout closed before contract satisfied");
