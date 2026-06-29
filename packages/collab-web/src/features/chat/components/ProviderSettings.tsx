/**
 * ProviderSettings — show omp's provider list, surface login + key-paste UI.
 *
 * Provider list comes from omp via `get_login_providers` (live; no cache in
 * bridge). API keys are persisted by the bridge to `<installDir>/api-keys.json`
 * and merged into omp's env on next session spawn. OAuth providers light up
 * the browser via the existing `extension_ui_request open_url` path that the
 * RpcClient already handles.
 */

import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { ChatClient } from "../../../lib/chat-client";
import type { LoginProvider } from "../../../lib/rpc-client";
import { deleteApiKey, listApiKeys, type StoredApiKey, saveApiKey } from "../api/chatApi";

interface Props {
	/** RPC client for the active session; null while no session is selected. */
	client: ChatClient | null;
}

/** Common env-var names users will recognise from the README. */
const KNOWN_KEY_NAMES = [
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"GEMINI_API_KEY",
	"XAI_API_KEY",
	"GROQ_API_KEY",
	"MISTRAL_API_KEY",
	"DEEPSEEK_API_KEY",
	"PERPLEXITY_API_KEY",
	"OPENROUTER_API_KEY",
	"FIREWORKS_API_KEY",
	"TOGETHER_API_KEY",
];

export function ProviderSettings({ client }: Props): ReactNode {
	const [providers, setProviders] = useState<LoginProvider[] | null>(null);
	const [keys, setKeys] = useState<StoredApiKey[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busyProvider, setBusyProvider] = useState<string | null>(null);

	// Key-paste form state
	const [keyName, setKeyName] = useState<string>(KNOWN_KEY_NAMES[0]!);
	const [keyValue, setKeyValue] = useState("");
	const [keyCustom, setKeyCustom] = useState(false);

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const tasks: Promise<unknown>[] = [listApiKeys().then(r => setKeys(r.keys))];
			if (client?.sendGetLoginProviders) {
				tasks.push(client.sendGetLoginProviders().then(setProviders));
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

	const handleLogin = useCallback(
		(providerId: string) => {
			if (!client?.sendLogin) return;
			setBusyProvider(providerId);
			client.sendLogin(providerId);
			// Browser will open via extension_ui_request open_url. Re-poll a few
			// seconds later in case the OAuth callback already completed.
			setTimeout(() => {
				setBusyProvider(null);
				void refresh();
			}, 3000);
		},
		[client, refresh],
	);

	const handleSaveKey = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			if (!keyName || !keyValue) return;
			try {
				await saveApiKey(keyName, keyValue);
				setKeyValue("");
				await refresh();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		},
		[keyName, keyValue, refresh],
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

	return (
		<div className="mc-providers">
			<div className="mc-section-title">Providers</div>

			{error && (
				<div className="mc-providers-error" role="alert">
					{error}
				</div>
			)}

			{/* OAuth / sign-in providers */}
			<div className="mc-providers-list">
				{!client && <div className="mc-providers-hint">Start a chat session to load provider list.</div>}
				{client && providers === null && !loading && <div className="mc-providers-hint">Connecting to agent…</div>}
				{providers?.length === 0 && <div className="mc-providers-hint">No OAuth providers available.</div>}
				{providers?.map(p => (
					<div key={p.id} className="mc-provider-item" data-state={p.authenticated ? "ok" : "available"}>
						<span className="mc-provider-badge" data-state={p.authenticated ? "ok" : "available"}>
							{p.authenticated ? "✓" : p.available ? "○" : "⊘"}
						</span>
						<span className="mc-provider-name">{p.name}</span>
						<button
							type="button"
							className="mc-btn"
							onClick={() => handleLogin(p.id)}
							disabled={!p.available || busyProvider === p.id}
						>
							{busyProvider === p.id ? "Opening…" : p.authenticated ? "Re-login" : "Login"}
						</button>
					</div>
				))}
			</div>

			{/* API keys */}
			<div className="mc-section-title" style={{ marginTop: 16 }}>
				API Keys
			</div>
			<div className="mc-providers-hint">
				Pasted keys are written to <code>api-keys.json</code> on this machine and forwarded to omp as environment
				variables on every new session.
			</div>

			<form className="mc-key-form" onSubmit={handleSaveKey}>
				<div className="mc-control-row">
					<label className="mc-control-label" htmlFor="mc-key-name">
						Env var name
					</label>
					{keyCustom ? (
						<input
							id="mc-key-name"
							className="mc-dialog-input"
							value={keyName}
							onChange={e => setKeyName(e.target.value.toUpperCase())}
							placeholder="MY_PROVIDER_API_KEY"
							spellCheck={false}
						/>
					) : (
						<select
							id="mc-key-name"
							className="mc-select"
							value={keyName}
							onChange={e => {
								if (e.target.value === "__custom__") {
									setKeyCustom(true);
									setKeyName("");
								} else {
									setKeyName(e.target.value);
								}
							}}
						>
							{KNOWN_KEY_NAMES.map(n => (
								<option key={n} value={n}>
									{n}
								</option>
							))}
							<option value="__custom__">Custom…</option>
						</select>
					)}
				</div>
				<div className="mc-control-row">
					<label className="mc-control-label" htmlFor="mc-key-value">
						Value
					</label>
					<input
						id="mc-key-value"
						className="mc-dialog-input"
						type="password"
						value={keyValue}
						onChange={e => setKeyValue(e.target.value)}
						placeholder="sk-…"
						spellCheck={false}
						autoComplete="off"
					/>
				</div>
				<button type="submit" className="mc-btn mc-btn-primary" disabled={!keyName || !keyValue}>
					Save key
				</button>
			</form>

			{keys.length > 0 && (
				<div className="mc-keys-list">
					{keys.map(k => (
						<div key={k.name} className="mc-key-item">
							<span className="mc-key-name">{k.name}</span>
							<span className="mc-key-mask">{k.masked}</span>
							<button
								type="button"
								className="mc-btn mc-btn-stop"
								onClick={() => handleDeleteKey(k.name)}
								title={`Delete ${k.name}`}
							>
								✕
							</button>
						</div>
					))}
				</div>
			)}

			<button type="button" className="mc-btn" onClick={() => void refresh()} style={{ marginTop: 12 }}>
				⟳ Refresh
			</button>
		</div>
	);
}
