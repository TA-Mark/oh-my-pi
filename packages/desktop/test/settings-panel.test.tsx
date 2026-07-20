import { expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsPanel, type SettingsPanelProps } from "../src/components/SettingsPanel";
import type { RpcSettingCategory, RpcSettingDescriptor } from "../src/lib/rpc-protocol";

const noop = () => {};
const noopAsync = async () => true;

function descriptor(
	category: "providers" | "retry" | "compaction" | "skills" | "tools",
	path: string,
): RpcSettingDescriptor {
	return {
		path,
		category,
		type: "boolean",
		value: true,
		configured: true,
		label: `${category} control`,
		description: `Configure ${category}`,
		activation: "immediate",
	};
}

const baseProps: SettingsPanelProps = {
	open: true,
	snapshot: {
		settings: [
			descriptor("providers", "providers.enabled"),
			descriptor("retry", "retry.enabled"),
			descriptor("compaction", "compaction.enabled"),
			descriptor("skills", "skills.enabled"),
			descriptor("skills", "skills.enableSkillCommands"),
			descriptor("skills", "skills.enablePiUser"),
			descriptor("skills", "skills.enablePiProject"),
			descriptor("skills", "skills.enableAgentsUser"),
			descriptor("skills", "skills.enableAgentsProject"),
			descriptor("skills", "skills.enableClaudeUser"),
			descriptor("skills", "skills.enableClaudeProject"),
			descriptor("skills", "skills.enableCodexUser"),
		],
		plugins: [],
	},
	loading: false,
	error: null,
	savingKeys: [],
	operationFeedbacks: [],
	models: [
		{ provider: "openai", id: "gpt-5.4", contextWindow: 128_000, reasoning: true },
		{ provider: "openai", id: "gpt-5.4-mini", contextWindow: 128_000, reasoning: true },
	],
	loginProviders: [
		{
			id: "openai",
			name: "OpenAI",
			available: true,
			authenticated: true,
			authKind: "oauth",
			supportsOAuth: true,
			supportsApiKey: true,
		},
	],
	activeModel: { provider: "openai", id: "gpt-5.4" },
	mcpServers: [],
	mcpCapabilities: null,
	memoryStatus: null,
	memorySearch: null,
	marketplace: { marketplaces: [], plugins: [] },
	marketplaceError: null,
	skillDetails: [],
	skillWarnings: [],
	hostTools: [],
	workspaceUriEnabled: false,
	onRefresh: noop,
	onOpenDiagnostics: noop,
	onSaveSetting: noop,
	onSelectModel: noop,
	onLogin: noop,
	onSetApiKey: noop,
	onLogout: noop,
	onSetPluginEnabled: noop,
	onSetPluginFeatures: noop,
	onSetPluginSetting: noop,
	onDeletePluginSetting: noop,
	onInstallPlugin: noop,
	onUpdatePlugin: noop,
	onUninstallPlugin: noop,
	onRefreshMarketplace: noop,
	onAddMarketplace: noop,
	onUpdateMarketplace: noop,
	onRemoveMarketplace: noop,
	onInstallMarketplacePlugin: noop,
	onUpgradeMarketplacePlugin: noop,
	onUninstallMarketplacePlugin: noop,
	onSetMarketplacePluginEnabled: noop,
	onRefreshMcp: noop,
	onAddMcpServer: noop,
	onRemoveMcpServer: noop,
	onTestMcpServer: noop,
	onReloadMcp: noop,
	onReconnectMcp: noop,
	onSetMcpEnabled: noop,
	onUnauthMcp: noop,
	onReauthMcp: noop,
	onRefreshMemory: noop,
	onSearchMemory: noop,
	onSaveMemory: noopAsync,
	onEnqueueMemory: noop,
	onClearMemory: noop,
	onAddMemoryContext: noop,
	onStartNewTask: noop,
	onReloadSkills: noop,
	onSetSkillEnabled: noop,
	onHostToolsChange: noop,
	onWorkspaceUriEnabledChange: noop,
	onClose: noop,
};

function renderCategory(category: RpcSettingCategory): string {
	return renderToStaticMarkup(<SettingsPanel {...baseProps} initialCategory={category} />);
}

test("settings modal keeps its backdrop below the interactive panel", () => {
	const markup = renderCategory("plugins");
	expect(markup).toContain('class="settings-backdrop"');
	expect(markup).not.toContain('class="picker-backdrop"');
	for (const label of [
		"Models &amp; providers",
		"MCP servers",
		"Plugins",
		"Skills",
		"Memory",
		"Retry",
		"Context compaction",
	]) {
		expect(markup).toContain(label);
	}
});

test("settings dialog exposes an accessible name, description, search, and current category", () => {
	const markup = renderCategory("providers");
	expect(markup).toContain('role="dialog"');
	expect(markup).toContain('aria-modal="true"');
	expect(markup).toContain("aria-labelledby=");
	expect(markup).toContain("aria-describedby=");
	expect(markup).toContain('aria-label="Search settings"');
	expect(markup).toContain('aria-current="page"');
});

test("technical setting paths stay hidden in the default settings view", () => {
	const markup = renderCategory("providers");
	expect(markup).toContain("Provider connections");
	expect(markup).not.toContain("providers.enabled</code>");
	expect(markup).not.toContain("providers control");
});

test("provider settings lead with connection state and an actionable model choice", () => {
	const markup = renderCategory("providers");
	expect(markup).toContain("Ready to use");
	expect(markup).toContain("1 connected provider · 2 available models");
	expect(markup).toContain("Active model");
	expect(markup).toContain("openai/gpt-5.4");
	expect(markup).toContain("Connected");
	expect(markup).toContain("Reconnect");
	expect(markup).toContain("Replace key");
	expect(markup).toContain("Sign out");
	expect(markup).toContain("Advanced provider behavior");
});

test("advanced provider controls explain intent before exposing editable values", async () => {
	const domWindow = new HappyWindow({ url: "http://localhost" });
	const globals: Record<string, unknown> = {
		window: domWindow,
		document: domWindow.document,
		navigator: domWindow.navigator,
		HTMLElement: domWindow.HTMLElement,
		KeyboardEvent: domWindow.KeyboardEvent,
		Event: domWindow.Event,
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
	try {
		await act(async () => {
			root.render(
				<SettingsPanel
					{...baseProps}
					initialCategory="providers"
					snapshot={{
						plugins: [],
						settings: [
							{
								path: "disabledProviders",
								category: "providers",
								type: "array",
								value: [],
								configured: false,
								label: "Disabled Providers",
								description: "Configure disabled providers",
								activation: "immediate",
							},
							{
								path: "providers.maxInFlightRequests",
								category: "providers",
								type: "record",
								value: {},
								configured: false,
								label: "Max In-Flight Requests",
								description: "Configure concurrency",
								activation: "immediate",
							},
						],
					}}
				/>,
			);
			await Bun.sleep(10);
		});
		const buttonWithText = (text: string) =>
			Array.from(domWindow.document.querySelectorAll("button")).find(button => button.textContent?.includes(text));
		await act(async () => buttonWithText("Advanced provider behavior")?.click());
		expect(domWindow.document.body.textContent).toContain("The defaults are recommended");
		expect(domWindow.document.body.textContent).toContain("Privacy & availability");
		expect(domWindow.document.body.textContent).toContain("Performance & reliability");

		await act(async () => buttonWithText("Privacy & availability")?.click());
		expect(domWindow.document.body.textContent).toContain("Providers OMP must never use");
		expect(domWindow.document.querySelector('input[placeholder="provider-one, provider-two"]')).not.toBeNull();
		expect(domWindow.document.body.textContent).not.toContain("Save JSON");

		await act(async () => buttonWithText("Performance & reliability")?.click());
		expect(domWindow.document.body.textContent).toContain("Parallel request limits by provider");
		expect(domWindow.document.body.textContent).toContain("No OMP limit is set");
		expect(domWindow.document.body.textContent).toContain("Add limit");
	} finally {
		await act(async () => root.unmount());
		await domWindow.close();
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});

test("retry and compaction lead with recovery flows instead of raw configuration fields", () => {
	const retryMarkup = renderToStaticMarkup(
		<SettingsPanel
			{...baseProps}
			initialCategory="retry"
			snapshot={{
				plugins: [],
				settings: [
					descriptor("retry", "retry.enabled"),
					{
						...descriptor("retry", "retry.maxRetries"),
						type: "number",
						value: 5,
						options: [{ value: "5", label: "5 retries" }],
					},
					{ ...descriptor("retry", "retry.modelFallback"), value: true },
					{ ...descriptor("retry", "retry.baseDelayMs"), type: "number", value: 500 },
				],
			}}
		/>,
	);
	expect(retryMarkup).toContain("Automatic recovery is on");
	expect(retryMarkup).toContain("Temporary failure");
	expect(retryMarkup).toContain("Starts after 0.5s");
	expect(retryMarkup).toContain("5 retries");
	expect(retryMarkup).toContain("Use backup model");
	expect(retryMarkup).not.toContain("Base Delay Ms");

	const compactionMarkup = renderToStaticMarkup(
		<SettingsPanel
			{...baseProps}
			initialCategory="compaction"
			snapshot={{
				plugins: [],
				settings: [
					descriptor("compaction", "compaction.enabled"),
					{
						...descriptor("compaction", "compaction.strategy"),
						type: "enum",
						value: "snapcompact",
						options: [{ value: "snapcompact", label: "Snapcompact" }],
					},
					{ ...descriptor("compaction", "compaction.autoContinue"), value: true },
				],
			}}
		/>,
	);
	expect(compactionMarkup).toContain("Context maintenance is on");
	expect(compactionMarkup).toContain("Context fills up");
	expect(compactionMarkup).toContain("Snapcompact");
	expect(compactionMarkup).toContain("Continue the task automatically");
	expect(compactionMarkup).toContain("Advanced context controls");
});

test("memory presents backend health, core tasks, and recall results as one workflow", () => {
	const markup = renderToStaticMarkup(
		<SettingsPanel
			{...baseProps}
			initialCategory="memory"
			snapshot={{
				plugins: [],
				settings: [
					{
						path: "memory.backend",
						category: "memory",
						type: "enum",
						value: "mnemopi",
						configured: true,
						label: "Memory Backend",
						description: "Choose memory backend",
						activation: "immediate",
						options: [{ value: "mnemopi", label: "Mnemopi" }],
					},
					{
						path: "mnemopi.autoRecall",
						category: "memory",
						type: "boolean",
						value: true,
						configured: false,
						label: "Mnemopi Auto Recall",
						description: "Recall memories at task start",
						activation: "immediate",
					},
				],
			}}
			memoryStatus={{
				backend: "mnemopi",
				active: true,
				writable: true,
				searchable: true,
				workingCount: 4,
				episodicCount: 12,
				tripleCount: 30,
				message: "Local structured memory is ready.",
			}}
			memorySearch={{
				backend: "mnemopi",
				query: "package manager",
				count: 1,
				items: [{ id: "memory-1", source: "project", content: "Use Bun for package scripts", score: 0.92 }],
			}}
		/>,
	);
	expect(markup).toContain("Memory is ready");
	expect(markup).toContain("Choose where memory lives");
	expect(markup).toContain('aria-pressed="true"');
	expect(markup).toContain("Remember something");
	expect(markup).toContain("Recall memories");
	expect(markup).toContain("Working memories");
	expect(markup).toContain("Use Bun for package scripts");
	expect(markup).toContain("92% match");
	expect(markup).toContain("Add to task context");
	expect(markup).toContain("Memory behavior &amp; advanced setup");
});

test("memory backend cards preview details before an explicit activation", async () => {
	const domWindow = new HappyWindow({ url: "http://localhost" });
	const globals: Record<string, unknown> = {
		window: domWindow,
		document: domWindow.document,
		navigator: domWindow.navigator,
		HTMLElement: domWindow.HTMLElement,
		KeyboardEvent: domWindow.KeyboardEvent,
		Event: domWindow.Event,
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
	const saves: Array<{ path: string; value: unknown }> = [];
	try {
		await act(async () => {
			root.render(
				<SettingsPanel
					{...baseProps}
					initialCategory="memory"
					snapshot={{
						plugins: [],
						settings: [
							{
								path: "memory.backend",
								category: "memory",
								type: "enum",
								value: "local",
								configured: true,
								label: "Memory Backend",
								description: "Choose memory backend",
								activation: "immediate",
								options: [],
							},
						],
					}}
					memoryStatus={{
						backend: "local",
						active: true,
						writable: true,
						searchable: false,
						message: "Local summaries are ready.",
					}}
					onSaveSetting={(path, value) => saves.push({ path, value })}
				/>,
			);
			await Bun.sleep(10);
		});
		const buttonWithText = (text: string) =>
			Array.from(domWindow.document.querySelectorAll("button")).find(button => button.textContent?.includes(text));

		await act(async () => buttonWithText("Mnemopi")?.click());
		expect(saves).toEqual([]);
		expect(domWindow.document.body.textContent).toContain("Structured SQLite databases on this device");
		expect(domWindow.document.body.textContent).toContain("Semantic recall");

		await act(async () => buttonWithText("Activate Mnemopi")?.click());
		expect(saves).toEqual([{ path: "memory.backend", value: "mnemopi" }]);
	} finally {
		await act(async () => root.unmount());
		await domWindow.close();
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});

test("MCP exposes runtime connection, authentication, source, and mounted tools", async () => {
	const domWindow = new HappyWindow({ url: "http://localhost" });
	const globals: Record<string, unknown> = {
		window: domWindow,
		document: domWindow.document,
		navigator: domWindow.navigator,
		HTMLElement: domWindow.HTMLElement,
		KeyboardEvent: domWindow.KeyboardEvent,
		Event: domWindow.Event,
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
	let reconnectCount = 0;
	try {
		await act(async () => {
			root.render(
				<SettingsPanel
					{...baseProps}
					initialCategory="mcp"
					mcpServers={[
						{
							name: "project-tools",
							enabled: true,
							status: "connected",
							toolCount: 2,
							toolNames: ["mcp__project-tools_read", "mcp__project-tools_write"],
							transport: "stdio",
							source: { provider: "omp", providerName: "OMP project config", level: "project" },
							auth: {
								configured: false,
								oauth: false,
								credentialConfigured: false,
								credentialAvailable: false,
							},
						},
					]}
					onReconnectMcp={() => {
						reconnectCount += 1;
					}}
				/>,
			);
			await Bun.sleep(10);
		});
		expect(domWindow.document.body.textContent).toContain("1 connected · 2 mounted tools");
		expect(domWindow.document.body.textContent).toContain("Available to OMP right now");
		expect(domWindow.document.body.textContent).toContain("Manage servers");
		expect(domWindow.document.body.textContent).toContain("OMP project config · project scope");
		expect(domWindow.document.body.textContent).toContain("mcp__project-tools_read");
		expect(domWindow.document.body.textContent).toContain("No managed authentication");
		const reconnect = Array.from(domWindow.document.querySelectorAll("button")).find(button =>
			button.textContent?.includes("Reconnect"),
		);
		await act(async () => reconnect?.click());
		expect(reconnectCount).toBe(1);
	} finally {
		await act(async () => root.unmount());
		await domWindow.close();
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});

test("concurrent save feedback stays associated with every setting that triggered it", () => {
	const markup = renderToStaticMarkup(
		<SettingsPanel
			{...baseProps}
			initialCategory="tools"
			snapshot={{
				plugins: [],
				settings: [
					descriptor("tools", "tools.enabled"),
					descriptor("tools", "tools.fallback"),
				],
			}}
			savingKeys={["tools.enabled", "tools.fallback"]}
			operationFeedbacks={[
				{ key: "tools.enabled", state: "saving" },
				{ key: "tools.fallback", state: "saving" },
			]}
		/>,
	);
	expect(markup.match(/settings-config-row--busy/g)).toHaveLength(2);
	expect(markup).toContain("Saving…");
});

test("every settings category renders discoverable content", () => {
	expect(renderCategory("providers")).toContain("Provider connections");
	expect(renderCategory("tools")).toContain("Electron host registry");
	expect(renderCategory("mcp")).toContain("No server configuration was discovered");
	expect(renderCategory("plugins")).toContain("Choose what to manage");
	expect(renderCategory("plugins")).toContain("Install directly from a source");
	expect(renderCategory("skills")).toContain("Discovery sources");
	expect(renderCategory("skills")).toContain("Load on demand");
	expect(renderCategory("memory")).toContain("Choose where memory lives");
	expect(renderCategory("retry")).toContain("Automatic recovery is on");
	expect(renderCategory("compaction")).toContain("Context maintenance is on");
});

test("skills presents the active runtime source and invocation behavior", () => {
	const markup = renderToStaticMarkup(
		<SettingsPanel
			{...baseProps}
			initialCategory="skills"
			skillDetails={[
				{
					name: "release-review",
					description: "Review a release before publishing",
					filePath: "C:/workspace/.omp/skills/release-review/SKILL.md",
					source: "native:project",
					provider: "native",
					providerName: "OMP native",
					level: "project",
				},
			]}
		/>,
	);
	expect(markup).toContain("1 skill available");
	expect(markup).toContain("Review a release before publishing");
	expect(markup).toContain("OMP native · project");
	expect(markup).toContain("/skill commands on");
});

test("settings manages focus, Escape, and destructive confirmation as one modal workflow", async () => {
	const domWindow = new HappyWindow({ url: "http://localhost" });
	const globals: Record<string, unknown> = {
		window: domWindow,
		document: domWindow.document,
		navigator: domWindow.navigator,
		HTMLElement: domWindow.HTMLElement,
		KeyboardEvent: domWindow.KeyboardEvent,
		Event: domWindow.Event,
		MouseEvent: domWindow.MouseEvent,
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries(globals)) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const trigger = domWindow.document.createElement("button");
	const container = domWindow.document.createElement("div");
	domWindow.document.body.append(trigger, container);
	trigger.focus();
	const root = createRoot(container as unknown as Element);
	let closeCount = 0;
	let uninstallCount = 0;
	let pluginSettingUpdates = 0;
	try {
		await act(async () => {
			root.render(
				<SettingsPanel
					{...baseProps}
					snapshot={{
						settings: baseProps.snapshot?.settings ?? [],
						plugins: [
							{
								name: "example-plugin",
								version: "1.0.0",
								enabled: true,
								enabledFeatures: [],
								availableFeatures: [],
								settings: [
									{
										key: "enabledForReviews",
										type: "boolean",
										description: "Enable review integration",
										secret: false,
										environmentAvailable: false,
										configured: true,
										value: true,
									},
								],
							},
						],
					}}
					initialCategory="plugins"
					onClose={() => {
						closeCount += 1;
					}}
					onUninstallPlugin={() => {
						uninstallCount += 1;
					}}
					onSetPluginSetting={() => {
						pluginSettingUpdates += 1;
					}}
				/>,
			);
			await Bun.sleep(10);
		});
		const search = domWindow.document.querySelector('input[aria-label="Search settings"]');
		if (!search) throw new Error("Settings search did not render");
		expect(domWindow.document.activeElement === search).toBe(true);
		expect(domWindow.document.body.textContent).toContain("Plugin settings");
		const pluginSetting = domWindow.document.querySelector(
			'input[aria-label="example-plugin enabledForReviews"]',
		) as HTMLInputElement | null;
		await act(async () => pluginSetting?.click());
		expect(pluginSettingUpdates).toBe(1);

		const uninstall = Array.from(domWindow.document.querySelectorAll("button")).find(
			button => button.textContent?.trim() === "Uninstall",
		);
		expect(uninstall).toBeDefined();
		await act(async () => uninstall?.click());
		expect(uninstallCount).toBe(0);
		expect(domWindow.document.querySelector('[role="alertdialog"]')?.textContent).toContain(
			"Uninstall example-plugin?",
		);

		const confirm = Array.from(domWindow.document.querySelectorAll("button")).find(
			button => button.textContent?.trim() === "Uninstall plugin",
		);
		await act(async () => confirm?.click());
		expect(uninstallCount).toBe(1);

		await act(async () => {
			domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape" }));
		});
		expect(closeCount).toBe(1);
	} finally {
		await act(async () => root.unmount());
		await Bun.sleep(10);
		expect(domWindow.document.activeElement).toBe(trigger);
		await domWindow.close();
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});
