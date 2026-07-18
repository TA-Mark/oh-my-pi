import { Bug, RefreshCw, Settings2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
	ContextSnapshot,
	DesktopHostToolConfig,
	HostToolAction,
	MarketplacePluginDescriptor,
	MarketplaceSnapshot,
	McpServerStatus,
	MemorySearchResult,
	MemoryStatus,
	RpcPluginDescriptor,
	RpcSettingCategory,
	RpcSettingDescriptor,
	RpcSettingsSnapshot,
} from "../lib/rpc-protocol";

const HOST_ACTIONS: Array<{
	action: HostToolAction;
	label: string;
	defaultName: string;
	description: string;
	argument: string;
}> = [
	{
		action: "open_external_url",
		label: "Open external URL",
		defaultName: "desktop_open_url",
		description: "Open a credential-free http(s) or mailto URL in the system browser",
		argument: "url",
	},
	{
		action: "reveal_path",
		label: "Reveal path",
		defaultName: "desktop_reveal_path",
		description: "Reveal a file or directory in the system file manager",
		argument: "path",
	},
	{
		action: "copy_text",
		label: "Copy text",
		defaultName: "desktop_copy_text",
		description: "Copy text to the system clipboard",
		argument: "text",
	},
	{
		action: "read_workspace_file",
		label: "Read workspace file",
		defaultName: "desktop_read_workspace_file",
		description: "Read a bounded text file inside the active workspace",
		argument: "path",
	},
];

const CATEGORIES: Array<{ id: RpcSettingCategory; label: string }> = [
	{ id: "providers", label: "Providers" },
	{ id: "tools", label: "Tools" },
	{ id: "mcp", label: "MCP" },
	{ id: "plugins", label: "Plugins" },
	{ id: "skills", label: "Skills" },
	{ id: "memory", label: "Memory" },
	{ id: "retry", label: "Retry" },
	{ id: "compaction", label: "Compaction" },
];

export interface SettingsPanelProps {
	open: boolean;
	snapshot: RpcSettingsSnapshot | null;
	loading: boolean;
	error: string | null;
	savingKey: string | null;
	initialCategory?: RpcSettingCategory;
	mcpServers: McpServerStatus[];
	memoryStatus: MemoryStatus | null;
	memorySearch: MemorySearchResult | null;
	marketplace: MarketplaceSnapshot | null;
	marketplaceError: string | null;
	skillDetails: ContextSnapshot["skillDetails"];
	skillWarnings: ContextSnapshot["skillWarnings"];
	hostTools: DesktopHostToolConfig[];
	workspaceUriEnabled: boolean;
	onRefresh: () => void;
	onOpenDiagnostics: () => void;
	onSaveSetting: (path: string, value: unknown) => void;
	onSetPluginEnabled: (name: string, enabled: boolean) => void;
	onSetPluginFeatures: (name: string, features: string[]) => void;
	onInstallPlugin: (spec: string) => void;
	onUpdatePlugin: (name: string) => void;
	onUninstallPlugin: (name: string) => void;
	onRefreshMarketplace: () => void;
	onAddMarketplace: (source: string) => void;
	onUpdateMarketplace: (name: string) => void;
	onRemoveMarketplace: (name: string) => void;
	onInstallMarketplacePlugin: (name: string, marketplace: string, scope: "user" | "project") => void;
	onUpgradeMarketplacePlugin: (pluginId: string, scope: "user" | "project") => void;
	onUninstallMarketplacePlugin: (pluginId: string, scope: "user" | "project") => void;
	onSetMarketplacePluginEnabled: (pluginId: string, enabled: boolean, scope: "user" | "project") => void;
	onRefreshMcp: () => void;
	onReconnectMcp: (name: string) => void;
	onSetMcpEnabled: (name: string, enabled: boolean) => void;
	onUnauthMcp: (name: string) => void;
	onReauthMcp: (name: string) => void;
	onRefreshMemory: () => void;
	onSearchMemory: (query: string) => void;
	onSaveMemory: (content: string) => void;
	onEnqueueMemory: () => void;
	onClearMemory: () => void;
	onAddMemoryContext: (item: MemorySearchResult["items"][number]) => void;
	onReloadSkills: () => void;
	onSetSkillEnabled: (name: string, enabled: boolean) => void;
	onHostToolsChange: (tools: DesktopHostToolConfig[]) => void;
	onWorkspaceUriEnabledChange: (enabled: boolean) => void;
	onClose: () => void;
}

function SettingEditor({
	setting,
	disabled,
	onSave,
}: {
	setting: RpcSettingDescriptor;
	disabled: boolean;
	onSave: (value: unknown) => void;
}) {
	const serialized =
		setting.type === "array" || setting.type === "record"
			? JSON.stringify(setting.value ?? (setting.type === "array" ? [] : {}), null, 2)
			: String(setting.value ?? "");
	const [draft, setDraft] = useState(serialized);
	const [validationError, setValidationError] = useState<string | null>(null);
	useEffect(() => {
		setDraft(serialized);
		setValidationError(null);
	}, [serialized]);
	if (setting.type === "boolean")
		return (
			<input
				type="checkbox"
				checked={setting.value === true}
				disabled={disabled}
				onChange={event => onSave(event.currentTarget.checked)}
			/>
		);
	if (setting.type === "enum")
		return (
			<select
				className="settings-select"
				value={draft}
				disabled={disabled}
				onChange={event => onSave(event.currentTarget.value)}
			>
				{setting.options?.map(option => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		);
	if (setting.type === "array" || setting.type === "record")
		return (
			<div className="settings-structured">
				<textarea
					value={draft}
					disabled={disabled}
					onChange={event => {
						setDraft(event.currentTarget.value);
						setValidationError(null);
					}}
				/>
				<button
					type="button"
					disabled={disabled || draft === serialized}
					onClick={() => {
						try {
							onSave(JSON.parse(draft));
						} catch (error) {
							setValidationError(error instanceof Error ? error.message : "Invalid JSON");
						}
					}}
				>
					Save JSON
				</button>
				{validationError ? <span className="settings-validation-error">{validationError}</span> : null}
			</div>
		);
	return (
		<input
			className="settings-input"
			type={setting.type === "number" ? "number" : "text"}
			value={draft}
			disabled={disabled}
			onChange={event => setDraft(event.currentTarget.value)}
			onBlur={() => {
				if (draft !== serialized) onSave(setting.type === "number" ? Number(draft) : draft || null);
			}}
		/>
	);
}

function PluginRow({
	plugin,
	busy,
	onEnabled,
	onFeatures,
	onUpdate,
	onUninstall,
}: {
	plugin: RpcPluginDescriptor;
	busy: boolean;
	onEnabled: (enabled: boolean) => void;
	onFeatures: (features: string[]) => void;
	onUpdate: () => void;
	onUninstall: () => void;
}) {
	return (
		<div className="settings-config-row">
			<div className="settings-config-copy">
				<strong>
					{plugin.name} <small>v{plugin.version}</small>
				</strong>
				<span>{plugin.description ?? "OMP plugin"}</span>
				{plugin.availableFeatures.length > 0 ? (
					<div className="plugin-feature-list">
						{plugin.availableFeatures.map(feature => (
							<label key={feature}>
								<input
									type="checkbox"
									checked={plugin.enabledFeatures.includes(feature)}
									disabled={busy || !plugin.enabled}
									onChange={event => {
										const selected = event.currentTarget.checked
											? [...plugin.enabledFeatures, feature]
											: plugin.enabledFeatures.filter(name => name !== feature);
										onFeatures([...new Set(selected)]);
									}}
								/>
								{feature}
							</label>
						))}
					</div>
				) : null}
			</div>
			<div className="settings-control">
				<input
					type="checkbox"
					checked={plugin.enabled}
					disabled={busy}
					onChange={event => onEnabled(event.currentTarget.checked)}
				/>
				<button type="button" disabled={busy} onClick={onUpdate}>
					Update
				</button>
				<button type="button" disabled={busy} onClick={onUninstall}>
					Uninstall
				</button>
			</div>
		</div>
	);
}

function MarketplacePluginRow({
	plugin,
	busy,
	onInstall,
	onUpgrade,
	onUninstall,
	onEnabled,
}: {
	plugin: MarketplacePluginDescriptor;
	busy: boolean;
	onInstall: (scope: "user" | "project") => void;
	onUpgrade: (scope: "user" | "project") => void;
	onUninstall: (scope: "user" | "project") => void;
	onEnabled: (scope: "user" | "project", enabled: boolean) => void;
}) {
	return (
		<div className="settings-config-row marketplace-plugin-row">
			<div className="settings-config-copy">
				<strong>
					{plugin.name} {plugin.version ? <small>v{plugin.version}</small> : null}
				</strong>
				<span>{plugin.description ?? `Plugin from ${plugin.marketplace}`}</span>
				<code>
					{plugin.marketplace}
					{plugin.author ? ` · ${plugin.author}` : ""}
					{plugin.category ? ` · ${plugin.category}` : ""}
				</code>
				{plugin.tags?.length ? <span>{plugin.tags.join(" · ")}</span> : null}
				{plugin.homepage ? (
					<code>{plugin.homepage}</code>
				) : plugin.repository ? (
					<code>{plugin.repository}</code>
				) : null}
			</div>
			<div className="marketplace-installations">
				{plugin.installations.length === 0 ? (
					<div className="settings-control">
						<button type="button" disabled={busy} onClick={() => onInstall("user")}>
							Install for user
						</button>
						<button type="button" disabled={busy} onClick={() => onInstall("project")}>
							Install for project
						</button>
					</div>
				) : (
					plugin.installations.map(installation => (
						<div className="marketplace-installation" key={installation.scope}>
							<label>
								<input
									type="checkbox"
									checked={installation.enabled}
									disabled={busy || installation.shadowed}
									onChange={event => onEnabled(installation.scope, event.currentTarget.checked)}
								/>
								{installation.scope} · v{installation.version}
								{installation.shadowed ? " · shadowed" : ""}
							</label>
							<div className="settings-control">
								<button type="button" disabled={busy} onClick={() => onUpgrade(installation.scope)}>
									Update
								</button>
								<button type="button" disabled={busy} onClick={() => onUninstall(installation.scope)}>
									Uninstall
								</button>
							</div>
						</div>
					))
				)}
			</div>
		</div>
	);
}

export function SettingsPanel(props: SettingsPanelProps) {
	const [category, setCategory] = useState<RpcSettingCategory>(props.initialCategory ?? "providers");
	const [pluginSpec, setPluginSpec] = useState("");
	const [marketplaceSource, setMarketplaceSource] = useState("");
	const [memoryQuery, setMemoryQuery] = useState("");
	const [memoryDraft, setMemoryDraft] = useState("");
	const [hostAction, setHostAction] = useState<HostToolAction>("open_external_url");
	const selectedHostAction = HOST_ACTIONS.find(item => item.action === hostAction) ?? HOST_ACTIONS[0];
	const [hostToolName, setHostToolName] = useState(selectedHostAction.defaultName);
	useEffect(() => {
		if (props.open && props.initialCategory) setCategory(props.initialCategory);
	}, [props.open, props.initialCategory]);
	useEffect(() => {
		if (props.open && !props.snapshot) props.onRefresh();
	}, [props.open, props.snapshot, props.onRefresh]);
	useEffect(() => {
		if (props.open && category === "mcp") props.onRefreshMcp();
	}, [props.open, category, props.onRefreshMcp]);
	useEffect(() => {
		if (props.open && category === "memory") props.onRefreshMemory();
	}, [props.open, category, props.onRefreshMemory]);
	useEffect(() => {
		if (props.open && category === "plugins") props.onRefreshMarketplace();
	}, [props.open, category, props.onRefreshMarketplace]);
	const settings = useMemo(
		() => props.snapshot?.settings.filter(setting => setting.category === category) ?? [],
		[props.snapshot, category],
	);
	const ignoredSkills = useMemo(() => {
		const value = props.snapshot?.settings.find(setting => setting.path === "skills.ignoredSkills")?.value;
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	}, [props.snapshot]);
	const addHostTool = () => {
		const name = hostToolName.trim();
		if (!name || props.hostTools.some(tool => tool.name === name)) return;
		props.onHostToolsChange([
			...props.hostTools,
			{
				name,
				label: selectedHostAction.label,
				description: selectedHostAction.description,
				parameters: {
					type: "object",
					properties: { [selectedHostAction.argument]: { type: "string" } },
					required: [selectedHostAction.argument],
					additionalProperties: false,
				},
				loadMode: "discoverable",
				action: selectedHostAction.action,
				requiresApproval: true,
			},
		]);
	};
	if (!props.open) return null;
	return (
		<div className="settings-layer">
			<button type="button" className="settings-backdrop" aria-label="Close settings" onClick={props.onClose} />
			<section className="settings-panel" role="dialog" aria-modal="true" aria-label="Settings">
				<header className="settings-panel-head">
					<span>
						<Settings2 size={17} /> Settings
					</span>
					<div>
						<button
							type="button"
							className="top-icon-button"
							onClick={props.onRefresh}
							aria-label="Refresh settings"
						>
							<RefreshCw size={16} />
						</button>
						<button
							type="button"
							className="top-icon-button"
							onClick={props.onOpenDiagnostics}
							aria-label="Open diagnostics"
						>
							<Bug size={16} />
						</button>
						<button type="button" className="top-icon-button" onClick={props.onClose} aria-label="Close settings">
							<X size={16} />
						</button>
					</div>
				</header>
				<div className="settings-layout">
					<nav className="settings-nav">
						{CATEGORIES.map(item => (
							<button
								type="button"
								key={item.id}
								className={category === item.id ? "active" : ""}
								onClick={() => setCategory(item.id)}
							>
								{item.label}
							</button>
						))}
					</nav>
					<div className="settings-content">
						<div className="settings-content-head">
							<h2>{CATEGORIES.find(item => item.id === category)?.label}</h2>
						</div>
						{category === "plugins" ? (
							<>
								<div className="settings-plugin-install">
									<div>
										<strong>Install a plugin directly</strong>
										<span>Use an npm package, Git URL, GitHub repository, or local plugin path.</span>
									</div>
									<div className="settings-control">
										<input
											className="settings-input"
											value={pluginSpec}
											onChange={event => setPluginSpec(event.currentTarget.value)}
											placeholder="npm package or git plugin spec"
										/>
										<button
											type="button"
											disabled={!pluginSpec.trim() || props.savingKey !== null}
											onClick={() => props.onInstallPlugin(pluginSpec.trim())}
										>
											Install
										</button>
									</div>
								</div>
								{props.snapshot?.plugins.map(plugin => (
									<PluginRow
										key={plugin.name}
										plugin={plugin}
										busy={props.savingKey !== null}
										onEnabled={enabled => props.onSetPluginEnabled(plugin.name, enabled)}
										onFeatures={features => props.onSetPluginFeatures(plugin.name, features)}
										onUpdate={() => props.onUpdatePlugin(plugin.name)}
										onUninstall={() => props.onUninstallPlugin(plugin.name)}
									/>
								))}
								<div className="settings-section-head">
									<div>
										<strong>Marketplace</strong>
										<span>Discovered through the OMP plugin registry</span>
									</div>
									<button
										type="button"
										disabled={props.savingKey !== null}
										onClick={props.onRefreshMarketplace}
									>
										<RefreshCw size={14} /> Refresh
									</button>
								</div>
								<div className="marketplace-manager">
									<div>
										<strong>Add a marketplace</strong>
										<span>
											A marketplace makes its plugin catalog available for discovery and installation.
										</span>
									</div>
									<div className="settings-control">
										<input
											className="settings-input"
											value={marketplaceSource}
											onChange={event => setMarketplaceSource(event.currentTarget.value)}
											placeholder="GitHub repo, Git URL, catalog URL, or local path"
										/>
										<button
											type="button"
											disabled={!marketplaceSource.trim() || props.savingKey !== null}
											onClick={() => props.onAddMarketplace(marketplaceSource.trim())}
										>
											Add
										</button>
									</div>
									{props.marketplace?.marketplaces.length ? null : (
										<button
											type="button"
											className="marketplace-official-button"
											disabled={props.savingKey !== null}
											onClick={() => props.onAddMarketplace("anthropics/claude-plugins-official")}
										>
											Add recommended official marketplace
										</button>
									)}
									{props.marketplaceError ? (
										<div className="settings-validation-error" role="alert">
											{props.marketplaceError}
										</div>
									) : null}
								</div>
								{props.marketplace?.marketplaces.length ? (
									<div className="marketplace-sources">
										{props.marketplace.marketplaces.map(source => (
											<div className="marketplace-source" key={source.name}>
												<div>
													<strong>{source.name}</strong>
													<span>
														{source.sourceType} · updated {new Date(source.updatedAt).toLocaleString()}
													</span>
												</div>
												<div className="settings-control">
													<button
														type="button"
														disabled={props.savingKey !== null}
														onClick={() => props.onUpdateMarketplace(source.name)}
													>
														Update
													</button>
													<button
														type="button"
														className="danger"
														disabled={props.savingKey !== null}
														onClick={() => props.onRemoveMarketplace(source.name)}
													>
														Remove
													</button>
												</div>
											</div>
										))}
									</div>
								) : (
									<p className="settings-empty">
										No plugin marketplaces are configured yet. Add the recommended catalog above to browse
										plugins.
									</p>
								)}
								{props.marketplace?.plugins.map(plugin => (
									<MarketplacePluginRow
										key={plugin.id}
										plugin={plugin}
										busy={props.savingKey !== null}
										onInstall={scope =>
											props.onInstallMarketplacePlugin(plugin.name, plugin.marketplace, scope)
										}
										onUpgrade={scope => props.onUpgradeMarketplacePlugin(plugin.id, scope)}
										onUninstall={scope => props.onUninstallMarketplacePlugin(plugin.id, scope)}
										onEnabled={(scope, enabled) =>
											props.onSetMarketplacePluginEnabled(plugin.id, enabled, scope)
										}
									/>
								))}
							</>
						) : category === "mcp" ? (
							<>
								{props.mcpServers.map(server => (
									<div className="settings-config-row" key={server.name}>
										<div className="settings-config-copy">
											<strong>{server.name}</strong>
											<span>
												{server.enabled ? server.status : "disabled"} · {server.transport} ·{" "}
												{server.toolCount} tools
											</span>
											<code>
												OAuth: {String(server.auth.oauth)} · credential:{" "}
												{server.auth.credentialAvailable
													? "available"
													: server.auth.credentialConfigured
														? "missing"
														: "not configured"}
											</code>
											{server.lastError ? (
												<code className="settings-runtime-error">Last error: {server.lastError}</code>
											) : null}
										</div>
										<div className="settings-control">
											<button
												type="button"
												disabled={!server.enabled}
												onClick={() => props.onReconnectMcp(server.name)}
											>
												Reconnect
											</button>
											{server.auth.oauth &&
											(server.auth.credentialAvailable || server.auth.credentialConfigured) ? (
												<button type="button" onClick={() => props.onUnauthMcp(server.name)}>
													Sign out
												</button>
											) : null}
											{server.auth.oauth ? (
												<button
													type="button"
													disabled={!server.enabled}
													onClick={() => props.onReauthMcp(server.name)}
												>
													Reauthorize
												</button>
											) : null}
											<button
												type="button"
												onClick={() => props.onSetMcpEnabled(server.name, !server.enabled)}
											>
												{server.enabled ? "Disable" : "Enable"}
											</button>
										</div>
									</div>
								))}
								{props.mcpServers.length === 0 ? (
									<div className="settings-empty">No MCP servers are configured for this workspace.</div>
								) : null}
							</>
						) : category === "skills" ? (
							<>
								<div className="settings-control">
									<button type="button" disabled={props.savingKey !== null} onClick={props.onReloadSkills}>
										Reload discovery
									</button>
								</div>
								{props.skillDetails.map(skill => (
									<div className="settings-config-row" key={skill.filePath}>
										<div className="settings-config-copy">
											<strong>{skill.name}</strong>
											<span>{skill.description}</span>
											<code>{skill.source}</code>
										</div>
										<div className="settings-control">
											<button type="button" onClick={() => props.onSetSkillEnabled(skill.name, false)}>
												Disable
											</button>
										</div>
									</div>
								))}
								{ignoredSkills
									.filter(name => !props.skillDetails.some(skill => skill.name === name))
									.map(name => (
										<div className="settings-config-row" key={`ignored:${name}`}>
											<div className="settings-config-copy">
												<strong>{name}</strong>
												<span>Disabled by skills.ignoredSkills</span>
											</div>
											<div className="settings-control">
												<button type="button" onClick={() => props.onSetSkillEnabled(name, true)}>
													Enable
												</button>
											</div>
										</div>
									))}
								{props.skillWarnings.map(warning => (
									<div className="settings-validation-error" key={`${warning.skillPath}:${warning.message}`}>
										{warning.skillPath}: {warning.message}
									</div>
								))}
							</>
						) : category === "memory" ? (
							<>
								<div className="settings-config-row">
									<div className="settings-config-copy">
										<strong>{props.memoryStatus?.backend ?? "Memory"}</strong>
										<span>
											{props.memoryStatus?.message ??
												(props.memoryStatus?.active ? "Backend active" : "Backend inactive")}
										</span>
										<code>
											active: {String(props.memoryStatus?.active ?? false)} · writable:{" "}
											{String(props.memoryStatus?.writable ?? false)} · searchable:{" "}
											{String(props.memoryStatus?.searchable ?? false)}
										</code>
										{props.memoryStatus?.scope ? <code>scope: {props.memoryStatus.scope}</code> : null}
										{props.memoryStatus?.error ? (
											<code className="settings-runtime-error">{props.memoryStatus.error}</code>
										) : null}
									</div>
									<div className="settings-control">
										<input
											className="settings-input"
											value={memoryQuery}
											onChange={event => setMemoryQuery(event.currentTarget.value)}
											placeholder="Search memory records"
										/>
										<button
											type="button"
											disabled={!memoryQuery.trim()}
											onClick={() => props.onSearchMemory(memoryQuery.trim())}
										>
											Search
										</button>
									</div>
								</div>
								<div className="settings-config-row">
									<div className="settings-config-copy">
										<strong>Store a durable memory</strong>
										<span>The active OMP backend controls where and how this record is persisted.</span>
									</div>
									<div className="settings-control settings-memory-actions">
										<textarea
											className="settings-input"
											value={memoryDraft}
											onChange={event => setMemoryDraft(event.currentTarget.value)}
											placeholder="Fact, preference, or project decision"
										/>
										<button
											type="button"
											disabled={
												!memoryDraft.trim() || !props.memoryStatus?.writable || props.savingKey !== null
											}
											onClick={() => {
												props.onSaveMemory(memoryDraft.trim());
												setMemoryDraft("");
											}}
										>
											Save memory
										</button>
										<button type="button" disabled={props.savingKey !== null} onClick={props.onEnqueueMemory}>
											Consolidate now
										</button>
										<button type="button" disabled={props.savingKey !== null} onClick={props.onClearMemory}>
											Clear backend
										</button>
									</div>
								</div>
								{props.memorySearch?.items.map(item => (
									<div className="settings-config-row" key={item.id ?? item.content}>
										<div className="settings-config-copy">
											<strong>{item.source ?? "Memory record"}</strong>
											<span>{item.content}</span>
										</div>
										<div className="settings-control">
											<button type="button" onClick={() => props.onAddMemoryContext(item)}>
												Add to context
											</button>
										</div>
									</div>
								))}
							</>
						) : category === "tools" ? (
							<>
								<div className="settings-config-row">
									<div className="settings-config-copy">
										<strong>Electron host registry</strong>
										<span>Expose explicit desktop actions to OMP through the host-tool bridge.</span>
										<code>Every action is validated; approval is enabled by default.</code>
									</div>
									<div className="settings-control settings-host-control">
										<select
											className="settings-select"
											value={hostAction}
											onChange={event => {
												const action = event.currentTarget.value as HostToolAction;
												setHostAction(action);
												const definition = HOST_ACTIONS.find(item => item.action === action);
												if (definition) setHostToolName(definition.defaultName);
											}}
										>
											{HOST_ACTIONS.map(item => (
												<option key={item.action} value={item.action}>
													{item.label}
												</option>
											))}
										</select>
										<input
											className="settings-input"
											value={hostToolName}
											onChange={event => setHostToolName(event.currentTarget.value)}
											placeholder="Unique tool name"
										/>
										<button type="button" disabled={!hostToolName.trim()} onClick={addHostTool}>
											Register
										</button>
									</div>
								</div>
								{props.hostTools.map(tool => (
									<div className="settings-config-row" key={tool.name}>
										<div className="settings-config-copy">
											<strong>{tool.name}</strong>
											<span>{tool.description}</span>
											<code>{tool.action}</code>
										</div>
										<div className="settings-control">
											<label>
												<input
													type="checkbox"
													checked={tool.requiresApproval}
													onChange={event =>
														props.onHostToolsChange(
															props.hostTools.map(item =>
																item.name === tool.name
																	? { ...item, requiresApproval: event.currentTarget.checked }
																	: item,
															),
														)
													}
												/>
												Ask approval
											</label>
											<button
												type="button"
												onClick={() =>
													props.onHostToolsChange(props.hostTools.filter(item => item.name !== tool.name))
												}
											>
												Remove
											</button>
										</div>
									</div>
								))}
								<div className="settings-config-row">
									<div className="settings-config-copy">
										<strong>workspace:// URI</strong>
										<span>Allow OMP read tools to resolve workspace files through the Electron host.</span>
										<code>Read-only; workspace containment and binary/size guards remain enforced.</code>
									</div>
									<div className="settings-control">
										<input
											type="checkbox"
											checked={props.workspaceUriEnabled}
											onChange={event => props.onWorkspaceUriEnabledChange(event.currentTarget.checked)}
										/>
									</div>
								</div>
								{settings.map(setting => (
									<div className="settings-config-row" key={setting.path}>
										<div className="settings-config-copy">
											<strong>{setting.label}</strong>
											<span>{setting.description}</span>
											<code>{setting.path}</code>
										</div>
										<div className="settings-control">
											<SettingEditor
												setting={setting}
												disabled={props.savingKey !== null}
												onSave={value => props.onSaveSetting(setting.path, value)}
											/>
										</div>
									</div>
								))}
							</>
						) : (
							settings.map(setting => (
								<div className="settings-config-row" key={setting.path}>
									<div className="settings-config-copy">
										<strong>{setting.label}</strong>
										<span>{setting.description}</span>
										<code>{setting.path}</code>
									</div>
									<div className="settings-control">
										<SettingEditor
											setting={setting}
											disabled={props.savingKey !== null}
											onSave={value => props.onSaveSetting(setting.path, value)}
										/>
									</div>
								</div>
							))
						)}
						{props.loading ? <div className="settings-empty">Loading configuration…</div> : null}
						{props.error ? (
							<div className="settings-validation-error settings-panel-error" role="alert">
								{props.error}
							</div>
						) : null}
						{!props.loading &&
						!props.error &&
						settings.length === 0 &&
						(category === "providers" || category === "retry" || category === "compaction") ? (
							<div className="settings-empty">No {category} settings were returned by the OMP core.</div>
						) : null}
					</div>
				</div>
			</section>
		</div>
	);
}
