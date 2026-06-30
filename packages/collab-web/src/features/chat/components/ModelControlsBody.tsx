/**
 * ModelControlsBody — rich `/model` dialog.
 *
 * Replaces the legacy flat `showSelect` palette with a tabbed surface:
 *   - Models  — provider-grouped picker, marks the current model
 *   - Roles   — 5 omp roles (default/smol/slow/plan/commit) wired to
 *               `~/.omp/agent/config.yml` via setModelRole(...)
 *   - Thinking — segmented level (off…xhigh)
 *   - Queue   — steering / follow-up / interrupt modes
 *   - Toggles — auto-compaction, auto-retry
 *
 * Mutations dispatch through ChatClient.sendSetXxx for session-scope state
 * and the config bridge for persistent role assignments. The dialog stays
 * mounted (live updates) until the user presses Done/Esc/clicks the overlay.
 */

import { type ReactNode, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ChatClient } from "../../../lib/chat-client";
import type { AvailableModel, FollowUpMode, InterruptMode, SteeringMode } from "../../../lib/rpc-client";
import { getModelRoles, setModelRole } from "../api/chatApi";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const ROLE_KEYS = ["default", "smol", "slow", "plan", "commit"] as const;
type RoleKey = (typeof ROLE_KEYS)[number];

const ROLE_LABELS: Record<RoleKey, string> = {
	default: "Default",
	smol: "Smol (fast / cheap)",
	slow: "Slow (deep reasoning)",
	plan: "Plan (architect)",
	commit: "Commit (messages)",
};

const TABS = ["models", "roles", "thinking", "queue", "toggles"] as const;
type TabKey = (typeof TABS)[number];
const TAB_LABELS: Record<TabKey, string> = {
	models: "Models",
	roles: "Roles",
	thinking: "Thinking",
	queue: "Queue",
	toggles: "Toggles",
};

interface Props {
	client: ChatClient;
	onClose(): void;
}

function fmtCost(model: AvailableModel): string | null {
	const i = model.cost?.input;
	const o = model.cost?.output;
	if (typeof i !== "number" || typeof o !== "number") return null;
	return `$${i.toFixed(2)}/$${o.toFixed(2)}`;
}
function fmtContext(model: AvailableModel): string | null {
	const c = model.contextWindow;
	if (typeof c !== "number") return null;
	if (c >= 1_000_000) return `${(c / 1_000_000).toFixed(1)}M`;
	if (c >= 1_000) return `${Math.round(c / 1_000)}k`;
	return `${c}`;
}

export function ModelControlsBody({ client, onClose }: Props): ReactNode {
	const snapshot = useSyncExternalStore(
		cb => client.subscribe(cb),
		() => client.getSnapshot(),
		() => client.getSnapshot(),
	);

	const [tab, setTab] = useState<TabKey>("models");
	const [models, setModels] = useState<AvailableModel[] | null>(null);
	const [roles, setRoles] = useState<Record<string, string>>({});
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [modelFilter, setModelFilter] = useState("");

	const refresh = useCallback(async () => {
		if (!client.sendGetAvailableModels) return;
		setLoading(true);
		setError(null);
		try {
			const [list, rolesRes] = await Promise.all([
				client.sendGetAvailableModels(),
				getModelRoles().catch(() => ({ roles: {} as Record<string, string> })),
			]);
			setModels(list);
			setRoles(rolesRes.roles);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [client]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") {
				e.preventDefault();
				onClose();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const state = snapshot.state;
	const currentModel = state?.model ?? null;
	const currentThinking = (state?.thinkingLevel ?? "off") as ThinkingLevel;
	const extras = snapshot.sessionExtras;

	const groupedModels = useMemo(() => {
		if (!models) return [] as Array<{ provider: string; items: AvailableModel[] }>;
		const q = modelFilter.trim().toLowerCase();
		const map = new Map<string, AvailableModel[]>();
		for (const m of models) {
			if (q && !`${m.provider}/${m.id} ${m.displayName ?? ""}`.toLowerCase().includes(q)) continue;
			if (!map.has(m.provider)) map.set(m.provider, []);
			map.get(m.provider)!.push(m);
		}
		return Array.from(map.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([provider, items]) => ({ provider, items }));
	}, [models, modelFilter]);

	return (
		<div className="mc-dialog-wide">
			<div className="mc-dialog-tabs" role="tablist">
				{TABS.map(t => (
					<button
						key={t}
						type="button"
						role="tab"
						aria-selected={tab === t}
						className="mc-dialog-tab"
						data-active={tab === t ? "true" : undefined}
						onClick={() => setTab(t)}
					>
						{TAB_LABELS[t]}
					</button>
				))}
				<button type="button" className="mc-dialog-tab-close" onClick={onClose} aria-label="Close">×</button>
			</div>

			{error && <div className="mc-providers-error" role="alert">{error}</div>}

			<div className="mc-dialog-body">
				{tab === "models" && (
					<ModelsTab
						loading={loading}
						groupedModels={groupedModels}
						current={currentModel}
						filter={modelFilter}
						onFilter={setModelFilter}
						onPick={(provider, id) => client.sendSetModel?.(provider, id)}
					/>
				)}
				{tab === "roles" && (
					<RolesTab
						models={models}
						roles={roles}
						loading={loading}
						onChange={async (role, model) => {
							try {
								const res = await setModelRole(role, model);
								setRoles(res.roles);
							} catch (err) {
								setError(err instanceof Error ? err.message : String(err));
							}
						}}
					/>
				)}
				{tab === "thinking" && (
					<ThinkingTab
						current={currentThinking}
						onPick={lvl => client.sendSetThinkingLevel?.(lvl)}
					/>
				)}
				{tab === "queue" && (
					<QueueTab
						steeringMode={extras.steeringMode}
						followUpMode={extras.followUpMode}
						interruptMode={extras.interruptMode}
						onSteering={m => client.sendSetSteeringMode?.(m)}
						onFollowUp={m => client.sendSetFollowUpMode?.(m)}
						onInterrupt={m => client.sendSetInterruptMode?.(m)}
					/>
				)}
				{tab === "toggles" && (
					<TogglesTab
						autoCompaction={extras.autoCompactionEnabled === true}
						onAutoCompaction={v => client.sendSetAutoCompaction?.(v)}
						onAutoRetry={v => client.sendSetAutoRetry?.(v)}
					/>
				)}
			</div>

			<div className="mc-dialog-actions">
				<button type="button" className="mc-btn mc-btn-primary" onClick={onClose}>
					Done
				</button>
			</div>
			<div className="mc-dialog-hint">Esc · click overlay to close · changes apply immediately</div>
		</div>
	);
}

// ─── Tabs ──────────────────────────────────────────────────────────────────

function ModelsTab({
	loading,
	groupedModels,
	current,
	filter,
	onFilter,
	onPick,
}: {
	loading: boolean;
	groupedModels: Array<{ provider: string; items: AvailableModel[] }>;
	current: { provider: string; id: string } | null;
	filter: string;
	onFilter(v: string): void;
	onPick(provider: string, id: string): void;
}): ReactNode {
	return (
		<>
			<input
				className="mc-dialog-input"
				placeholder="Filter models (provider, id, name)…"
				value={filter}
				onChange={e => onFilter(e.target.value)}
				spellCheck={false}
			/>
			<div className="mc-model-list" role="listbox">
				{loading && groupedModels.length === 0 && (
					<div className="mc-dialog-empty">Loading models…</div>
				)}
				{!loading && groupedModels.length === 0 && (
					<div className="mc-dialog-empty">
						No models available. Paste an API key in <strong>Providers</strong> to populate this list.
					</div>
				)}
				{groupedModels.map(({ provider, items }) => (
					<div key={provider} className="mc-model-group">
						<div className="mc-model-group-head">{provider}</div>
						{items.map(m => {
							const isActive = current?.provider === provider && current?.id === m.id;
							const ctx = fmtContext(m);
							const cost = fmtCost(m);
							const meta = [ctx, cost].filter(Boolean).join(" · ");
							return (
								<button
									key={`${provider}/${m.id}`}
									type="button"
									className="mc-model-item"
									data-active={isActive ? "true" : undefined}
									onClick={() => onPick(provider, m.id)}
								>
									<span className="mc-model-name">{m.displayName ?? m.id}</span>
									{meta && <span className="mc-model-meta">{meta}</span>}
									{isActive && <span className="mc-model-dot" aria-label="current">●</span>}
								</button>
							);
						})}
					</div>
				))}
			</div>
		</>
	);
}

function RolesTab({
	models,
	roles,
	loading,
	onChange,
}: {
	models: AvailableModel[] | null;
	roles: Record<string, string>;
	loading: boolean;
	onChange(role: RoleKey, model: string): void;
}): ReactNode {
	const grouped = useMemo(() => {
		if (!models) return [] as Array<{ provider: string; items: AvailableModel[] }>;
		const map = new Map<string, AvailableModel[]>();
		for (const m of models) {
			if (!map.has(m.provider)) map.set(m.provider, []);
			map.get(m.provider)!.push(m);
		}
		return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
			.map(([provider, items]) => ({ provider, items }));
	}, [models]);

	return (
		<div className="mc-role-grid">
			<div className="mc-role-hint">
				Persistent — saved to <code>~/.omp/agent/config.yml</code>. Roles route work by intent: <code>smol</code> for cheap fan-out, <code>slow</code> for deep reasoning, <code>plan</code> for plan-mode, <code>commit</code> for changelogs.
			</div>
			{ROLE_KEYS.map(role => {
				const current = roles[role] ?? "";
				return (
					<div key={role} className="mc-role-row">
						<label className="mc-role-label" htmlFor={`mc-role-${role}`}>
							{ROLE_LABELS[role]}
						</label>
						<select
							id={`mc-role-${role}`}
							className="mc-select"
							value={current}
							disabled={loading || grouped.length === 0}
							onChange={e => {
								const v = e.target.value;
								if (v) onChange(role, v);
							}}
						>
							<option value="">{loading ? "Loading…" : "(use default)"}</option>
							{grouped.map(({ provider, items }) => (
								<optgroup key={provider} label={provider}>
									{items.map(m => (
										<option key={`${provider}/${m.id}`} value={`${provider}/${m.id}`}>
											{m.displayName ?? m.id}
										</option>
									))}
								</optgroup>
							))}
						</select>
					</div>
				);
			})}
		</div>
	);
}

function ThinkingTab({
	current,
	onPick,
}: {
	current: ThinkingLevel;
	onPick(level: ThinkingLevel): void;
}): ReactNode {
	return (
		<div className="mc-segmented mc-segmented-wide">
			{THINKING_LEVELS.map(level => (
				<button
					key={level}
					type="button"
					className="mc-segmented-btn"
					data-active={current === level ? "true" : undefined}
					onClick={() => onPick(level)}
				>
					{level}
				</button>
			))}
		</div>
	);
}

function QueueTab({
	steeringMode,
	followUpMode,
	interruptMode,
	onSteering,
	onFollowUp,
	onInterrupt,
}: {
	steeringMode?: SteeringMode;
	followUpMode?: FollowUpMode;
	interruptMode?: InterruptMode;
	onSteering(mode: SteeringMode): void;
	onFollowUp(mode: FollowUpMode): void;
	onInterrupt(mode: InterruptMode): void;
}): ReactNode {
	const queueModes: ReadonlyArray<"all" | "one-at-a-time"> = ["all", "one-at-a-time"];
	const interruptModes: ReadonlyArray<"immediate" | "wait"> = ["immediate", "wait"];
	const steer: SteeringMode = steeringMode ?? "one-at-a-time";
	const follow: FollowUpMode = followUpMode ?? "one-at-a-time";
	const interrupt: InterruptMode = interruptMode ?? "immediate";
	return (
		<div className="mc-queue-grid">
			<div className="mc-control-row">
				<span className="mc-control-label">Steering mode</span>
				<div className="mc-segmented">
					{queueModes.map(m => (
						<button key={m} type="button" className="mc-segmented-btn" data-active={steer === m ? "true" : undefined} onClick={() => onSteering(m)}>
							{m}
						</button>
					))}
				</div>
			</div>
			<div className="mc-control-row">
				<span className="mc-control-label">Follow-up mode</span>
				<div className="mc-segmented">
					{queueModes.map(m => (
						<button key={m} type="button" className="mc-segmented-btn" data-active={follow === m ? "true" : undefined} onClick={() => onFollowUp(m)}>
							{m}
						</button>
					))}
				</div>
			</div>
			<div className="mc-control-row">
				<span className="mc-control-label">Interrupt mode</span>
				<div className="mc-segmented">
					{interruptModes.map(m => (
						<button key={m} type="button" className="mc-segmented-btn" data-active={interrupt === m ? "true" : undefined} onClick={() => onInterrupt(m)}>
							{m}
						</button>
					))}
				</div>
			</div>
		</div>
	);
}

function TogglesTab({
	autoCompaction,
	onAutoCompaction,
	onAutoRetry,
}: {
	autoCompaction: boolean;
	onAutoCompaction(v: boolean): void;
	onAutoRetry(v: boolean): void;
}): ReactNode {
	return (
		<div className="mc-toggle-list">
			<label className="mc-toggle">
				<input type="checkbox" checked={autoCompaction} onChange={e => onAutoCompaction(e.target.checked)} />
				<span>Auto-compaction</span>
				<span className="mc-toggle-hint">Summarise older turns when context fills.</span>
			</label>
			<label className="mc-toggle">
				<input type="checkbox" onChange={e => onAutoRetry(e.target.checked)} />
				<span>Auto-retry on provider error</span>
				<span className="mc-toggle-hint">Re-send the last turn after a transient 5xx / 429.</span>
			</label>
		</div>
	);
}
