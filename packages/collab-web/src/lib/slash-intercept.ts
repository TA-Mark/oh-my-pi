/**
 * slash-intercept — desktop handler for TUI-only OMP slash commands.
 *
 * OMP RPC mode runs `executeAcpBuiltinSlashCommand` which only dispatches
 * commands that have a `handle` function. Commands with only `handleTui`
 * return false → the text goes to the model as a normal prompt (broken).
 *
 * This module intercepts those TUI-only commands BEFORE they reach OMP
 * and reimplements them using RPC primitives + bridge endpoints.
 *
 * === VERIFIED from source: packages/coding-agent/src/slash-commands/builtin-registry.ts ===
 *
 * HAS `handle` (native RPC — DO NOT intercept):
 *   /model <id>, /fast, /advisor, /export, /dump, /share, /browser,
 *   /todo, /session, /jobs, /usage, /stats, /changelog, /tools, /context,
 *   /mcp, /ssh, /compact, /force, /move, /rename, /shake, /memory,
 *   /marketplace, /plugins, /reload-plugins
 *
 * ONLY `handleTui` (must intercept):
 *   /model (no args), /switch, /loop, /plan, /goal, /guided-goal,
 *   /settings, /extensions, /agents, /branch, /fork, /tree,
 *   /login, /logout, /handoff, /new, /drop, /resume,
 *   /copy, /hotkeys, /debug, /collab, /join, /leave,
 *   /btw, /tan, /omfg, /retry, /exit, /quit
 */

import type { ChatClient } from "./chat-client";
import type { PendingDialog } from "./client";
import type { AvailableModel, DialogResponse, LoginProvider } from "./rpc-client";

export interface InterceptCallbacks {
	onNewSession(): void;
	onSidebarTab(tab: string): void;
	activeSessionId?(): string | null;
}

export interface InterceptResult {
	intercepted: boolean;
}

let dialogSeq = 0;
function nextDialogId(): string {
	return `synth-${++dialogSeq}`;
}

function showSelect(
	client: ChatClient,
	title: string,
	options: string[],
	onSelect: (value: string) => void,
): void {
	client.showSyntheticDialog?.(
		{ id: nextDialogId(), method: "select", title, options },
		(payload: DialogResponse) => {
			if ("value" in payload && typeof payload.value === "string") onSelect(payload.value);
		},
	);
}

function parseCommand(text: string): { name: string; args: string } | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return null;
	const spaceIdx = trimmed.indexOf(" ");
	if (spaceIdx === -1) return { name: trimmed.slice(1).toLowerCase(), args: "" };
	return { name: trimmed.slice(1, spaceIdx).toLowerCase(), args: trimmed.slice(spaceIdx + 1).trim() };
}

// ─── Model helpers ──────────────────────────────────────────────────────────

function formatModelOption(m: AvailableModel): string {
	const parts = [`${m.provider}/${m.displayName ?? m.id}`];
	if (m.contextWindow) {
		const ctx = m.contextWindow >= 1_000_000
			? `${(m.contextWindow / 1_000_000).toFixed(1)}M`
			: `${Math.round(m.contextWindow / 1_000)}k`;
		parts.push(ctx);
	}
	if (m.cost?.input != null && m.cost?.output != null) {
		parts.push(`$${m.cost.input.toFixed(2)}/$${m.cost.output.toFixed(2)}`);
	}
	return parts.join(" · ");
}

function parseModelOption(option: string): { provider: string; id: string } | null {
	const providerModel = option.split(" · ")[0];
	if (!providerModel) return null;
	const slashIdx = providerModel.indexOf("/");
	if (slashIdx === -1) return null;
	return { provider: providerModel.slice(0, slashIdx), id: providerModel.slice(slashIdx + 1) };
}

function selectModel(client: ChatClient, models: AvailableModel[], title: string): void {
	if (models.length === 0) {
		showSelect(client, "No models available — paste an API key in Providers first", ["OK"], () => {});
		return;
	}
	const options = models.map(formatModelOption);
	showSelect(client, title, options, (value) => {
		const parsed = parseModelOption(value);
		if (!parsed) return;
		const match = models.find(m =>
			m.provider === parsed.provider && (m.displayName === parsed.id || m.id === parsed.id)
		);
		if (match) client.sendSetModel?.(match.provider, match.id);
	});
}

// ─── Shell/Python escape helpers ────────────────────────────────────────────

async function handleShellEscape(client: ChatClient, text: string): Promise<InterceptResult> {
	const isHidden = text.startsWith("!!");
	const command = isHidden ? text.slice(2).trim() : text.slice(1).trim();
	if (!command) return { intercepted: false };

	if (client.sendBashStreaming) {
		let output = "";
		try {
			const result = await client.sendBashStreaming(command, isHidden, (chunk) => { output += chunk; });
			const exitLabel = result.exitCode != null ? ` (exit ${result.exitCode})` : "";
			const display = output || "(no output)";
			const truncated = display.length > 3000 ? `${display.slice(0, 3000)}\n… (truncated)` : display;
			showSelect(client, `${isHidden ? "!!" : "!"}${command}${exitLabel}`, [`${truncated}\n\nOK`], () => {});
		} catch {
			showSelect(client, `Shell failed: ${command}`, ["OK"], () => {});
		}
		return { intercepted: true };
	}
	return { intercepted: false };
}

async function handlePythonEscape(client: ChatClient, text: string, callbacks: InterceptCallbacks): Promise<InterceptResult> {
	const isHidden = text.startsWith("$$");
	const code = isHidden ? text.slice(2).trim() : text.slice(1).trim();
	if (!code) return { intercepted: false };
	const sessionId = callbacks.activeSessionId?.();
	if (!sessionId) return { intercepted: false };
	try {
		const { execBridgePython } = await import("../features/chat/api/chatApi");
		const result = await execBridgePython(sessionId, code, isHidden);
		const output = result.output || "(no output)";
		const truncated = output.length > 3000 ? `${output.slice(0, 3000)}\n… (truncated)` : output;
		const errNote = result.error ? `\nStderr: ${result.error.slice(0, 500)}` : "";
		showSelect(client, `Python${isHidden ? " (hidden)" : ""}`, [`${truncated}${errNote}\n\nOK`], () => {});
	} catch {
		showSelect(client, "Python execution failed", ["OK"], () => {});
	}
	return { intercepted: true };
}

// ─── Main intercept ─────────────────────────────────────────────────────────

export async function interceptSlashCommand(
	text: string,
	client: ChatClient,
	callbacks: InterceptCallbacks,
): Promise<InterceptResult> {
	// Shell escape: !cmd / !!cmd
	if (text.startsWith("!")) {
		return handleShellEscape(client, text);
	}
	// Python escape: $code / $$code
	if (text.startsWith("$") && !text.startsWith("$/")) {
		return handlePythonEscape(client, text, callbacks);
	}

	const parsed = parseCommand(text);
	if (!parsed) return { intercepted: false };

	switch (parsed.name) {

		// ── Model (no args = rich tabbed dialog; with args = pass through to OMP) ──
		case "model":
		case "models": {
			if (parsed.args) return { intercepted: false }; // has handle for /model <id>
			if (!client.showSyntheticDialog) return { intercepted: false };
			client.showSyntheticDialog(
				{ id: nextDialogId(), method: "model-controls", title: "Model & Settings" },
				() => {
					// Controls dispatch updates directly via RPC. The dialog
					// closes itself via Esc/Done; we don't act on the response.
				},
			);
			return { intercepted: true };
		}

		case "switch": {
			if (!client.sendGetAvailableModels) return { intercepted: false };
			const snapshot = client.getSnapshot();
			const curProvider = snapshot.state?.model?.provider;
			try {
				const models = await client.sendGetAvailableModels();
				const others = curProvider ? models.filter(m => m.provider !== curProvider) : models;
				selectModel(client, others, "Switch to different provider");
			} catch { return { intercepted: false }; }
			return { intercepted: true };
		}

		// ── Auth (TUI-only) ─────────────────────────────────────────────────
		case "login": {
			if (parsed.args) return { intercepted: false }; // /login <provider> may work via prompt
			if (!client.sendGetLoginProviders || !client.sendLogin) return { intercepted: false };
			try {
				const providers = await client.sendGetLoginProviders();
				const available = providers.filter((p: LoginProvider) => p.available);
				if (available.length === 0) {
					showSelect(client, "No login providers available", ["OK"], () => {});
					return { intercepted: true };
				}
				showSelect(client, "Sign in to provider",
					available.map((p: LoginProvider) => `${p.name}${p.authenticated ? " ✓" : ""}`),
					(value) => {
						const name = value.replace(/ ✓$/, "");
						const match = available.find((p: LoginProvider) => p.name === name);
						if (match) client.sendLogin!(match.id);
					},
				);
			} catch { return { intercepted: false }; }
			return { intercepted: true };
		}

		case "logout": {
			callbacks.onSidebarTab("providers");
			return { intercepted: true };
		}

		// ── Session tree (TUI-only) ─────────────────────────────────────────
		case "branch":
		case "fork":
		case "tree": {
			if (!client.sendGetBranchMessages || !client.sendBranch) return { intercepted: false };
			try {
				const messages = await client.sendGetBranchMessages();
				if (messages.length === 0) {
					showSelect(client, "No branch points available", ["OK"], () => {});
					return { intercepted: true };
				}
				showSelect(client, "Select branch point",
					messages.map(m => `${m.entryId.slice(0, 8)}: ${m.text.length > 70 ? m.text.slice(0, 67) + "…" : m.text}`),
					(value) => {
						const entryId = value.split(":")[0]?.trim();
						if (entryId) {
							const match = messages.find(m => m.entryId.startsWith(entryId));
							if (match) client.sendBranch!(match.entryId);
						}
					},
				);
			} catch { return { intercepted: false }; }
			return { intercepted: true };
		}

		// ── Session management (TUI-only) ───────────────────────────────────
		case "new":
		case "drop":
			callbacks.onNewSession();
			return { intercepted: true };

		case "resume":
			callbacks.onSidebarTab("sessions");
			return { intercepted: true };

		// ── Handoff (TUI-only slash, but RPC has handoff command type) ───────
		case "handoff":
			client.sendHandoff?.(parsed.args || undefined);
			return { intercepted: true };

		// ── Retry (TUI-only) ────────────────────────────────────────────────
		case "retry":
			client.sendRegenerate?.();
			return { intercepted: true };

		// ── Plan mode (TUI-only — bridge manages state) ─────────────────────
		case "plan":
		case "plan-review": {
			const sessionId = callbacks.activeSessionId?.();
			if (!sessionId) return { intercepted: false };
			try {
				const { planModeAction } = await import("../features/chat/api/chatApi");
				if (parsed.args) {
					await planModeAction(sessionId, "start", parsed.args);
				} else {
					const res = await planModeAction(sessionId, "status") as { active?: boolean };
					if (res.active) {
						await planModeAction(sessionId, "exit");
						showSelect(client, "Plan Mode", ["Plan mode exited.\n\nOK"], () => {});
					} else {
						showSelect(client, "Plan Mode", [
							"Usage: /plan <objective>\n\nThe agent will read files and draft a plan\nwithout modifying code.\n\nOK"
						], () => {});
					}
				}
			} catch { return { intercepted: false }; }
			return { intercepted: true };
		}

		// ── Goal mode (TUI-only — bridge manages state) ─────────────────────
		case "goal": {
			const sessionId = callbacks.activeSessionId?.();
			if (!sessionId) return { intercepted: false };
			try {
				const { goalModeAction } = await import("../features/chat/api/chatApi");
				if (!parsed.args) {
					const res = await goalModeAction(sessionId, "show") as { state?: { active?: boolean; objective?: string; turnCount?: number; paused?: boolean } | null };
					const g = res.state;
					if (g) {
						showSelect(client, "Goal Mode",
							[`${g.objective}\n\nStatus: ${g.paused ? "paused" : "active"} · Turns: ${g.turnCount}`, "Pause", "Resume", "Drop"],
							(v) => {
								if (v === "Pause") void goalModeAction(sessionId, "pause");
								else if (v === "Resume") void goalModeAction(sessionId, "resume");
								else if (v === "Drop") void goalModeAction(sessionId, "drop");
							},
						);
					} else {
						showSelect(client, "Goal Mode", ["No active goal.\nUsage: /goal set <objective>\n\nOK"], () => {});
					}
					return { intercepted: true };
				}
				const firstSpace = parsed.args.indexOf(" ");
				const sub = firstSpace > 0 ? parsed.args.slice(0, firstSpace).toLowerCase() : parsed.args.toLowerCase();
				const subArgs = firstSpace > 0 ? parsed.args.slice(firstSpace + 1).trim() : "";
				if (sub === "set" && subArgs) await goalModeAction(sessionId, "set", subArgs);
				else if (sub === "show") {
					const s = await goalModeAction(sessionId, "show");
					showSelect(client, "Goal Status", [JSON.stringify(s.state, null, 2) + "\n\nOK"], () => {});
				}
				else if (sub === "pause") await goalModeAction(sessionId, "pause");
				else if (sub === "resume") await goalModeAction(sessionId, "resume");
				else if (sub === "drop") await goalModeAction(sessionId, "drop");
				else await goalModeAction(sessionId, "set", parsed.args);
			} catch { return { intercepted: false }; }
			return { intercepted: true };
		}

		case "guided-goal": {
			const prompt = parsed.args
				? `I want to achieve: ${parsed.args}\n\nInterview me with 3-5 clarifying questions to refine this into a concrete objective with deliverables and success criteria.`
				: "Help me define a goal. Interview me with clarifying questions, then propose a concrete objective.";
			client.sendPrompt(prompt);
			return { intercepted: true };
		}

		// ── Loop mode (TUI-only — bridge could manage, for now inform user) ─
		case "loop":
			showSelect(client, "Loop Mode", [
				"Loop mode is TUI-only in the current desktop build.\n\nWorkaround: ask the agent directly:\n\"Keep running until all tests pass\" or\n\"Repeat this 10 times: ...\"\n\nThe agent will use its own iteration logic.\n\nOK"
			], () => {});
			return { intercepted: true };

		// ── UI navigation (TUI-only) ────────────────────────────────────────
		case "settings":
			callbacks.onSidebarTab("settings");
			return { intercepted: true };
		case "setup":
			callbacks.onSidebarTab("controls");
			return { intercepted: true };
		case "providers":
			callbacks.onSidebarTab("providers");
			return { intercepted: true };

		case "extensions":
		case "status":
		case "agents":
			callbacks.onSidebarTab("controls");
			return { intercepted: true };

		// ── Collab (TUI-only, needs relay) ──────────────────────────────────
		case "collab":
		case "join":
		case "leave":
			showSelect(client, "Collab", [
				"Live collab sharing requires the OMP terminal.\nRun `omp` in terminal → /collab\n\nOK"
			], () => {});
			return { intercepted: true };

		// ── Exit (no-op in desktop) ─────────────────────────────────────────
		case "exit":
		case "quit":
			return { intercepted: true };

		// ── TUI-specific (no desktop equivalent needed) ─────────────────────
		case "copy":
		case "hotkeys":
		case "debug":
			showSelect(client, `/${parsed.name}`, [
				`/${parsed.name} is a terminal-only feature.\n\nOK`
			], () => {});
			return { intercepted: true };

		// ── Pass-through to model (TUI-only but content goes to model) ──────
		case "btw":
		case "tan":
		case "omfg":
			return { intercepted: false }; // let OMP receive as prompt text

		// ── Everything else: DO NOT intercept ───────────────────────────────
		// Commands with `handle` work natively: /fast, /advisor, /compact,
		// /todo, /session, /usage, /context, /mcp, /ssh, /share, /export,
		// /dump, /tools, /jobs, /changelog, /force, /browser, /move,
		// /rename, /shake, /memory, /marketplace, /plugins, /reload-plugins
		default:
			return { intercepted: false };
	}
}
