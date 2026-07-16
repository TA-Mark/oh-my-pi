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
//   17. unstage -> success (safe no-op; desktop-added staging command; core-touchpoints.md)
//   18. stage_hunks [] -> success:false (empty-selection guard; core-touchpoints.md)
//   19. set_workspace <cwd> -> { cwd: string } (in-place project switch; no respawn)
//   20. bash -> structured BashResult with captured output
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
				if (frame.protocolVersion !== 1 || !Array.isArray(frame.capabilities))
					fail(`ready handshake missing protocolVersion/capabilities: ${line}`);
				if (
					!(frame.capabilities as unknown[]).includes("prompt") ||
					!(frame.capabilities as unknown[]).includes("get_state")
				)
					fail(`ready handshake missing required capabilities: ${line}`);
				console.log("OK: ready handshake includes protocolVersion 1 and required capabilities");
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
				if (typeof data.autoRetryEnabled !== "boolean") fail("get_state.autoRetryEnabled not a boolean");
				if (typeof data.autoCompactionEnabled !== "boolean") fail("get_state.autoCompactionEnabled not a boolean");
				if (!Array.isArray(data.todoPhases)) fail("get_state.todoPhases not an array");
				if (
					typeof data.steeringMode !== "string" ||
					typeof data.followUpMode !== "string" ||
					typeof data.interruptMode !== "string"
				) {
					fail("get_state queue modes missing");
				}
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
				if (data.approvalMode !== "always-ask")
					fail(`approvalMode not applied: ${JSON.stringify(data.approvalMode)}`);
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
				// Unstage-all is a safe no-op when nothing is staged; verifies the
				// staging command path (desktop-added; core-touchpoints.md) without
				// mutating the working tree.
				send({ type: "unstage", id: "s16" });
			} else if (frame.id === "s16") {
				if (frame.success !== true) fail(`unstage failed: ${line}`);
				console.log("OK: unstage accepted");
				// stage_hunks with an empty selection is rejected by the engine
				// (nothing to stage) — assert that guard rather than staging real hunks.
				send({ type: "stage_hunks", selections: [], id: "s17" });
			} else if (frame.id === "s17") {
				if (frame.success !== false) fail(`stage_hunks empty selection should fail: ${line}`);
				console.log("OK: stage_hunks rejects empty selection (guard holds)");
				// Re-root at the current cwd: a same-directory switch makes moveTo a
				// no-op, so this exercises the command contract (fresh task + reroot +
				// { cwd } reply) without chdir'ing the engine into an unrelated tree.
				send({ type: "set_workspace", cwd: process.cwd(), id: "s18" });
			} else if (frame.id === "s18") {
				if (frame.success !== true || !isRecord(frame.data)) fail(`set_workspace failed: ${line}`);
				if (typeof (frame.data as Record<string, unknown>).cwd !== "string") {
					fail("set_workspace.data.cwd is not a string");
				}
				console.log("OK: set_workspace contract holds (reroot without respawn, { cwd })");
				send({ type: "bash", command: "echo desktop-bash-smoke", id: "s19" });
			} else if (frame.id === "s19") {
				if (frame.success !== true || !isRecord(frame.data)) fail(`bash failed: ${line}`);
				const data = frame.data as Record<string, unknown>;
				if (typeof data.output !== "string" || !data.output.includes("desktop-bash-smoke")) {
					fail(`bash output contract failed: ${line}`);
				}
				if (data.exitCode !== 0 || data.cancelled !== false) fail(`bash result contract failed: ${line}`);
				console.log("OK: bash contract holds (output, exitCode, cancelled)");
				send({ type: "get_session_stats", id: "s20" });
			} else if (frame.id === "s20") {
				if (frame.success !== true || !isRecord(frame.data)) fail(`get_session_stats failed: ${line}`);
				const data = frame.data as Record<string, unknown>;
				if (typeof data.sessionId !== "string" || !isRecord(data.tokens))
					fail(`session stats contract failed: ${line}`);
				console.log("OK: get_session_stats contract holds");
				send({ type: "set_auto_retry", enabled: true, id: "s21" });
			} else if (frame.id === "s21") {
				if (frame.success !== true) fail(`set_auto_retry failed: ${line}`);
				console.log("OK: set_auto_retry accepted");
				send({ type: "abort_retry", id: "s22" });
			} else if (frame.id === "s22") {
				if (frame.success !== true) fail(`abort_retry failed: ${line}`);
				console.log("OK: abort_retry accepted");
				send({ type: "get_branch_messages", id: "s23" });
			} else if (frame.id === "s23") {
				if (frame.success !== true || !isRecord(frame.data) || !Array.isArray(frame.data.messages)) {
					fail(`get_branch_messages failed: ${line}`);
				}
				console.log("OK: get_branch_messages contract holds");
				send({ type: "get_last_assistant_text", id: "s24" });
			} else if (frame.id === "s24") {
				if (frame.success !== true || !isRecord(frame.data)) fail(`get_last_assistant_text failed: ${line}`);
				if (frame.data.text !== null && typeof frame.data.text !== "string")
					fail(`last assistant text contract failed: ${line}`);
				console.log("OK: get_last_assistant_text contract holds");
				send({ type: "get_available_commands", id: "s25" });
			} else if (frame.id === "s25") {
				if (frame.success !== true || !isRecord(frame.data) || !Array.isArray(frame.data.commands))
					fail(`get_available_commands failed: ${line}`);
				console.log("OK: get_available_commands contract holds");
				send({ type: "set_host_tools", tools: [], id: "s26" });
			} else if (frame.id === "s26") {
				if (frame.success !== true || !isRecord(frame.data) || !Array.isArray(frame.data.toolNames))
					fail(`set_host_tools failed: ${line}`);
				console.log("OK: set_host_tools contract holds (empty allowlist)");
				send({ type: "set_host_uri_schemes", schemes: [], id: "s27" });
			} else if (frame.id === "s27") {
				if (frame.success !== true || !isRecord(frame.data) || !Array.isArray(frame.data.schemes))
					fail(`set_host_uri_schemes failed: ${line}`);
				console.log("OK: set_host_uri_schemes contract holds (no URI schemes enabled)");
				send({ type: "get_settings", id: "s28" });
			} else if (frame.id === "s28") {
				if (
					frame.success !== true ||
					!isRecord(frame.data) ||
					!Array.isArray(frame.data.settings) ||
					!Array.isArray(frame.data.plugins)
				) {
					fail(`get_settings failed: ${line}`);
				}
				const paths = frame.data.settings
					.filter(isRecord)
					.map(setting => setting.path)
					.filter((path): path is string => typeof path === "string");
				if (
					!paths.includes("retry.enabled") ||
					paths.some(path => /(api.?key|credential|password|secret|token)/i.test(path))
				) {
					fail(`settings allowlist/redaction contract failed: ${line}`);
				}
				console.log("OK: get_settings contract holds without secret paths");
				send({ type: "set_setting", path: "not.real", value: true, id: "s29" });
			} else if (frame.id === "s29") {
				if (frame.success !== false || typeof frame.error !== "string")
					fail(`set_setting validation failed: ${line}`);
				console.log("OK: set_setting rejects unknown paths");
				send({ type: "get_git_status", id: "s30" });
			} else if (frame.id === "s30") {
				if (frame.success !== true || !isRecord(frame.data)) fail(`get_git_status failed: ${line}`);
				const data = frame.data as Record<string, unknown>;
				if (!["staged", "unstaged", "untracked"].every(key => typeof data[key] === "number")) {
					fail(`git status counts contract failed: ${line}`);
				}
				console.log("OK: get_git_status contract holds");
				send({ type: "commit", message: "", id: "s31" });
			} else if (frame.id === "s31") {
				if (frame.success !== false || typeof frame.error !== "string") fail(`empty commit guard failed: ${line}`);
				console.log("OK: commit rejects empty messages");
				send({ type: "create_pull_request", title: "", body: "", id: "s32" });
			} else if (frame.id === "s32") {
				if (frame.success !== false || typeof frame.error !== "string")
					fail(`empty PR title guard failed: ${line}`);
				console.log("OK: create_pull_request rejects empty titles");
				send({ type: "create_worktree", path: "relative-worktree", ref: "HEAD", id: "s33" });
			} else if (frame.id === "s33") {
				if (frame.success !== false || typeof frame.error !== "string")
					fail(`relative worktree guard failed: ${line}`);
				console.log("OK: create_worktree requires an absolute path");
				send({ type: "list_worktrees", id: "s34" });
			} else if (frame.id === "s34") {
				if (frame.success !== true || !isRecord(frame.data) || !Array.isArray(frame.data.worktrees)) {
					fail(`list_worktrees contract failed: ${line}`);
				}
				console.log("OK: list_worktrees contract holds");
				send({ type: "list_workspace_files", query: "package.json", limit: 50, id: "s35" });
			} else if (frame.id === "s35") {
				if (frame.success !== true || !isRecord(frame.data) || !Array.isArray(frame.data.entries)) {
					fail(`list_workspace_files contract failed: ${line}`);
				}
				console.log("OK: list_workspace_files contract holds");
				send({ type: "read_workspace_file", path: "package.json", maxBytes: 4096, id: "s36" });
			} else if (frame.id === "s36") {
				if (frame.success !== true || !isRecord(frame.data) || typeof frame.data.content !== "string") {
					fail(`read_workspace_file contract failed: ${line}`);
				}
				console.log("OK: read_workspace_file returns bounded text content");
				send({ type: "read_workspace_file", path: "../package.json", id: "s37" });
			} else if (frame.id === "s37") {
				if (frame.success !== false || typeof frame.error !== "string") {
					fail(`workspace traversal guard failed: ${line}`);
				}
				console.log("OK: read_workspace_file rejects paths outside the workspace");
				send({ type: "get_context_snapshot", id: "s38" });
			} else if (frame.id === "s38") {
				if (frame.success !== true || !isRecord(frame.data) || !Array.isArray(frame.data.skills)) {
					fail(`get_context_snapshot contract failed: ${line}`);
				}
				console.log("OK: get_context_snapshot exposes skills and memory backend");
				send({ type: "browser_open", url: "javascript:alert(1)", id: "s39" });
			} else if (frame.id === "s39") {
				if (frame.success !== false || typeof frame.error !== "string") fail(`browser URL policy failed: ${line}`);
				console.log("OK: browser_open rejects non-http(s) URLs");
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
