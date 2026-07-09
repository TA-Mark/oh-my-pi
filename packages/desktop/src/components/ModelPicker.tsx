import { Bot, Check, ChevronDown, ChevronRight, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { LoginProvider, ModelInfo } from "../lib/rpc-protocol";

interface ModelPickerProps {
	current?: string;
	models: ModelInfo[];
	providers: LoginProvider[];
	disabled?: boolean;
	onSelect: (provider: string, id: string) => void;
}

const MAX_VISIBLE = 200;

function splitModelLabel(label?: string): { provider?: string; id?: string } {
	if (!label) return {};
	const slash = label.indexOf("/");
	if (slash < 0) return { id: label };
	return { provider: label.slice(0, slash), id: label.slice(slash + 1) };
}

function formatContextWindow(value?: number): string | undefined {
	if (value == null) return undefined;
	if (value >= 1000) return `${Math.round(value / 1000).toLocaleString()}k ctx`;
	return `${value.toLocaleString()} ctx`;
}

function providerName(providers: LoginProvider[], providerId: string): string {
	return providers.find(provider => provider.id === providerId)?.name ?? providerId;
}

export function ModelPicker({ current, models, providers, disabled, onSelect }: ModelPickerProps) {
	const [open, setOpen] = useState(false);
	const [filter, setFilter] = useState("");
	const [collapsedProviders, setCollapsedProviders] = useState<Set<string>>(() => new Set());
	const currentModel = splitModelLabel(current);

	const grouped = useMemo(() => {
		const query = filter.trim().toLowerCase();
		const list = query
			? models.filter(model => `${model.provider}/${model.id}`.toLowerCase().includes(query))
			: models;
		const providerPriority = new Map(providers.map((provider, index) => [provider.id, provider.authenticated ? index : index + providers.length]));
		const buckets = new Map<string, ModelInfo[]>();
		for (const model of list.slice(0, MAX_VISIBLE)) {
			const bucket = buckets.get(model.provider) ?? [];
			bucket.push(model);
			buckets.set(model.provider, bucket);
		}
		return [...buckets.entries()].sort((left, right) => {
			const leftPriority = providerPriority.get(left[0]) ?? Number.MAX_SAFE_INTEGER;
			const rightPriority = providerPriority.get(right[0]) ?? Number.MAX_SAFE_INTEGER;
			if (leftPriority !== rightPriority) return leftPriority - rightPriority;
			return providerName(providers, left[0]).localeCompare(providerName(providers, right[0]));
		});
	}, [models, filter, providers]);
	const groupedProviderKey = grouped.map(([provider]) => provider).join("\n");

	const close = (): void => {
		setOpen(false);
		setFilter("");
	};

	useEffect(() => {
		if (!open) return;
		const connectedProviders = new Set(providers.filter(provider => provider.authenticated).map(provider => provider.id));
		setCollapsedProviders(
			new Set(
				grouped
					.map(([provider]) => provider)
					.filter(provider => provider !== currentModel.provider && !connectedProviders.has(provider)),
			),
		);
	}, [currentModel.provider, groupedProviderKey, open, providers]);

	const toggleProvider = (provider: string): void => {
		setCollapsedProviders(collapsed => {
			const next = new Set(collapsed);
			if (next.has(provider)) next.delete(provider);
			else next.add(provider);
			return next;
		});
	};

	const allCollapsed = grouped.length > 0 && grouped.every(([provider]) => collapsedProviders.has(provider));
	const toggleAll = (): void => {
		if (allCollapsed) {
			setCollapsedProviders(new Set());
		} else {
			setCollapsedProviders(new Set(grouped.map(([provider]) => provider)));
		}
	};

	return (
		<div className="setting-menu setting-menu--model">
			<button
				type="button"
				className={`setting-trigger${open ? " setting-trigger--open" : ""}`}
				disabled={disabled}
				aria-expanded={open}
				onClick={() => setOpen(currentOpen => !currentOpen)}
			>
				<span className="setting-avatar">
					<Bot size={16} strokeWidth={1.9} />
				</span>
				<span className="setting-trigger-copy">
					<span className="setting-trigger-title">{currentModel.id ?? "Select model"}</span>
					<span className="setting-trigger-subtitle">{currentModel.provider ?? `${models.length.toLocaleString()} models`}</span>
				</span>
				<ChevronRight className="setting-trigger-caret" size={15} strokeWidth={1.9} />
			</button>
			{open ? (
				<>
					<button type="button" className="picker-backdrop" aria-label="Close models" onClick={close} />
					<div className="setting-panel setting-panel--model">
						<label className="setting-search">
							<Search size={15} strokeWidth={1.9} />
							<input
								autoFocus
								placeholder="Filter models…"
								value={filter}
								onChange={event => setFilter(event.currentTarget.value)}
							/>
						</label>
						<div className="setting-panel-toolbar">
							<span>{grouped.length.toLocaleString()} accounts</span>
							<button type="button" onClick={toggleAll}>
								{allCollapsed ? "Expand all" : "Collapse all"}
							</button>
						</div>
						<div className="setting-list">
							{grouped.length === 0 ? (
								<div className="setting-empty">No models</div>
							) : (
								grouped.map(([provider, providerModels]) => (
									<div key={provider} className="setting-group">
										<button type="button" className="setting-group-title setting-group-title--button" onClick={() => toggleProvider(provider)}>
											<span className="setting-group-title-main">
												{collapsedProviders.has(provider) ? <ChevronRight size={13} strokeWidth={2} /> : <ChevronDown size={13} strokeWidth={2} />}
												<span>{providerName(providers, provider)}</span>
											</span>
											<span>{providerModels.length.toLocaleString()} models</span>
										</button>
										{collapsedProviders.has(provider) ? null : providerModels.map(model => {
											const label = `${model.provider}/${model.id}`;
											const context = formatContextWindow(model.contextWindow);
											return (
												<button
													key={label}
													type="button"
													className={`setting-item${label === current ? " setting-item--active" : ""}`}
													onClick={() => {
														onSelect(model.provider, model.id);
														close();
													}}
												>
													<span className="setting-item-copy">
														<span className="setting-item-title">{model.id}</span>
														<span className="setting-item-subtitle">{model.provider}</span>
													</span>
													<span className="setting-item-meta">
														{label === current ? <Check size={13} strokeWidth={2.1} /> : null}
														{context ?? ""}
													</span>
												</button>
											);
										})}
									</div>
								))
							)}
						</div>
					</div>
				</>
			) : null}
		</div>
	);
}
