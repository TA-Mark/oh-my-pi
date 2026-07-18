import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsPanel, type SettingsPanelProps } from "../src/components/SettingsPanel";
import type { RpcSettingCategory, RpcSettingDescriptor } from "../src/lib/rpc-protocol";

const noop = () => {};

function descriptor(category: "providers" | "retry" | "compaction", path: string): RpcSettingDescriptor {
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
		],
		plugins: [],
	},
	loading: false,
	error: null,
	savingKey: null,
	mcpServers: [],
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
	onSetPluginEnabled: noop,
	onSetPluginFeatures: noop,
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
	onReconnectMcp: noop,
	onSetMcpEnabled: noop,
	onUnauthMcp: noop,
	onReauthMcp: noop,
	onRefreshMemory: noop,
	onSearchMemory: noop,
	onSaveMemory: noop,
	onEnqueueMemory: noop,
	onClearMemory: noop,
	onAddMemoryContext: noop,
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
	for (const label of ["Providers", "Tools", "MCP", "Plugins", "Skills", "Memory", "Retry", "Compaction"]) {
		expect(markup).toContain(`>${label}</button>`);
	}
});

test("every settings category renders discoverable content", () => {
	expect(renderCategory("providers")).toContain("providers control");
	expect(renderCategory("tools")).toContain("Electron host registry");
	expect(renderCategory("mcp")).toContain("No MCP servers are configured");
	expect(renderCategory("plugins")).toContain("Install a plugin directly");
	expect(renderCategory("skills")).toContain("Reload discovery");
	expect(renderCategory("memory")).toContain("Store a durable memory");
	expect(renderCategory("retry")).toContain("retry control");
	expect(renderCategory("compaction")).toContain("compaction control");
});
