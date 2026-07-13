import { Check, ChevronRight, KeyRound, LogOut, PlugZap, Search, UserRound } from "lucide-react";
import { useMemo, useState } from "react";
import type { LoginProvider, ModelInfo } from "../lib/rpc-protocol";

interface LoginMenuProps {
	providers: LoginProvider[];
	models?: ModelInfo[];
	disabled?: boolean;
	onLogin: (providerId: string) => void;
	onSetApiKey: (providerId: string, apiKey: string) => void;
	onLogout: (providerId: string) => void;
}

function providerInitials(name: string): string {
	const parts = name
		.replace(/\([^)]*\)/g, "")
		.split(/\s+/)
		.filter(Boolean);
	const initials = parts
		.slice(0, 2)
		.map(part => part[0]?.toUpperCase() ?? "")
		.join("");
	return initials || "AI";
}

function authLabel(provider: LoginProvider): string {
	switch (provider.authKind) {
		case "oauth":
			return "OAuth";
		case "api_key":
			return "API key";
		case "env":
			return provider.envVar ? `Env ${provider.envVar}` : "Env";
		case "config":
			return "Config";
		case "runtime":
			return "Runtime";
		case "fallback":
			return "Fallback";
		default:
			return "Connected";
	}
}

export function LoginMenu({ providers, models, disabled, onLogin, onSetApiKey, onLogout }: LoginMenuProps) {
	const [open, setOpen] = useState(false);
	const [apiKeyProvider, setApiKeyProvider] = useState<LoginProvider | null>(null);
	const [apiKey, setApiKey] = useState("");
	const [filter, setFilter] = useState("");
	const modelCounts = useMemo(() => {
		const counts = new Map<string, number>();
		for (const model of models ?? []) {
			counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
		}
		return counts;
	}, [models]);
	const filteredProviders = useMemo(() => {
		const query = filter.trim().toLowerCase();
		if (!query) return providers;
		return providers.filter(provider => {
			const source = `${provider.name} ${provider.id} ${provider.authKind ?? ""} ${provider.envVar ?? ""}`;
			return source.toLowerCase().includes(query);
		});
	}, [filter, providers]);
	if (providers.length === 0) return null;
	const authenticatedProviders = providers.filter(provider => provider.authenticated);
	const signedIn = authenticatedProviders.length;
	const available = providers.filter(provider => provider.available).length;
	const accountTitle = authenticatedProviders[0]?.name ?? "Accounts";
	const submitApiKey = (): void => {
		const nextApiKey = apiKey.trim();
		if (!apiKeyProvider || !nextApiKey) return;
		onSetApiKey(apiKeyProvider.id, nextApiKey);
		setApiKey("");
		setApiKeyProvider(null);
		setOpen(false);
	};

	return (
		<div className="account-menu">
			<button
				type="button"
				className={`account-trigger${open ? " account-trigger--open" : ""}`}
				disabled={disabled}
				aria-expanded={open}
				onClick={() => setOpen(current => !current)}
			>
				<span className="account-avatar">
					<UserRound size={16} strokeWidth={1.9} />
				</span>
				<span className="account-trigger-copy">
					<span className="account-trigger-title">{accountTitle}</span>
				</span>
				<ChevronRight className="account-trigger-caret" size={16} strokeWidth={1.8} />
			</button>
			{open ? (
				<>
					<button
						type="button"
						className="picker-backdrop"
						aria-label="Close accounts"
						onClick={() => {
							setOpen(false);
							setFilter("");
						}}
					/>
					<div className="account-panel">
						<div className="account-panel-head">
							<span className="account-avatar account-avatar--large">
								<PlugZap size={17} strokeWidth={1.9} />
							</span>
							<span className="account-panel-copy">
								<span className="account-panel-title">LLM providers</span>
								<span className="account-panel-subtitle">
									{available} available · {signedIn} connected
								</span>
							</span>
						</div>
						<label className="account-filter">
							<Search size={15} strokeWidth={1.9} />
							<input
								autoFocus
								placeholder="Filter providers..."
								value={filter}
								onChange={event => setFilter(event.currentTarget.value)}
							/>
						</label>
						<div className="account-provider-list">
							{filteredProviders.length === 0 ? <div className="account-empty">No providers</div> : null}
							{filteredProviders.map(provider => (
								<div
									key={provider.id}
									className={`account-provider${provider.authenticated ? " account-provider--connected" : ""}${
										provider.available ? "" : " account-provider--unavailable"
									}`}
								>
									<button
										type="button"
										className="account-provider-main"
										disabled={!provider.available}
										title={
											provider.supportsOAuth
												? provider.authenticated
													? "Re-authenticate"
													: "Sign in"
												: "Use API key"
										}
										onClick={() => {
											if (provider.supportsOAuth) {
												onLogin(provider.id);
												setOpen(false);
											} else {
												setApiKeyProvider(provider);
												setApiKey("");
											}
										}}
									>
										<span className="account-provider-icon">{providerInitials(provider.name)}</span>
										<span className="account-provider-copy">
											<span className="account-provider-name">{provider.name}</span>
											<span className="account-provider-id">{provider.id}</span>
											{modelCounts.has(provider.id) ? (
												<span className="account-provider-models">
													{modelCounts.get(provider.id)!.toLocaleString()} models
												</span>
											) : null}
										</span>
										<span className="account-provider-status">
											{provider.authenticated ? (
												<>
													<Check size={13} strokeWidth={2.1} />
													{authLabel(provider)}
												</>
											) : provider.supportsOAuth ? (
												<>
													Sign in
													<ChevronRight size={13} strokeWidth={2.1} />
												</>
											) : (
												"API key"
											)}
										</span>
									</button>
									{provider.supportsApiKey ? (
										<button
											type="button"
											className="login-signout login-api-key"
											title={`Set API key for ${provider.name}`}
											disabled={disabled || !provider.available}
											onClick={() => {
												setApiKeyProvider(provider);
												setApiKey("");
											}}
										>
											<KeyRound size={14} strokeWidth={1.9} />
										</button>
									) : null}
									{provider.authenticated ? (
										<button
											type="button"
											className="login-signout"
											title={`Sign out of ${provider.name}`}
											onClick={() => {
												onLogout(provider.id);
												setOpen(false);
											}}
										>
											<LogOut size={14} strokeWidth={1.9} />
										</button>
									) : null}
								</div>
							))}
						</div>
					</div>
					{apiKeyProvider ? (
						<div className="account-api-dialog" role="dialog" aria-modal="true">
							<div className="account-api-card">
								<div className="account-api-title">API key for {apiKeyProvider.name}</div>
								<div className="account-api-copy">
									Stored in OMP credentials. Environment keys still take precedence when configured.
								</div>
								<input
									className="account-api-input"
									type="password"
									value={apiKey}
									placeholder="Paste API key..."
									autoFocus
									onChange={event => setApiKey(event.target.value)}
									onKeyDown={event => {
										if (event.key === "Enter") submitApiKey();
										if (event.key === "Escape") {
											setApiKey("");
											setApiKeyProvider(null);
										}
									}}
								/>
								<div className="account-api-actions">
									<button
										type="button"
										className="btn btn-ghost"
										onClick={() => {
											setApiKey("");
											setApiKeyProvider(null);
										}}
									>
										Cancel
									</button>
									<button
										type="button"
										className="btn btn-primary"
										disabled={!apiKey.trim()}
										onClick={submitApiKey}
									>
										Save key
									</button>
								</div>
							</div>
						</div>
					) : null}
				</>
			) : null}
		</div>
	);
}
