/**
 * UserControlsPanel — model picker + thinking level + interrupt mode.
 *
 * Model + thinking now flow through RpcClient (set_model / set_thinking_level)
 * rather than the legacy `runtime-config` REST stub. The model list is fetched
 * live from omp via `get_available_models` so it always reflects whatever the
 * user has authenticated for.
 */

import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type { ChatClient } from "../../../lib/chat-client";
import type { GuestSnapshot } from "../../../lib/client";
import type { AvailableModel } from "../../../lib/rpc-client";
import { getModelRoles } from "../api/chatApi";

interface Props {
	client: ChatClient | null;
	snapshot: GuestSnapshot | null;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

function fmtCost(model: AvailableModel): string | null {
	const inCost = model.cost?.input;
	const outCost = model.cost?.output;
	if (typeof inCost !== "number" || typeof outCost !== "number") return null;
	return `$${inCost.toFixed(2)} / $${outCost.toFixed(2)} per 1M`;
}

function fmtContext(model: AvailableModel): string | null {
	const ctx = model.contextWindow;
	if (typeof ctx !== "number") return null;
	if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(1)}M ctx`;
	if (ctx >= 1_000) return `${Math.round(ctx / 1_000)}k ctx`;
	return `${ctx} ctx`;
}

const ROLE_LABELS: Record<string, string> = {
	default: "DEFAULT",
	smol: "SMOL (Fast)",
	slow: "SLOW (Thinking)",
	plan: "PLAN (Architect)",
	commit: "COMMIT",
	task: "TASK (Subtask)",
	advisor: "ADVISOR",
	vision: "VISION",
	designer: "DESIGNER",
};
const DEFAULT_CYCLE_ORDER = ["smol", "default", "slow"];

export function UserControlsPanel({ client, snapshot }: Props): ReactNode {
	const [models, setModels] = useState<AvailableModel[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [roles, setRoles] = useState<Record<string, string>>({});
	const [activeRole, setActiveRole] = useState<string>("default");

	const state = snapshot?.state;
	const currentModel = state?.model;
	const currentThinking = (state?.thinkingLevel ?? "off") as ThinkingLevel;

	const refresh = useCallback(async () => {
		if (!client?.sendGetAvailableModels) return;
		setLoading(true);
		setError(null);
		try {
			const [list, rolesRes] = await Promise.all([
				client.sendGetAvailableModels(),
				getModelRoles().catch(() => ({ roles: {} })),
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

	const configuredRoles = useMemo(() => {
		if (!models) return [] as Array<{ role: string; label: string; modelStr: string; model: AvailableModel | null }>;
		return Object.entries(roles).map(([role, modelStr]) => {
			const match = models.find(m =>
				`${m.provider}/${m.id}` === modelStr.split(":")[0] ||
				m.id === modelStr.split(":")[0]
			);
			return { role, label: ROLE_LABELS[role] ?? role.toUpperCase(), modelStr, model: match ?? null };
		});
	}, [roles, models]);

	const handleSetRoleModel = useCallback(
		(role: string, provider: string, modelId: string) => {
			client?.sendSetModel?.(provider, modelId);
			setActiveRole(role);
		},
		[client],
	);

	const handleCycleRole = useCallback(() => {
		if (!models || configuredRoles.length === 0) return;
		const cycleOrder = DEFAULT_CYCLE_ORDER.filter(r => roles[r]);
		if (cycleOrder.length === 0) return;
		const currentIdx = cycleOrder.indexOf(activeRole);
		const nextIdx = (currentIdx + 1) % cycleOrder.length;
		const nextRole = cycleOrder[nextIdx]!;
		const modelStr = roles[nextRole];
		if (!modelStr) return;
		const match = models.find(m =>
			`${m.provider}/${m.id}` === modelStr.split(":")[0] || m.id === modelStr.split(":")[0]
		);
		if (match) {
			client?.sendSetModel?.(match.provider, match.id);
			setActiveRole(nextRole);
		}
	}, [models, configuredRoles, roles, activeRole, client]);

	const groupedModels = useMemo(() => {
		if (!models) return [] as Array<{ provider: string; items: AvailableModel[] }>;
		const map = new Map<string, AvailableModel[]>();
		for (const m of models) {
			if (!map.has(m.provider)) map.set(m.provider, []);
			map.get(m.provider)!.push(m);
		}
		return Array.from(map.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([provider, items]) => ({ provider, items }));
	}, [models]);

	const handleSelectModel = useCallback(
		(provider: string, modelId: string) => {
			client?.sendSetModel?.(provider, modelId);
		},
		[client],
	);

	const handleThinking = useCallback(
		(level: ThinkingLevel) => {
			client?.sendSetThinkingLevel?.(level);
		},
		[client],
	);


	const extras = snapshot?.sessionExtras ?? {};
	const handleSteeringMode = useCallback(
		(mode: "all" | "one-at-a-time") => client?.sendSetSteeringMode?.(mode),
		[client],
	);
	const handleFollowUpMode = useCallback(
		(mode: "all" | "one-at-a-time") => client?.sendSetFollowUpMode?.(mode),
		[client],
	);
	const handleInterruptMode = useCallback(
		(mode: "immediate" | "wait") => client?.sendSetInterruptMode?.(mode),
		[client],
	);
	const handleAutoCompaction = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => client?.sendSetAutoCompaction?.(e.target.checked),
		[client],
	);
	const handleAutoRetry = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => client?.sendSetAutoRetry?.(e.target.checked),
		[client],
	);

	if (!client) {
		return <div style={{ color: "var(--fg-faint)", fontSize: 12 }}>Start a session to configure runtime.</div>;
	}

	const currentModelLabel = currentModel ? `${currentModel.provider}/${currentModel.id}` : "(none selected)";

	return (
		<div>
			<div className="mc-section-title">Runtime Controls</div>

			{error && (
				<div className="mc-providers-error" role="alert">
					{error}
				</div>
			)}

			{/* Role cycling — mirrors OMP TUI Ctrl+P */}
			{configuredRoles.length > 0 && (
				<>
					<div className="mc-control-row">
						<span className="mc-control-label">Role</span>
						<div className="mc-segmented">
							{configuredRoles.map(r => (
								<button
									key={r.role}
									type="button"
									className="mc-segmented-btn"
									data-active={activeRole === r.role ? "true" : undefined}
									onClick={() => {
										if (r.model) handleSetRoleModel(r.role, r.model.provider, r.model.id);
									}}
									disabled={!r.model}
									title={r.model ? `${r.model.provider}/${r.model.id}` : `${r.modelStr} (not available)`}
								>
									{r.label}
								</button>
							))}
						</div>
					</div>
					<div style={{ fontSize: 10, color: "var(--fg-faint)", marginBottom: 6 }}>
						Configure roles in <code>~/.omp/agent/config.yml</code> → <code>modelRoles</code>
					</div>
				</>
			)}

			{/* Model picker — grouped select */}
			<div className="mc-control-row">
				<label className="mc-control-label" htmlFor="mc-model-select">
					Model
				</label>
				<select
					id="mc-model-select"
					className="mc-select"
					value={currentModel ? `${currentModel.provider}::${currentModel.id}` : ""}
					disabled={loading || groupedModels.length === 0}
					onChange={e => {
						const [provider, modelId] = e.target.value.split("::");
						if (provider && modelId) handleSelectModel(provider, modelId);
					}}
				>
					{groupedModels.length === 0 ? (
						<option value="">{loading ? "Loading…" : currentModelLabel}</option>
					) : (
						groupedModels.map(({ provider, items }) => (
							<optgroup key={provider} label={provider}>
								{items.map(m => {
									const ctx = fmtContext(m);
									const cost = fmtCost(m);
									const meta = [ctx, cost].filter(Boolean).join(" · ");
									return (
										<option key={`${provider}/${m.id}`} value={`${provider}::${m.id}`}>
											{m.displayName ?? m.id}
											{meta ? ` — ${meta}` : ""}
										</option>
									);
								})}
							</optgroup>
						))
					)}
				</select>
			</div>

			{/* Thinking level — segmented button group */}
			<div className="mc-control-row">
				<span className="mc-control-label">Thinking level</span>
				<div className="mc-segmented">
					{THINKING_LEVELS.map(level => (
						<button
							key={level}
							type="button"
							className="mc-segmented-btn"
							data-active={currentThinking === level ? "true" : undefined}
							onClick={() => handleThinking(level)}
						>
							{level}
						</button>
					))}
				</div>
			</div>

			<div style={{ fontSize: 11, color: "var(--fg-faint)", marginTop: 6 }}>
				Current: <span style={{ fontFamily: "var(--font-mono)" }}>{currentModelLabel}</span> ·{" "}
				<span style={{ fontFamily: "var(--font-mono)" }}>{currentThinking}</span>
			</div>

			<div className="mc-section-title" style={{ marginTop: 16 }}>
				Queue behaviour
			</div>

			<div className="mc-control-row">
				<span className="mc-control-label">Steering mode</span>
				<div className="mc-segmented">
					{(["all", "one-at-a-time"] as const).map(m => (
						<button
							key={m}
							type="button"
							className="mc-segmented-btn"
							data-active={extras.steeringMode === m ? "true" : undefined}
							onClick={() => handleSteeringMode(m)}
						>
							{m}
						</button>
					))}
				</div>
			</div>

			<div className="mc-control-row">
				<span className="mc-control-label">Follow-up mode</span>
				<div className="mc-segmented">
					{(["all", "one-at-a-time"] as const).map(m => (
						<button
							key={m}
							type="button"
							className="mc-segmented-btn"
							data-active={extras.followUpMode === m ? "true" : undefined}
							onClick={() => handleFollowUpMode(m)}
						>
							{m}
						</button>
					))}
				</div>
			</div>

			<div className="mc-control-row">
				<span className="mc-control-label">Interrupt mode</span>
				<div className="mc-segmented">
					{(["immediate", "wait"] as const).map(m => (
						<button
							key={m}
							type="button"
							className="mc-segmented-btn"
							data-active={extras.interruptMode === m ? "true" : undefined}
							onClick={() => handleInterruptMode(m)}
						>
							{m}
						</button>
					))}
				</div>
			</div>

			<div className="mc-toggle-row">
				<span className="mc-toggle-label">Auto-compaction</span>
				<label className="mc-toggle">
					<input type="checkbox" checked={extras.autoCompactionEnabled ?? false} onChange={handleAutoCompaction} />
					<span className="mc-toggle-track" />
					<span className="mc-toggle-thumb" />
				</label>
			</div>

			<div className="mc-toggle-row">
				<span className="mc-toggle-label">Auto-retry on errors</span>
				<label className="mc-toggle">
					<input type="checkbox" onChange={handleAutoRetry} />
					<span className="mc-toggle-track" />
					<span className="mc-toggle-thumb" />
				</label>
			</div>

			<button type="button" className="mc-btn" onClick={() => void refresh()} style={{ marginTop: 10 }}>
				⟳ Refresh models
			</button>
		</div>
	);
}
