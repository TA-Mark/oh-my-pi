// Runtime contract probe (drift guard): spawn the engine in rpc-ui mode and
// exercise the command/response contract the desktop client depends on:
//   1. `ready` frame appears
//   2. get_state -> { sessionId: string, isStreaming: boolean }
//   3. set_thinking_level "off" -> response.success (Phase 2 mutating path)
//   4. get_state -> thinkingLevel === "off"
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
//   16. guided_goal_turn empty sideSessionId -> success:false (command guard; no model call)
//   17. set_vibe_mode enabled -> success, get_state -> vibeMode.enabled === true, disable -> success
//   18. get_workspace_diff -> { files: [...] } (bounded scan; must not hang)
//   19. unstage -> success (safe no-op; desktop-added staging command; core-touchpoints.md)
//   20. stage_hunks [] -> success:false (empty-selection guard; core-touchpoints.md)
//   21. set_workspace <cwd> -> { cwd: string } (in-place project switch; no respawn)
// Exits non-zero on any drift. Keep in sync with src/lib/rpc-protocol.ts.
import * as path from "node:path";

const cliPath = path.join(import.meta.dir, "..", "..", "coding-agent", "src", "cli.ts");
const useSidecar = process.argv.includes("--sidecar");
const sidecarPath = path.join(import.meta.dir, "..", "resources", `omp${process.platform === "win32" ? ".exe" : ""}`);
const engineCommand = useSidecar ? [sidecarPath, "--mode", "rpc-ui"] : ["bun", cliPath, "--mode", "rpc-ui"];

const child = Bun.spawn(engineCommand, {
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
				if (!isRecord(data.contextBreakdown) || typeof data.contextBreakdown.messagesTokens !== "number")
					fail("get_state.contextBreakdown shape invalid");
				console.log("OK: get_state contract holds (sessionId, isStreaming, contextBreakdown)");
				// Use `off`, which is preserved for every model. Concrete efforts such
				// as `low` are intentionally clamped to the active model's supported
				// effort set in OMP v17 and therefore are not stable smoke fixtures.
				send({ type: "set_thinking_level", level: "off", id: "s2" });
			} else if (frame.id === "s2") {
				if (frame.success !== true) fail(`set_thinking_level failed: ${line}`);
				console.log("OK: set_thinking_level accepted");
				send({ type: "get_state", id: "s3" });
			} else if (frame.id === "s3") {
				const data = isRecord(frame.data) ? (frame.data as Record<string, unknown>) : {};
				if (data.thinkingLevel !== "off") fail(`thinkingLevel not applied: ${JSON.stringify(data.thinkingLevel)}`);
				if (data.configuredThinkingLevel !== "off") {
					fail(`configuredThinkingLevel not applied: ${JSON.stringify(data.configuredThinkingLevel)}`);
				}
				console.log("OK: thinking level applied (thinkingLevel === 'off')");
				// `auto` is represented by the configured selector while get_state
				// continues to expose the current concrete effective effort.
				send({ type: "set_thinking_level", level: "auto", id: "s3a" });
			} else if (frame.id === "s3a") {
				if (frame.success !== true) fail(`set_thinking_level(auto) failed: ${line}`);
				send({ type: "get_state", id: "s3b" });
			} else if (frame.id === "s3b") {
				const data = isRecord(frame.data) ? (frame.data as Record<string, unknown>) : {};
				if (data.configuredThinkingLevel !== "auto") {
					fail(`configured auto thinking level not preserved: ${JSON.stringify(data.configuredThinkingLevel)}`);
				}
				console.log("OK: configured auto thinking level preserved");
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
				send({ type: "read_artifact", artifactId: "999999999", maxBytes: 4096, id: "s7a" });
			} else if (frame.id === "s7a") {
				if (
					frame.success !== false ||
					typeof frame.error !== "string" ||
					!frame.error.includes("Artifact not found")
				) {
					fail(`read_artifact missing-artifact contract failed: ${line}`);
				}
				console.log("OK: read_artifact contract holds (bounded ID lookup, structured missing error)");
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
				send({ type: "get_settings", id: "s15a" });
			} else if (frame.id === "s15a") {
				if (frame.success !== true || !isRecord(frame.data)) fail(`get_settings failed: ${line}`);
				const data = frame.data as Record<string, unknown>;
				if (!Array.isArray(data.settings) || !Array.isArray(data.plugins)) fail("get_settings data shape invalid");
				console.log("OK: get_settings contract holds (settings/plugins arrays)");
				send({ type: "get_available_commands", id: "s15a2" });
			} else if (frame.id === "s15a2") {
				if (
					frame.success !== true ||
					!isRecord(frame.data) ||
					!Array.isArray((frame.data as Record<string, unknown>).commands)
				)
					fail(`get_available_commands failed: ${line}`);
				console.log("OK: get_available_commands contract holds (commands array)");
				send({ type: "get_goal", id: "s15goal" });
			} else if (frame.id === "s15goal") {
				if (frame.success !== true || !isRecord(frame.data) || !("goal" in frame.data) || !("state" in frame.data))
					fail(`get_goal failed: ${line}`);
				console.log("OK: get_goal contract holds (goal/state snapshot)");
				send({ type: "create_goal", objective: "Desktop RPC smoke", tokenBudget: 1000, id: "s15goal-create" });
			} else if (frame.id === "s15goal-create") {
				if (frame.success !== true || !isRecord(frame.data) || !isRecord(frame.data.state))
					fail(`create_goal failed: ${line}`);
				if (frame.data.state.enabled !== true || !isRecord(frame.data.goal) || frame.data.goal.status !== "active")
					fail(`create_goal state invalid: ${line}`);
				console.log("OK: create_goal activates goal mode");
				send({ type: "pause_goal", id: "s15goal-pause" });
			} else if (frame.id === "s15goal-pause") {
				if (frame.success !== true || !isRecord(frame.data) || !isRecord(frame.data.state))
					fail(`pause_goal failed: ${line}`);
				if (frame.data.state.enabled !== false || !isRecord(frame.data.goal) || frame.data.goal.status !== "paused")
					fail(`pause_goal state invalid: ${line}`);
				console.log("OK: pause_goal disables active goal mode");
				send({ type: "resume_goal", id: "s15goal-resume" });
			} else if (frame.id === "s15goal-resume") {
				if (frame.success !== true || !isRecord(frame.data) || !isRecord(frame.data.state))
					fail(`resume_goal failed: ${line}`);
				if (frame.data.state.enabled !== true || !isRecord(frame.data.goal) || frame.data.goal.status !== "active")
					fail(`resume_goal state invalid: ${line}`);
				console.log("OK: resume_goal reactivates goal mode");
				send({ type: "drop_goal", id: "s15goal-drop" });
			} else if (frame.id === "s15goal-drop") {
				if (
					frame.success !== true ||
					!isRecord(frame.data) ||
					frame.data.state !== null ||
					!isRecord(frame.data.goal)
				)
					fail(`drop_goal failed: ${line}`);
				if (frame.data.goal.status !== "dropped") fail(`drop_goal state invalid: ${line}`);
				console.log("OK: drop_goal clears goal mode with dropped snapshot");
				send({
					type: "guided_goal_turn",
					messages: [{ role: "user", content: "Smoke goal" }],
					sideSessionId: "",
					id: "s15guided",
				});
			} else if (frame.id === "s15guided") {
				if (frame.success !== false || typeof frame.error !== "string" || !frame.error.includes("sideSessionId")) {
					fail(`guided_goal_turn guard failed: ${line}`);
				}
				console.log("OK: guided_goal_turn command guard holds (no model call)");
				send({ type: "set_vibe_mode", enabled: true, id: "s15vibe-on" });
			} else if (frame.id === "s15vibe-on") {
				if (frame.success !== true || !isRecord(frame.data) || !isRecord(frame.data.state)) {
					fail(`set_vibe_mode enable failed: ${line}`);
				}
				if (frame.data.state.enabled !== true) fail(`set_vibe_mode state invalid: ${line}`);
				console.log("OK: set_vibe_mode enable accepted");
				send({ type: "get_state", id: "s15vibe-state" });
			} else if (frame.id === "s15vibe-state") {
				const data = isRecord(frame.data) ? (frame.data as Record<string, unknown>) : {};
				const vibeMode = isRecord(data.vibeMode) ? (data.vibeMode as Record<string, unknown>) : undefined;
				if (vibeMode?.enabled !== true) fail(`vibe mode not enabled: ${JSON.stringify(data.vibeMode)}`);
				console.log("OK: get_state exposes vibeMode while active");
				send({ type: "set_vibe_mode", enabled: false, id: "s15vibe-off" });
			} else if (frame.id === "s15vibe-off") {
				if (frame.success !== true || !isRecord(frame.data) || frame.data.state !== null) {
					fail(`set_vibe_mode disable failed: ${line}`);
				}
				console.log("OK: set_vibe_mode disable accepted");
				send({
					type: "set_host_tools",
					tools: [{ name: "desktop_smoke", description: "Smoke host tool", parameters: { type: "object" } }],
					id: "s15a3",
				});
			} else if (frame.id === "s15a3") {
				if (
					frame.success !== true ||
					!isRecord(frame.data) ||
					!Array.isArray((frame.data as Record<string, unknown>).toolNames) ||
					!((frame.data as Record<string, unknown>).toolNames as unknown[]).includes("desktop_smoke")
				)
					fail(`set_host_tools failed: ${line}`);
				console.log("OK: set_host_tools contract holds (toolNames)");
				send({ type: "set_host_uri_schemes", schemes: [{ scheme: "smoke", immutable: true }], id: "s15a4" });
			} else if (frame.id === "s15a4") {
				if (
					frame.success !== true ||
					!isRecord(frame.data) ||
					!Array.isArray((frame.data as Record<string, unknown>).schemes) ||
					!((frame.data as Record<string, unknown>).schemes as unknown[]).includes("smoke")
				)
					fail(`set_host_uri_schemes failed: ${line}`);
				console.log("OK: set_host_uri_schemes contract holds (schemes)");
				send({ type: "set_host_tools", tools: [], id: "s15a5" });
			} else if (frame.id === "s15a5") {
				if (frame.success !== true) fail(`set_host_tools clear failed: ${line}`);
				console.log("OK: host registry clear accepted");
				send({ type: "list_workspace_files", query: "", limit: 100, id: "s15b" });
			} else if (frame.id === "s15b") {
				if (frame.success !== true || !isRecord(frame.data)) fail(`list_workspace_files failed: ${line}`);
				const data = frame.data as Record<string, unknown>;
				if (!Array.isArray(data.entries) || typeof data.truncated !== "boolean")
					fail("list_workspace_files data shape invalid");
				console.log("OK: list_workspace_files contract holds (entries/truncated)");
				send({ type: "read_workspace_file", path: "package.json", maxBytes: 4096, id: "s15c" });
			} else if (frame.id === "s15c") {
				if (frame.success !== true || !isRecord(frame.data)) fail(`read_workspace_file failed: ${line}`);
				const data = frame.data as Record<string, unknown>;
				if (typeof data.content !== "string" || typeof data.path !== "string")
					fail("read_workspace_file data shape invalid");
				console.log("OK: read_workspace_file contract holds (bounded text preview)");
				send({ type: "get_context_snapshot", id: "s15d" });
			} else if (frame.id === "s15d") {
				if (frame.success !== true || !isRecord(frame.data)) fail(`get_context_snapshot failed: ${line}`);
				console.log("OK: get_context_snapshot accepted");
				send({ type: "reload_skills", id: "s15d2" });
			} else if (frame.id === "s15d2") {
				if (frame.success !== true || !isRecord(frame.data)) fail(`reload_skills failed: ${line}`);
				console.log("OK: reload_skills accepted");
				send({ type: "get_mcp_status", id: "s15e" });
			} else if (frame.id === "s15e") {
				if (
					frame.success !== true ||
					!isRecord(frame.data) ||
					!Array.isArray((frame.data as Record<string, unknown>).servers)
				)
					fail(`get_mcp_status failed: ${line}`);
				console.log("OK: get_mcp_status contract holds (servers array)");
				send({ type: "get_marketplace", id: "s15market" });
			} else if (frame.id === "s15market") {
				if (
					frame.success !== true ||
					!isRecord(frame.data) ||
					!Array.isArray((frame.data as Record<string, unknown>).marketplaces) ||
					!Array.isArray((frame.data as Record<string, unknown>).plugins)
				)
					fail(`get_marketplace failed: ${line}`);
				console.log("OK: get_marketplace contract holds (marketplaces/plugins arrays)");
				send({ type: "get_memory_status", id: "s15memory" });
			} else if (frame.id === "s15memory") {
				if (
					frame.success !== true ||
					!isRecord(frame.data) ||
					typeof (frame.data as Record<string, unknown>).backend !== "string" ||
					typeof (frame.data as Record<string, unknown>).active !== "boolean" ||
					typeof (frame.data as Record<string, unknown>).writable !== "boolean" ||
					typeof (frame.data as Record<string, unknown>).searchable !== "boolean"
				)
					fail(`get_memory_status failed: ${line}`);
				console.log("OK: get_memory_status contract holds (backend health capabilities)");
				send({ type: "browser_list_tabs", id: "s15f" });
			} else if (frame.id === "s15f") {
				if (
					frame.success !== true ||
					!isRecord(frame.data) ||
					!Array.isArray((frame.data as Record<string, unknown>).tabs) ||
					(frame.data as Record<string, unknown>).downloadPolicy !== "deny"
				)
					fail(`browser_list_tabs failed: ${line}`);
				console.log("OK: browser_list_tabs contract holds (tabs array, deny download policy)");
				send({ type: "get_git_status", id: "s15g" });
			} else if (frame.id === "s15g") {
				if (frame.success !== true || !isRecord(frame.data)) fail(`get_git_status failed: ${line}`);
				console.log("OK: get_git_status accepted");
				send({ type: "bash", command: "echo desktop-terminal-smoke", id: "s15g2" });
			} else if (frame.id === "s15g2") {
				if (
					frame.success !== true ||
					!isRecord(frame.data) ||
					typeof (frame.data as Record<string, unknown>).output !== "string" ||
					!(frame.data as Record<string, unknown>).output?.toString().includes("desktop-terminal-smoke")
				)
					fail(`bash terminal contract failed: ${line}`);
				console.log("OK: bash terminal contract holds");
				send({ type: "list_worktrees", id: "s15h" });
			} else if (frame.id === "s15h") {
				if (
					frame.success !== true ||
					!isRecord(frame.data) ||
					!Array.isArray((frame.data as Record<string, unknown>).worktrees)
				)
					fail(`list_worktrees failed: ${line}`);
				console.log("OK: list_worktrees contract holds (worktrees array)");
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
