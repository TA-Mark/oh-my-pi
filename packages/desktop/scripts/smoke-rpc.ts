// Runtime contract probe (drift guard): spawn the engine in rpc-ui mode and
// exercise the command/response contract the desktop client depends on:
//   1. `ready` frame appears
//   2. get_state -> { sessionId: string, isStreaming: boolean }
//   3. set_thinking_level "low" -> response.success (Phase 2 mutating path)
//   4. get_state -> thinkingLevel === "low"
//   5. set_approval_mode "always-ask" -> response.success
//   6. get_state -> approvalMode === "always-ask"
//   7. set_subagent_subscription "progress" -> success (Phase 3)
//   8. get_subagents -> { subagents: [...] } (Phase 3)
//   9. get_login_providers -> { providers: [...] } (Phase 4)
//   10. logout (fake provider) -> success (desktop-added core command; core-touchpoints.md)
//   11. list_sessions -> { sessions: [...] } (session history/switch; core-touchpoints.md)
//   12. set_plan_mode enabled -> success (plan mode; core-touchpoints.md)
//   13. get_state -> planMode.enabled === true
//   14. set_plan_mode disabled -> success
//   15. get_state -> planMode === undefined (cleared)
//   16. get_workspace_diff -> { files: [...] } (bounded scan; must not hang)
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
				send({ type: "set_approval_mode", mode: "always-ask", id: "s4" });
			} else if (frame.id === "s4") {
				if (frame.success !== true) fail(`set_approval_mode failed: ${line}`);
				console.log("OK: set_approval_mode accepted");
				send({ type: "get_state", id: "s5" });
			} else if (frame.id === "s5") {
				const data = isRecord(frame.data) ? (frame.data as Record<string, unknown>) : {};
				if (data.approvalMode !== "always-ask") fail(`approvalMode not applied: ${JSON.stringify(data.approvalMode)}`);
				console.log("OK: approval mode applied (approvalMode === 'always-ask')");
				send({ type: "set_subagent_subscription", level: "progress", id: "s6" });
			} else if (frame.id === "s6") {
				if (frame.success !== true) fail(`set_subagent_subscription failed: ${line}`);
				console.log("OK: set_subagent_subscription accepted");
				send({ type: "get_subagents", id: "s7" });
			} else if (frame.id === "s7") {
				if (frame.success !== true || !isRecord(frame.data)) fail(`get_subagents failed: ${line}`);
				if (!Array.isArray((frame.data as Record<string, unknown>).subagents)) {
					fail("get_subagents.data.subagents is not an array");
				}
				console.log("OK: get_subagents contract holds (subagents array)");
				send({ type: "get_login_providers", id: "s8" });
			} else if (frame.id === "s8") {
				if (frame.success !== true || !isRecord(frame.data)) fail(`get_login_providers failed: ${line}`);
				if (!Array.isArray((frame.data as Record<string, unknown>).providers)) {
					fail("get_login_providers.data.providers is not an array");
				}
				console.log("OK: get_login_providers contract holds (providers array)");
				// Logout a fake provider id; deletes nothing (no real credentials touched),
				// just verifies the logout command path.
				send({ type: "logout", providerId: "__smoke_test_provider__", id: "s9" });
			} else if (frame.id === "s9") {
				if (frame.success !== true) fail(`logout failed: ${line}`);
				console.log("OK: logout accepted");
				send({ type: "list_sessions", id: "s10" });
			} else if (frame.id === "s10") {
				if (frame.success !== true || !isRecord(frame.data)) fail(`list_sessions failed: ${line}`);
				if (!Array.isArray((frame.data as Record<string, unknown>).sessions)) {
					fail("list_sessions.data.sessions is not an array");
				}
				console.log("OK: list_sessions contract holds (sessions array)");
				send({ type: "set_plan_mode", enabled: true, id: "s11" });
			} else if (frame.id === "s11") {
				if (frame.success !== true) fail(`set_plan_mode enable failed: ${line}`);
				console.log("OK: set_plan_mode enable accepted");
				send({ type: "get_state", id: "s12" });
			} else if (frame.id === "s12") {
				const data = isRecord(frame.data) ? (frame.data as Record<string, unknown>) : {};
				const planMode = isRecord(data.planMode) ? (data.planMode as Record<string, unknown>) : undefined;
				if (planMode?.enabled !== true) fail(`plan mode not enabled: ${JSON.stringify(data.planMode)}`);
				if (typeof planMode.planFilePath !== "string") fail("planMode.planFilePath not a string");
				console.log("OK: plan mode enabled (planMode.enabled === true)");
				send({ type: "set_plan_mode", enabled: false, id: "s13" });
			} else if (frame.id === "s13") {
				if (frame.success !== true) fail(`set_plan_mode disable failed: ${line}`);
				console.log("OK: set_plan_mode disable accepted");
				send({ type: "get_state", id: "s14" });
			} else if (frame.id === "s14") {
				const data = isRecord(frame.data) ? (frame.data as Record<string, unknown>) : {};
				if (data.planMode !== undefined) fail(`plan mode not cleared: ${JSON.stringify(data.planMode)}`);
				console.log("OK: plan mode cleared (planMode === undefined)");
				send({ type: "get_workspace_diff", id: "s15" });
			} else if (frame.id === "s15") {
				if (frame.success !== true || !isRecord(frame.data)) fail(`get_workspace_diff failed: ${line}`);
				if (!Array.isArray((frame.data as Record<string, unknown>).files)) {
					fail("get_workspace_diff.data.files is not an array");
				}
				console.log("OK: get_workspace_diff contract holds (files array)");
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