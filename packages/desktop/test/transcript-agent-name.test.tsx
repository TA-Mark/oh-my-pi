import { expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentNameLabel } from "../src/components/AgentNameLabel";
import {
	agentWorkingLabel,
	DEFAULT_AGENT_DISPLAY_NAME,
	normalizeAgentDisplayName,
} from "../src/lib/agent-display-name";

test("transcript exposes the assistant label as a rename control", () => {
	const markup = renderToStaticMarkup(
		<AgentNameLabel name="Router Agent" onRename={() => {}} />,
	);

	expect(markup).toContain('title="Rename agent"');
	expect(markup).toContain(">Router Agent<");
	expect(markup).not.toContain(">assistant<");
});

test("clicking the agent label commits a normalized name", async () => {
	const domWindow = new HappyWindow({ url: "http://localhost" });
	const globals: Record<string, unknown> = {
		window: domWindow,
		document: domWindow.document,
		navigator: domWindow.navigator,
		HTMLElement: domWindow.HTMLElement,
		Event: domWindow.Event,
		KeyboardEvent: domWindow.KeyboardEvent,
		MouseEvent: domWindow.MouseEvent,
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries(globals)) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const container = domWindow.document.createElement("div");
	domWindow.document.body.append(container);
	const root = createRoot(container as unknown as Element);
	let renamed = "";
	try {
		await act(async () => root.render(<AgentNameLabel name="Assistant" onRename={name => (renamed = name)} />));
		const button = container.querySelector("button") as unknown as HTMLButtonElement | null;
		await act(async () => button?.click());
		const input = container.querySelector("input") as unknown as HTMLInputElement | null;
		expect(input).not.toBeNull();
		await act(async () => {
			if (!input) return;
			input.value = "  Router   Agent  ";
			const enter = new domWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event;
			input.dispatchEvent(enter);
		});
		expect(renamed).toBe("Router Agent");
	} finally {
		await act(async () => root.unmount());
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});

test("custom agent name is reused by the working indicator", () => {
	expect(agentWorkingLabel("OMP Router")).toBe("OMP Router is working…");
});

test("agent display names are bounded and blank names restore the default", () => {
	expect(normalizeAgentDisplayName("  My   Agent  ")).toBe("My Agent");
	expect(normalizeAgentDisplayName(" ")).toBe(DEFAULT_AGENT_DISPLAY_NAME);
	expect(normalizeAgentDisplayName("x".repeat(80))).toHaveLength(40);
});
