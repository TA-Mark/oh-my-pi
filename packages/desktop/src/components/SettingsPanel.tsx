import { PanelLeft, RefreshCw, Settings2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
	McpServerStatus,
	MemorySearchResult,
	MemoryStatus,
	PluginDescriptor,
	SettingCategory,
	SettingDescriptor,
	SettingsSnapshot,
} from "../lib/rpc-protocol";
import { ThemeToggle } from "./ThemeToggle";

const CATEGORIES: Array<{ id: SettingCategory; label: string }> = [
	{ id: "providers", label: "Providers" },
	{ id: "tools", label: "Tools" },
	{ id: "mcp", label: "MCP" },
	{ id: "plugins", label: "Plugins" },
	{ id: "skills", label: "Skills" },
	{ id: "memory", label: "Memory" },
	{ id: "retry", label: "Retry" },
	{ id: "compaction", label: "Compaction" },
];

interface SettingsPanelProps {
	open: boolean;
	snapshot: SettingsSnapshot | null;
	loading: boolean;
	savingKey: string | null;
	sidebarCollapsed: boolean;
	onRefresh: () => void;
	onUpdateSetting: (path: string, value: unknown) => void;
	onSetPluginEnabled: (name: string, enabled: boolean) => void;
	onInstallPlugin: (spec: string) => void;
	onUpdatePlugin: (name: string) => void;
	onUninstallPlugin: (name: string) => void;
	mcpServers: McpServerStatus[];
	mcpLoading: boolean;
	onRefreshMcp: () => void;
	onReconnectMcp: (serverName: string) => void;
	onSetMcpEnabled: (serverName: string, enabled: boolean) => void;
	memoryStatus: MemoryStatus | null;
	memorySearch: MemorySearchResult | null;
	memoryLoading: boolean;
	onRefreshMemory: () => void;
	onSearchMemory: (query: string) => void;
	onToggleSidebar: () => void;
	onCopyDiagnostics: () => void;
	initialCategory?: SettingCategory;
	onClose: () => void;
}

function ScalarEditor({
	setting,
	disabled,
	onSave,
}: {
	setting: SettingDescriptor;
	disabled: boolean;
	onSave: (value: unknown) => void;
}) {
	const [draft, setDraft] = useState(setting.value === null ? "" : String(setting.value));
	useEffect(() => setDraft(setting.value === null ? "" : String(setting.value)), [setting.value]);

	if (setting.type === "boolean") {
		return (
			<input
				type="checkbox"
				checked={setting.value === true}
				disabled={disabled}
				onChange={event => onSave(event.currentTarget.checked)}
			/>
		);
	}
	if (setting.type === "enum" || setting.options?.length) {
		return (
			<select
				className="settings-select"
				value={draft}
				disabled={disabled}
				onChange={event => {
					const value = event.currentTarget.value;
					setDraft(value);
					onSave(setting.type === "number" ? Number(value) : value);
				}}
			>
				{setting.options?.map(option => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		);
	}
	const commit = () => {
		if (draft === (setting.value === null ? "" : String(setting.value))) return;
		onSave(setting.type === "number" ? (draft.trim() ? Number(draft) : null) : draft || null);
	};
	return (
		<input
			className="settings-input"
			type={setting.type === "number" ? "number" : "text"}
			value={draft}
			disabled={disabled}
			onChange={event => setDraft(event.currentTarget.value)}
			onBlur={commit}
			onKeyDown={event => {
				if (event.key === "Enter") event.currentTarget.blur();
			}}
		/>
	);
}

function StructuredEditor({
	setting,
	disabled,
	onSave,
}: {
	setting: SettingDescriptor;
	disabled: boolean;
	onSave: (value: unknown) => void;
}) {
	const serialized = JSON.stringify(setting.value ?? (setting.type === "array" ? [] : {}), null, 2);
	const [draft, setDraft] = useState(serialized);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		setDraft(serialized);
		setError(null);
	}, [serialized]);
	return (
		<div className="settings-structured">
			<textarea value={draft} disabled={disabled} onChange={event => setDraft(event.currentTarget.value)} />
			<div>
				{error ? <span className="settings-validation">{error}</span> : null}
				<button
					type="button"
					disabled={disabled || draft === serialized}
					onClick={() => {
						try {
							const value: unknown = JSON.parse(draft);
							setError(null);
							onSave(value);
						} catch {
							setError("Invalid JSON");
						}
					}}
				>
					Save
				</button>
			</div>
		</div>
	);
}

function SettingRow({
	setting,
	savingKey,
	onSave,
}: {
	setting: SettingDescriptor;
	savingKey: string | null;
	onSave: (path: string, value: unknown) => void;
}) {
	const disabled = savingKey !== null;
	return (
		<div className="settings-config-row">
			<div className="settings-config-copy">
				<strong>{setting.label}</strong>
				<span>{setting.description}</span>
				<code>{setting.path}</code>
				{setting.activation === "next_engine_restart" ? <em>Applies after engine restart</em> : null}
			</div>
			<div className="settings-control">
				{setting.type === "array" || setting.type === "record" ? (
					<StructuredEditor setting={setting} disabled={disabled} onSave={value => onSave(setting.path, value)} />
				) : (
					<ScalarEditor setting={setting} disabled={disabled} onSave={value => onSave(setting.path, value)} />
				)}
				{savingKey === setting.path ? <span className="settings-saving">Saving…</span> : null}
			</div>
		</div>
	);
}

function PluginRow({
	plugin,
	savingKey,
	onSetEnabled,
	onUpdate,
	onUninstall,
}: {
	plugin: PluginDescriptor;
	savingKey: string | null;
	onSetEnabled: (name: string, enabled: boolean) => void;
	onUpdate: (name: string) => void;
	onUninstall: (name: string) => void;
}) {
	const key = `plugin:${plugin.name}`;
	return (
		<div className="settings-config-row">
			<div className="settings-config-copy">
				<strong>
					{plugin.name} <small>v{plugin.version}</small>
				</strong>
				<span>{plugin.description ?? "OMP plugin"}</span>
				{plugin.availableFeatures.length ? <code>Features: {plugin.availableFeatures.join(", ")}</code> : null}
			</div>
			<div className="settings-control">
				<input
					type="checkbox"
					checked={plugin.enabled}
					disabled={savingKey !== null}
					onChange={event => onSetEnabled(plugin.name, event.currentTarget.checked)}
				/>
				<button type="button" disabled={savingKey !== null} onClick={() => onUpdate(plugin.name)}>
					Update
				</button>
				<button type="button" disabled={savingKey !== null} onClick={() => onUninstall(plugin.name)}>
					Uninstall
				</button>
				{savingKey === key ? <span className="settings-saving">Reloading…</span> : null}
			</div>
		</div>
	);
}

function McpRow({
	server,
	busy,
	onReconnect,
	onSetEnabled,
}: {
	server: McpServerStatus;
	busy: boolean;
	onReconnect: () => void;
	onSetEnabled: (enabled: boolean) => void;
}) {
	const enabled = server.status !== "disconnected";
	return (
		<div className="settings-config-row">
			<div className="settings-config-copy">
				<strong>{server.name}</strong>
				<span>
					{server.status} · {server.transport} · {server.toolCount} tool{server.toolCount === 1 ? "" : "s"}
				</span>
				<code>
					OAuth: {server.auth.oauth ? "configured" : "not configured"}; credential:{" "}
					{server.auth.credentialConfigured ? "present" : "not present"}
				</code>
			</div>
			<div className="settings-control">
				<input
					type="checkbox"
					checked={enabled}
					disabled={busy}
					onChange={event => onSetEnabled(event.currentTarget.checked)}
				/>
				<button type="button" disabled={busy || server.status === "connected"} onClick={onReconnect}>
					<RefreshCw size={14} /> Reconnect
				</button>
			</div>
		</div>
	);
}

export function SettingsPanel(props: SettingsPanelProps) {
	const [category, setCategory] = useState<SettingCategory>(props.initialCategory ?? "providers");
	const [memoryQuery, setMemoryQuery] = useState("");
	const [pluginSpec, setPluginSpec] = useState("");
	useEffect(() => {
		if (props.open && props.initialCategory) setCategory(props.initialCategory);
	}, [props.initialCategory, props.open]);
	useEffect(() => {
		if (props.open && !props.snapshot) props.onRefresh();
	}, [props.open, props.snapshot, props.onRefresh]);
	useEffect(() => {
		if (props.open && category === "mcp") props.onRefreshMcp();
	}, [props.open, category, props.onRefreshMcp]);
	useEffect(() => {
		if (props.open && category === "memory") props.onRefreshMemory();
	}, [props.open, category, props.onRefreshMemory]);
	const settings = useMemo(
		() => props.snapshot?.settings.filter(setting => setting.category === category) ?? [],
		[props.snapshot, category],
	);
	if (!props.open) return null;
	return (
		<div className="settings-layer">
			<button type="button" className="picker-backdrop" aria-label="Close settings" onClick={props.onClose} />
			<section className="settings-panel" role="dialog" aria-modal="true" aria-label="Settings">
				<header className="settings-panel-head">
					<span>
						<Settings2 size={17} /> Settings
					</span>
					<div>
						<button
							type="button"
							className="top-icon-button"
							aria-label="Refresh settings"
							onClick={props.onRefresh}
							disabled={props.loading}
						>
							<RefreshCw size={16} />
						</button>
						<button type="button" className="top-icon-button" aria-label="Close settings" onClick={props.onClose}>
							<X size={16} />
						</button>
					</div>
				</header>
				<div className="settings-layout">
					<nav className="settings-nav" aria-label="Configuration categories">
						{CATEGORIES.map(item => (
							<button
								key={item.id}
								type="button"
								className={category === item.id ? "active" : ""}
								onClick={() => setCategory(item.id)}
							>
								{item.label}
							</button>
						))}
						<div className="settings-nav-spacer" />
						<div className="settings-nav-utility">
							<span>Theme</span>
							<ThemeToggle />
						</div>
						<button type="button" onClick={props.onToggleSidebar}>
							<PanelLeft size={15} /> {props.sidebarCollapsed ? "Show sidebar" : "Collapse sidebar"}
						</button>
						<button type="button" onClick={props.onCopyDiagnostics}>
							<Settings2 size={15} /> Copy diagnostics
						</button>
					</nav>
					<div className="settings-content">
						<div className="settings-content-head">
							<h2>{CATEGORIES.find(item => item.id === category)?.label}</h2>
							<span>
								{category === "plugins" ? (props.snapshot?.plugins.length ?? 0) : settings.length} entries
							</span>
						</div>
						{props.loading && !props.snapshot ? (
							<div className="settings-empty">Loading configuration…</div>
						) : null}
						{!props.loading && !props.snapshot ? (
							<div className="settings-empty">
								Configuration unavailable.{" "}
								<button type="button" onClick={props.onRefresh}>
									Try again
								</button>
							</div>
						) : null}
						{category === "plugins" ? (
							<div className="settings-control">
								<input
									className="settings-input"
									value={pluginSpec}
									placeholder="npm package or git plugin spec"
									onChange={event => setPluginSpec(event.currentTarget.value)}
								/>
								<button
									type="button"
									disabled={!pluginSpec.trim() || props.savingKey !== null}
									onClick={() => props.onInstallPlugin(pluginSpec.trim())}
								>
									Install
								</button>
							</div>
						) : null}
						{category === "memory" ? (
							<div className="settings-structured">
								<div className="settings-config-copy">
									<strong>{props.memoryStatus?.backend ?? "Memory"}</strong>
									<span>
										{props.memoryStatus?.message ??
											(props.memoryStatus?.active ? "Backend active" : "Backend inactive")}
									</span>
									<code>
										searchable: {String(props.memoryStatus?.searchable ?? false)} · writable:{" "}
										{String(props.memoryStatus?.writable ?? false)}
									</code>
								</div>
								<div className="settings-control">
									<input
										className="settings-input"
										value={memoryQuery}
										placeholder="Search memory records"
										onChange={event => setMemoryQuery(event.currentTarget.value)}
									/>
									<button
										type="button"
										disabled={props.memoryLoading || !memoryQuery.trim()}
										onClick={() => props.onSearchMemory(memoryQuery.trim())}
									>
										Search
									</button>
								</div>
								{props.memorySearch?.items.map(item => (
									<div className="settings-config-row" key={item.id ?? `${item.source}:${item.content}`}>
										<div className="settings-config-copy">
											<strong>{item.source ?? "Memory record"}</strong>
											<span>{item.content}</span>
											{item.timestamp ? <code>{item.timestamp}</code> : null}
										</div>
									</div>
								))}
							</div>
						) : category === "mcp" ? (
							props.mcpLoading && props.mcpServers.length === 0 ? (
								<div className="settings-empty">Loading MCP servers…</div>
							) : props.mcpServers.length === 0 ? (
								<div className="settings-empty">No discovered MCP servers.</div>
							) : (
								props.mcpServers.map(server => (
									<McpRow
										key={server.name}
										server={server}
										busy={props.mcpLoading}
										onReconnect={() => props.onReconnectMcp(server.name)}
										onSetEnabled={enabled => props.onSetMcpEnabled(server.name, enabled)}
									/>
								))
							)
						) : category === "plugins" ? (
							props.snapshot?.plugins.map(plugin => (
								<PluginRow
									key={plugin.name}
									plugin={plugin}
									savingKey={props.savingKey}
									onSetEnabled={props.onSetPluginEnabled}
									onUpdate={props.onUpdatePlugin}
									onUninstall={props.onUninstallPlugin}
								/>
							))
						) : (
							settings.map(setting => (
								<SettingRow
									key={setting.path}
									setting={setting}
									savingKey={props.savingKey}
									onSave={props.onUpdateSetting}
								/>
							))
						)}
						{props.snapshot && category === "plugins" && props.snapshot.plugins.length === 0 ? (
							<div className="settings-empty">No installed plugins.</div>
						) : null}
						{props.snapshot && category !== "plugins" && settings.length === 0 ? (
							<div className="settings-empty">No settings in this category.</div>
						) : null}
					</div>
				</div>
			</section>
		</div>
	);
}
