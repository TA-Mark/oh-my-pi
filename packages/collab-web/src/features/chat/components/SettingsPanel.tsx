/**
 * SettingsPanel — persistent config (`~/.omp/agent/config.yml`).
 *
 * Mirrors UserControlsPanel pattern: settings with RPC commands apply
 * instantly via the running session; settings without RPC silently
 * restart the session in the background.
 */

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatClient } from "../../../lib/chat-client";
import type { GuestSnapshot } from "../../../lib/client";
import type { AvailableModel } from "../../../lib/rpc-client";
import { type ThemePreference, useThemePreference } from "../../../lib/theme";
import { getConfig, type OmpConfig, resetConfigKey, setConfigKey } from "../api/configApi";

interface Props {
	client: ChatClient | null;
	snapshot: GuestSnapshot | null;
	activeSessionId: string | null;
	onSessionRestart: ((sessionId: string) => Promise<void>) | null;
}

const ROLE_KEYS = ["default", "smol", "slow", "plan", "commit"] as const;
const ROLE_LABELS: Record<string, string> = {
	default: "Default",
	smol: "Smol (cheap fan-out)",
	slow: "Slow (deep reasoning)",
	plan: "Plan (architect)",
	commit: "Commit (changelogs)",
};

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
	{ value: "system", label: "System" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

export function SettingsPanel({ client, snapshot, activeSessionId, onSessionRestart }: Props): ReactNode {
	const [config, setConfig] = useState<OmpConfig>({});
	const [models, setModels] = useState<AvailableModel[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const { preference: themePref, setPreference: setThemePref } = useThemePreference();
	const restartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (restartTimer.current) clearTimeout(restartTimer.current);
		};
	}, []);

	const extras = snapshot?.sessionExtras ?? {};

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [{ config: cfg }, modelList] = await Promise.all([
				getConfig(),
				client?.sendGetAvailableModels?.().catch(() => []) ?? Promise.resolve([]),
			]);
			setConfig(cfg);
			setModels(modelList ?? []);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [client]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const groupedModels = useMemo(() => {
		const map = new Map<string, AvailableModel[]>();
		for (const m of models) {
			if (!map.has(m.provider)) map.set(m.provider, []);
			map.get(m.provider)!.push(m);
		}
		return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
	}, [models]);

	const applyLive = useCallback((key: string, value: unknown): boolean => {
		if (!client) return false;
		switch (key) {
			case "steeringMode":
				client.sendSetSteeringMode?.(value as "all" | "one-at-a-time");
				return true;
			case "followUpMode":
				client.sendSetFollowUpMode?.(value as "all" | "one-at-a-time");
				return true;
			case "interruptMode":
				client.sendSetInterruptMode?.(value as "immediate" | "wait");
				return true;
			case "modelRoles.default": {
				if (typeof value === "string" && value.includes("/")) {
					const sep = value.indexOf("/");
					client.sendSetModel?.(value.slice(0, sep), value.slice(sep + 1));
					return true;
				}
				return false;
			}
			case "compaction.enabled":
				client.sendSetAutoCompaction?.(value as boolean);
				return true;
			default:
				return false;
		}
	}, [client]);

	const scheduleRestart = useCallback(() => {
		if (!activeSessionId || !onSessionRestart) return;
		if (restartTimer.current) clearTimeout(restartTimer.current);
		restartTimer.current = setTimeout(() => {
			void onSessionRestart(activeSessionId).catch(() => {});
		}, 1000);
	}, [activeSessionId, onSessionRestart]);

	const update = useCallback(async (key: string, value: unknown) => {
		try {
			const res = await setConfigKey(key, value as never);
			setConfig(res.config);
			if (!applyLive(key, value) && activeSessionId && onSessionRestart) {
				scheduleRestart();
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [applyLive, scheduleRestart, activeSessionId, onSessionRestart]);

	const reset = useCallback(async (key: string) => {
		try {
			const res = await resetConfigKey(key);
			setConfig(res.config);
			const defaults: Record<string, string> = {
				steeringMode: "one-at-a-time",
				followUpMode: "one-at-a-time",
				interruptMode: "immediate",
			};
			if (!(defaults[key] && applyLive(key, defaults[key])) && activeSessionId && onSessionRestart) {
				scheduleRestart();
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [applyLive, scheduleRestart, activeSessionId, onSessionRestart]);

	if (loading) return <div style={{ color: "var(--fg-faint)", fontSize: 12 }}>Loading settings…</div>;

	return (
		<div className="mc-settings">
			{error && <div className="mc-providers-error" role="alert">{error}</div>}

			<div className="mc-settings-hint">
				Persisted to <code>~/.omp/agent/config.yml</code>.
			</div>

			<Section title="Theme (web UI)">
				<Row label="Mode">
					<Segmented
						value={themePref}
						options={THEME_OPTIONS.map(o => o.value)}
						labels={Object.fromEntries(THEME_OPTIONS.map(o => [o.value, o.label]))}
						onChange={v => setThemePref(v as ThemePreference)}
					/>
				</Row>
				<div className="mc-settings-hint">
					TUI theme presets (catppuccin, gruvbox, …) only apply in terminal.
					Set via <code>omp config set theme.dark &lt;name&gt;</code>.
				</div>
			</Section>

			<Section title="Model roles">
				{ROLE_KEYS.map(role => {
					const current = config.modelRoles?.[role] ?? "";
					return (
						<Row key={role} label={ROLE_LABELS[role] ?? role}>
							<select
								className="mc-select"
								value={current}
								onChange={e => {
									const v = e.target.value;
									if (v) void update(`modelRoles.${role}`, v);
									else void reset(`modelRoles.${role}`);
								}}
							>
								<option value="">(use omp default)</option>
								{groupedModels.map(([provider, items]) => (
									<optgroup key={provider} label={provider}>
										{items.map(m => (
											<option key={`${provider}/${m.id}`} value={`${provider}/${m.id}`}>
												{m.displayName ?? m.id}
											</option>
										))}
									</optgroup>
								))}
							</select>
						</Row>
					);
				})}
			</Section>

			<Section title="Thinking level">
				<Row label="Level">
					<Segmented
						value={(snapshot?.state?.thinkingLevel ?? "off") as string}
						options={[...THINKING_LEVELS]}
						onChange={v => client?.sendSetThinkingLevel?.(v)}
					/>
				</Row>
			</Section>

			<Section title="Queue behaviour">
				<Row label="Steering">
					<Segmented
						value={extras.steeringMode ?? config.steeringMode ?? "one-at-a-time"}
						options={["one-at-a-time", "all"]}
						onChange={v => update("steeringMode", v)}
					/>
				</Row>
				<Row label="Follow-up">
					<Segmented
						value={extras.followUpMode ?? config.followUpMode ?? "one-at-a-time"}
						options={["one-at-a-time", "all"]}
						onChange={v => update("followUpMode", v)}
					/>
				</Row>
				<Row label="Interrupt">
					<Segmented
						value={extras.interruptMode ?? config.interruptMode ?? "immediate"}
						options={["immediate", "wait"]}
						onChange={v => update("interruptMode", v)}
					/>
				</Row>
				<Row label="Auto-compaction">
					<Toggle
						checked={extras.autoCompactionEnabled ?? config.compaction?.enabled ?? false}
						onChange={v => update("compaction.enabled", v)}
					/>
				</Row>
				<Row label="Auto-retry">
					<Toggle checked={false} onChange={v => client?.sendSetAutoRetry?.(v)} />
				</Row>
			</Section>

			<Section title="Compaction">
				<Row label="Strategy">
					<Segmented
						value={config.compaction?.strategy ?? "snapcompact"}
						options={["soft", "remote", "snapcompact"]}
						onChange={v => update("compaction.strategy", v)}
					/>
				</Row>
				<Row label="Threshold %">
					<NumberInput value={config.compaction?.thresholdPercent} onCommit={v => update("compaction.thresholdPercent", v)} onReset={() => reset("compaction.thresholdPercent")} />
				</Row>
				<Row label="Threshold tokens">
					<NumberInput value={config.compaction?.thresholdTokens} onCommit={v => update("compaction.thresholdTokens", v)} onReset={() => reset("compaction.thresholdTokens")} />
				</Row>
				<Row label="Keep recent tokens">
					<NumberInput value={config.compaction?.keepRecentTokens} onCommit={v => update("compaction.keepRecentTokens", v)} onReset={() => reset("compaction.keepRecentTokens")} />
				</Row>
				<Row label="Auto-continue">
					<Toggle checked={config.compaction?.autoContinue ?? false} onChange={v => update("compaction.autoContinue", v)} />
				</Row>
				<Row label="Idle compaction">
					<Toggle checked={config.compaction?.idleEnabled ?? false} onChange={v => update("compaction.idleEnabled", v)} />
				</Row>
				<Row label="Idle threshold tokens">
					<NumberInput value={config.compaction?.idleThresholdTokens} onCommit={v => update("compaction.idleThresholdTokens", v)} onReset={() => reset("compaction.idleThresholdTokens")} />
				</Row>
				<Row label="Idle timeout (sec)">
					<NumberInput value={config.compaction?.idleTimeoutSeconds} onCommit={v => update("compaction.idleTimeoutSeconds", v)} onReset={() => reset("compaction.idleTimeoutSeconds")} />
				</Row>
				<Row label="Reserve tokens">
					<NumberInput value={config.compaction?.reserveTokens} onCommit={v => update("compaction.reserveTokens", v)} onReset={() => reset("compaction.reserveTokens")} />
				</Row>
			</Section>

			<Section title="Tools">
				<Row label="Discovery">
					<Segmented
						value={config.tools?.discoveryMode ?? "auto"}
						options={["auto", "manual"]}
						onChange={v => update("tools.discoveryMode", v)}
					/>
				</Row>
			</Section>

			<Section title="Debug">
				<Row label="Enable debug tool">
					<Toggle checked={config.debug?.enabled === true} onChange={v => update("debug.enabled", v)} />
				</Row>
			</Section>

			<Section title="Images">
				<Row label="Auto-resize attachments">
					<Toggle checked={config.images?.autoResize !== false} onChange={v => update("images.autoResize", v)} />
				</Row>
			</Section>

			<Section title="Extensions">
				<ExtensionsEditor value={config.extensions ?? []} onChange={paths => update("extensions", paths)} onReset={() => reset("extensions")} />
			</Section>

			<Section title="Searxng (self-hosted web search)">
				<Row label="Endpoint">
					<TextInput value={config.searxng?.endpoint ?? ""} onCommit={v => v ? update("searxng.endpoint", v) : reset("searxng.endpoint")} placeholder="https://searxng.example.com" />
				</Row>
				<Row label="Token">
					<TextInput value={config.searxng?.token ?? ""} onCommit={v => v ? update("searxng.token", v) : reset("searxng.token")} placeholder="(optional)" type="password" />
				</Row>
				<Row label="Basic user">
					<TextInput value={config.searxng?.basicUsername ?? ""} onCommit={v => v ? update("searxng.basicUsername", v) : reset("searxng.basicUsername")} />
				</Row>
				<Row label="Basic pass">
					<TextInput value={config.searxng?.basicPassword ?? ""} onCommit={v => v ? update("searxng.basicPassword", v) : reset("searxng.basicPassword")} type="password" />
				</Row>
			</Section>
		</div>
	);
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
	return (
		<div className="mc-settings-section">
			<div className="mc-section-title">{title}</div>
			{children}
		</div>
	);
}

function Row({ label, children }: { label: string; children: ReactNode }): ReactNode {
	return (
		<div className="mc-settings-row">
			<span className="mc-control-label">{label}</span>
			<div className="mc-settings-control">{children}</div>
		</div>
	);
}

function Segmented({
	value,
	options,
	labels,
	onChange,
}: {
	value: string;
	options: readonly string[];
	labels?: Record<string, string>;
	onChange(v: string): void;
}): ReactNode {
	return (
		<div className="mc-segmented">
			{options.map(o => (
				<button
					key={o}
					type="button"
					className="mc-segmented-btn"
					data-active={value === o ? "true" : undefined}
					onClick={() => onChange(o)}
				>
					{labels?.[o] ?? o}
				</button>
			))}
		</div>
	);
}

function Toggle({ checked, onChange }: { checked: boolean; onChange(v: boolean): void }): ReactNode {
	return (
		<label className="mc-toggle-inline">
			<input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
			<span>{checked ? "on" : "off"}</span>
		</label>
	);
}

function TextInput({ value, onCommit, placeholder, type }: { value: string; onCommit(v: string): void; placeholder?: string; type?: string }): ReactNode {
	const [draft, setDraft] = useState(value);
	useEffect(() => { setDraft(value); }, [value]);
	return (
		<input
			className="mc-dialog-input"
			value={draft}
			placeholder={placeholder}
			type={type ?? "text"}
			onChange={e => setDraft(e.target.value)}
			onBlur={() => { if (draft !== value) onCommit(draft); }}
			onKeyDown={e => {
				if (e.key === "Enter") {
					e.preventDefault();
					if (draft !== value) onCommit(draft);
				}
			}}
			spellCheck={false}
		/>
	);
}

function NumberInput({ value, onCommit, onReset, placeholder }: { value: number | undefined; onCommit(v: number | undefined): void; onReset?(): void; placeholder?: string }): ReactNode {
	const [draft, setDraft] = useState(value !== undefined ? String(value) : "");
	useEffect(() => { setDraft(value !== undefined ? String(value) : ""); }, [value]);
	const commit = (): void => {
		if (draft.trim() === "") {
			if (value !== undefined) onReset?.();
			return;
		}
		const n = Number(draft);
		if (Number.isNaN(n)) return;
		if (n !== value) onCommit(n);
	};
	return (
		<input
			className="mc-dialog-input"
			type="number"
			value={draft}
			placeholder={placeholder ?? ""}
			onChange={e => setDraft(e.target.value)}
			onBlur={commit}
			onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
			style={{ width: 90 }}
		/>
	);
}

function ExtensionsEditor({ value, onChange, onReset }: { value: string[]; onChange(v: string[]): void; onReset(): void }): ReactNode {
	const [draft, setDraft] = useState(value.join("\n"));
	useEffect(() => { setDraft(value.join("\n")); }, [value]);
	const commit = (): void => {
		const lines = draft.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
		if (lines.length === 0) onReset();
		else if (lines.join("\n") !== value.join("\n")) onChange(lines);
	};
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
			<textarea
				className="mc-dialog-textarea"
				value={draft}
				placeholder="One extension path per line"
				rows={4}
				onChange={e => setDraft(e.target.value)}
				onBlur={commit}
				spellCheck={false}
			/>
		</div>
	);
}
