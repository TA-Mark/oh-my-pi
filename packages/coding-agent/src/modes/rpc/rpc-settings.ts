import type { Settings } from "../../config/settings";
import { getEnumValues, getType, getUi, SETTINGS_SCHEMA, type SettingPath } from "../../config/settings-schema";
import { PluginManager } from "../../extensibility/plugins/manager";
import type { InstalledPlugin } from "../../extensibility/plugins/types";
import type {
	RpcPluginDescriptor,
	RpcSettingCategory,
	RpcSettingDescriptor,
	RpcSettingOption,
	RpcSettingsSnapshot,
} from "./rpc-types";

const SECRET_PATH = /(api.?key|credential|password|secret|token)/i;

function categoryFor(path: SettingPath): Exclude<RpcSettingCategory, "plugins"> | undefined {
	const ui = getUi(path);
	if (path === "disabledProviders" || path.startsWith("providers.") || ui?.tab === "providers") return "providers";
	// Electron exposes the runtime-facing tabs through its Tools settings page.
	// Terminal-only appearance/status-line settings intentionally remain hidden.
	if (ui?.tab && ["interaction", "context", "files", "shell", "tasks", "model", "tools"].includes(ui.tab))
		return "tools";
	if (path.startsWith("tools.") || path.startsWith("todo.")) return "tools";
	if (path.startsWith("mcp.")) return "mcp";
	if (path.startsWith("skills.")) return "skills";
	if (/^(memory|memories|mnemopi|hindsight|autolearn)\./.test(path)) return "memory";
	if (path.startsWith("retry.")) return "retry";
	if (path.startsWith("compaction.")) return "compaction";
	return undefined;
}

function humanize(path: string): string {
	const name = path.split(".").at(-1) ?? path;
	return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, char => char.toUpperCase());
}

function optionsFor(path: SettingPath): RpcSettingOption[] | undefined {
	const uiOptions = getUi(path)?.options;
	if (Array.isArray(uiOptions)) return uiOptions.map(option => ({ ...option }));
	const enumValues = getEnumValues(path);
	return enumValues?.map(value => ({ value, label: humanize(value) }));
}

function toPluginDescriptor(plugin: InstalledPlugin): RpcPluginDescriptor {
	const availableFeatures = Object.keys(plugin.manifest.features ?? {});
	const defaultFeatures = availableFeatures.filter(name => plugin.manifest.features?.[name]?.default === true);
	return {
		name: plugin.name,
		version: plugin.version,
		description: plugin.manifest.description,
		enabled: plugin.enabled,
		enabledFeatures: plugin.enabledFeatures ?? defaultFeatures,
		availableFeatures,
	};
}

export async function buildRpcSettingsSnapshot(settings: Settings, cwd: string): Promise<RpcSettingsSnapshot> {
	const descriptors: RpcSettingDescriptor[] = [];
	for (const path of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
		if (!categoryFor(path) || SECRET_PATH.test(path)) continue;
		descriptors.push(getRpcSettingDescriptor(settings, path));
	}
	const plugins = (await new PluginManager(cwd).list()).map(toPluginDescriptor);
	return { settings: descriptors, plugins };
}

export function getRpcSettingDescriptor(settings: Settings, rawPath: string): RpcSettingDescriptor {
	if (!(rawPath in SETTINGS_SCHEMA)) throw new Error(`Unknown setting: ${rawPath}`);
	const path = rawPath as SettingPath;
	const category = categoryFor(path);
	if (!category || SECRET_PATH.test(path)) throw new Error(`Setting is not available over RPC: ${path}`);
	const ui = getUi(path);
	return {
		path,
		category,
		type: getType(path),
		value: settings.get(path) ?? null,
		configured: settings.isConfigured(path),
		label: ui?.label ?? humanize(path),
		description: ui?.description ?? `Configure ${humanize(path).toLocaleLowerCase()}.`,
		group: ui?.group,
		options: optionsFor(path),
		activation: category === "mcp" ? "next_engine_restart" : "immediate",
	};
}

function normalizeSettingValue(path: SettingPath, value: unknown): unknown {
	const type = getType(path);
	if (value === null && (type === "string" || type === "number" || type === "boolean")) return undefined;
	if (type === "boolean" && typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
	if (type === "string" && typeof value !== "string") throw new Error(`${path} must be a string`);
	if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
		throw new Error(`${path} must be a finite number`);
	}
	if (type === "enum") {
		const values = getEnumValues(path) ?? [];
		if (typeof value !== "string" || !values.includes(value)) {
			throw new Error(`${path} must be one of: ${values.join(", ")}`);
		}
	}
	if (type === "array" && (!Array.isArray(value) || value.some(item => typeof item !== "string"))) {
		throw new Error(`${path} must be an array of strings`);
	}
	if (type === "record" && (typeof value !== "object" || value === null || Array.isArray(value))) {
		throw new Error(`${path} must be an object`);
	}
	return value;
}

export async function setRpcSetting(
	settings: Settings,
	rawPath: string,
	value: unknown,
): Promise<RpcSettingDescriptor> {
	if (!(rawPath in SETTINGS_SCHEMA)) throw new Error(`Unknown setting: ${rawPath}`);
	const path = rawPath as SettingPath;
	const category = categoryFor(path);
	if (!category || SECRET_PATH.test(path)) throw new Error(`Setting is not available over RPC: ${path}`);
	settings.set(path, normalizeSettingValue(path, value) as never);
	await settings.flush();
	return getRpcSettingDescriptor(settings, path);
}

export async function setRpcPluginEnabled(cwd: string, name: string, enabled: boolean): Promise<RpcPluginDescriptor> {
	const manager = new PluginManager(cwd);
	await manager.setEnabled(name, enabled);
	const plugin = (await manager.list()).find(candidate => candidate.name === name);
	if (!plugin) throw new Error(`Plugin not found: ${name}`);
	return toPluginDescriptor(plugin);
}

export async function setRpcPluginFeatures(
	cwd: string,
	name: string,
	features: string[] | null,
): Promise<RpcPluginDescriptor> {
	const manager = new PluginManager(cwd);
	await manager.setEnabledFeatures(name, features);
	const plugin = (await manager.list()).find(candidate => candidate.name === name);
	if (!plugin) throw new Error(`Plugin not found: ${name}`);
	return toPluginDescriptor(plugin);
}

export async function getRpcPluginDescriptor(cwd: string, name: string): Promise<RpcPluginDescriptor> {
	const plugin = (await new PluginManager(cwd).list()).find(candidate => candidate.name === name);
	if (!plugin) throw new Error(`Plugin not found: ${name}`);
	return toPluginDescriptor(plugin);
}
