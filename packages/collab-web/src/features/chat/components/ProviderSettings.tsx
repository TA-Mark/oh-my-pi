/**
 * ProviderSettings — full provider catalog UI.
 *
 * Three data sources, merged:
 *   1. Bridge `/chat/providers/catalog` — the full curated list of every
 *      provider omp supports (~70+), with each entry's type, env vars,
 *      default local URL, and whether it's already configured locally.
 *   2. RPC `get_login_providers` — live OAuth authentication state
 *      (`authenticated: true/false`) from omp's AuthStorage.
 *   3. Bridge `/chat/keys` — the user's pasted API keys (masked).
 *
 * Providers are grouped: OAuth · API Key · Coding Plans · Local · Discovery.
 */

import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type { ChatClient } from "../../../lib/chat-client";
import type { LoginProvider } from "../../../lib/rpc-client";
import {
	deleteApiKey,
	getProviderCatalog,
	listApiKeys,
	type ProviderCatalogEntry,
	type ProviderCatalogType,
	type StoredApiKey,
	saveApiKey,
} from "../api/chatApi";

interface Props {
	client: ChatClient | null;
}

interface MergedProvider extends ProviderCatalogEntry {
	authenticated?: boolean;
	available?: boolean;
}

const TYPE_LABELS: Record<ProviderCatalogType, string> = {
	oauth: "OAuth Sign-in",
	"api-key": "API Key",
	"coding-plan": "Coding Plans",
	local: "Local / Self-hosted",
	discovery: "Discovery",
};

const TYPE_ORDER: ProviderCatalogType[] = ["oauth", "api-key", "coding-plan", "local", "discovery"];

export function ProviderSettings({ client }: Props): ReactNode {
	const [catalog, setCatalog] = useState<ProviderCatalogEntry[] | null>(null);
	const [oauth, setOauth] = useState<LoginProvider[]>([]);
	const [keys, setKeys] = useState<StoredApiKey[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busyProvider, setBusyProvider] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

	// Inline key-paste state per provider
	const [pasteFor, setPasteFor] = useState<string | null>(null);
	const [pasteValue, setPasteValue] = useState("");
	const [pasteEnvVar, setPasteEnvVar] = useState("");

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const tasks: Promise<unknown>[] = [
				getProviderCatalog().then(r => setCatalog(r.providers)),
				listApiKeys().then(r => setKeys(r.keys)),
			];
			if (client?.sendGetLoginProviders) {
				tasks.push(client.sendGetLoginProviders().then(setOauth));
			} else {
				// No RPC client or sendGetLoginProviders unavailable → OAuth state unknown
				setOauth([]);
			}
			await Promise.all(tasks);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [client]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Merge catalog + oauth state + stored keys
	const merged: MergedProvider[] = useMemo(() => {
		if (!catalog) return [];
		const oauthById = new Map(oauth.map(o => [o.id, o]));
		return catalog.map(c => {
			const o = oauthById.get(c.id);
			return {
				...c,
				authenticated: o?.authenticated,
				available: o?.available,
			};
		});
	}, [catalog, oauth]);

	const grouped = useMemo(() => {
		const map = new Map<ProviderCatalogType, MergedProvider[]>();
		for (const t of TYPE_ORDER) map.set(t, []);
		for (const p of merged) {
			const arr = map.get(p.type);
			if (arr) arr.push(p);
		}
		// Within each group: common first, then alphabetical
		for (const arr of map.values()) {
			arr.sort((a, b) => {
				if ((a.common ?? false) !== (b.common ?? false)) return a.common ? -1 : 1;
				return a.name.localeCompare(b.name);
			});
		}
		return map;
	}, [merged]);

	const handleLogin = useCallback(
		(providerId: string) => {
			if (!client?.sendLogin) return;
			setBusyProvider(providerId);
			client.sendLogin(providerId);
			setTimeout(() => {
				setBusyProvider(null);
				void refresh();
			}, 3000);
		},
		[client, refresh],
	);

	const openPasteFor = useCallback((p: MergedProvider) => {
		setPasteFor(p.id);
		setPasteEnvVar(p.envVars?.[0] ?? "");
		setPasteValue("");
	}, []);

	const handleSavePaste = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			if (!pasteEnvVar || !pasteValue) return;
			try {
				await saveApiKey(pasteEnvVar, pasteValue);
				setPasteFor(null);
				setPasteValue("");
				await refresh();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		},
		[pasteEnvVar, pasteValue, refresh],
	);

	const handleDeleteKey = useCallback(
		async (name: string) => {
			try {
				await deleteApiKey(name);
				await refresh();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		},
		[refresh],
	);

	const toggleExpand = useCallback((id: string) => {
		setExpanded(prev => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const totalConfigured = merged.filter(p => p.configured || p.authenticated).length;

	return (
		<div className="mc-providers">
			<div className="mc-section-title">
				Providers{" "}
				<span className="mc-providers-count">
					{totalConfigured} / {merged.length} configured
				</span>
			</div>

			{error && (
				<div className="mc-providers-error" role="alert">
					{error}
				</div>
			)}

			{loading && catalog === null && <div className="mc-providers-hint">Loading provider catalog…</div>}

			{TYPE_ORDER.map(type => {
				const items = grouped.get(type) ?? [];
				if (items.length === 0) return null;
				return (
					<section key={type} className="mc-provider-group">
						<div className="mc-provider-group-head">
							<span className="mc-provider-group-label">{TYPE_LABELS[type]}</span>
							<span className="mc-provider-group-count">{items.length}</span>
						</div>
						<div className="mc-providers-list">
							{items.map(p => {
								const isExpanded = expanded.has(p.id);
								const isAuth = p.authenticated ?? false;
								const isConf = p.configured;
								const state = isAuth || isConf ? "ok" : "available";
								const badgeChar = isAuth ? "✓" : isConf ? "●" : p.type === "local" ? "⌂" : "○";
								return (
									<div key={p.id} className="mc-provider-item" data-state={state}>
										<button
											type="button"
											className="mc-provider-row"
											onClick={() => toggleExpand(p.id)}
											title={p.description ?? p.id}
										>
											<span className="mc-provider-badge" data-state={state}>
												{badgeChar}
											</span>
											<span className="mc-provider-name">
												{p.name}
												{p.common && <span className="mc-provider-common">★</span>}
											</span>
											<span className="mc-provider-status">
												{isAuth
													? "logged in"
													: isConf
														? `via ${p.configuredVia === "stored-key" ? "key" : "env"}`
														: ""}
											</span>
											<span className="mc-provider-chev">{isExpanded ? "▾" : "▸"}</span>
										</button>

										{isExpanded && (
											<div className="mc-provider-detail">
												{p.description && <div className="mc-providers-hint">{p.description}</div>}

												{/* OAuth login button */}
												{(p.type === "oauth" || p.type === "coding-plan") && client?.sendLogin && (
													<button
														type="button"
														className="mc-btn mc-btn-primary"
														onClick={() => handleLogin(p.id)}
														disabled={busyProvider === p.id || p.available === false}
													>
														{busyProvider === p.id ? "Opening browser…" : isAuth ? "Re-login" : "Sign in"}
													</button>
												)}

												{/* API key paste */}
												{p.envVars &&
													p.envVars.length > 0 &&
													(pasteFor === p.id ? (
														<form className="mc-key-form" onSubmit={handleSavePaste}>
															{p.envVars.length > 1 && (
																<div className="mc-control-row">
																	<label className="mc-control-label">Env var</label>
																	<select
																		className="mc-select"
																		value={pasteEnvVar}
																		onChange={e => setPasteEnvVar(e.target.value)}
																	>
																		{p.envVars.map(name => (
																			<option key={name} value={name}>
																				{name}
																			</option>
																		))}
																	</select>
																</div>
															)}
															<input
																className="mc-dialog-input"
																type="password"
																value={pasteValue}
																onChange={e => setPasteValue(e.target.value)}
																placeholder={`${pasteEnvVar} value`}
																autoComplete="off"
																spellCheck={false}
															/>
															<div className="mc-dialog-actions">
																<button
																	type="button"
																	className="mc-btn"
																	onClick={() => setPasteFor(null)}
																>
																	Cancel
																</button>
																<button
																	type="submit"
																	className="mc-btn mc-btn-primary"
																	disabled={!pasteValue}
																>
																	Save
																</button>
															</div>
														</form>
													) : (
														<div className="mc-provider-keys">
															<div className="mc-provider-keys-label">Env: {p.envVars.join(" / ")}</div>
															{(() => {
																const stored = keys.find(k => p.envVars?.includes(k.name));
																if (stored) {
																	return (
																		<div className="mc-key-item">
																			<span className="mc-key-name">{stored.name}</span>
																			<span className="mc-key-mask">{stored.masked}</span>
																			<button
																				type="button"
																				className="mc-btn mc-btn-stop"
																				onClick={() => handleDeleteKey(stored.name)}
																			>
																				✕
																			</button>
																		</div>
																	);
																}
																return (
																	<button
																		type="button"
																		className="mc-btn"
																		onClick={() => openPasteFor(p)}
																	>
																		Paste API key
																	</button>
																);
															})()}
														</div>
													))}

												{/* Local provider URL */}
												{p.type === "local" && p.defaultUrl && (
													<div className="mc-providers-hint">
														Default URL: <code>{p.defaultUrl}</code>
														<br />
														omp auto-detects. Override via env or <code>~/.omp/agent/models.yml</code>.
													</div>
												)}

												{/* Provider id (for debugging / models.yml) */}
												<div className="mc-providers-hint">
													ID: <code>{p.id}</code>
												</div>
											</div>
										)}
									</div>
								);
							})}
						</div>
					</section>
				);
			})}

			<button type="button" className="mc-btn" onClick={() => void refresh()} style={{ marginTop: 12 }}>
				⟳ Refresh
			</button>
		</div>
	);
}
