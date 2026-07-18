import { clearPluginRootsAndCaches, resolveOrDefaultProjectRegistryPath } from "../../discovery/helpers";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "../../extensibility/plugins/marketplace";
import { buildPluginId, parsePluginId } from "../../extensibility/plugins/marketplace/types";
import type { RpcMarketplacePluginDescriptor, RpcMarketplaceSnapshot } from "./rpc-types";

export async function createRpcMarketplaceManager(cwd: string): Promise<MarketplaceManager> {
	return new MarketplaceManager({
		marketplacesRegistryPath: getMarketplacesRegistryPath(),
		installedRegistryPath: getInstalledPluginsRegistryPath(),
		projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(cwd),
		marketplacesCacheDir: getMarketplacesCacheDir(),
		pluginsCacheDir: getPluginsCacheDir(),
		clearPluginRootsCache: clearPluginRootsAndCaches,
	});
}

export async function buildRpcMarketplaceSnapshot(cwd: string): Promise<RpcMarketplaceSnapshot> {
	const manager = await createRpcMarketplaceManager(cwd);
	const [marketplaces, installed] = await Promise.all([manager.listMarketplaces(), manager.listInstalledPlugins()]);
	const installedById = new Map<string, RpcMarketplacePluginDescriptor["installations"]>();
	for (const summary of installed) {
		const first = summary.entries[0];
		if (!first) continue;
		const installations = installedById.get(summary.id) ?? [];
		installations.push({
			scope: summary.scope,
			version: first.version,
			enabled: first.enabled !== false,
			shadowed: summary.shadowedBy !== undefined,
		});
		installedById.set(summary.id, installations);
	}

	const plugins: RpcMarketplacePluginDescriptor[] = [];
	for (const marketplace of marketplaces) {
		for (const plugin of await manager.listAvailablePlugins(marketplace.name)) {
			const id = buildPluginId(plugin.name, marketplace.name);
			plugins.push({
				id,
				name: plugin.name,
				marketplace: marketplace.name,
				description: plugin.description,
				version: plugin.version,
				author: plugin.author?.name,
				homepage: plugin.homepage,
				repository: plugin.repository,
				license: plugin.license,
				keywords: plugin.keywords,
				category: plugin.category,
				tags: plugin.tags,
				installations: installedById.get(id) ?? [],
			});
			installedById.delete(id);
		}
	}
	for (const [id, installations] of installedById) {
		const parsed = parsePluginId(id);
		if (!parsed) continue;
		plugins.push({ id, ...parsed, installations });
	}
	plugins.sort((a, b) => a.id.localeCompare(b.id));
	return {
		marketplaces: marketplaces.map(marketplace => ({
			name: marketplace.name,
			sourceType: marketplace.sourceType,
			updatedAt: marketplace.updatedAt,
		})),
		plugins,
	};
}
