import { useState } from "react";
import type { LoginProvider } from "../lib/rpc-protocol";

interface LoginMenuProps {
	providers: LoginProvider[];
	disabled?: boolean;
	onLogin: (providerId: string) => void;
	onLogout: (providerId: string) => void;
}

export function LoginMenu({ providers, disabled, onLogin, onLogout }: LoginMenuProps) {
	const [open, setOpen] = useState(false);
	if (providers.length === 0) return null;
	const signedIn = providers.filter(p => p.authenticated).length;

	return (
		<div className="picker">
			<button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => setOpen(o => !o)}>
				{signedIn > 0 ? `Accounts (${signedIn})` : "Sign in"}
			</button>
			{open ? (
				<>
					<button type="button" className="picker-backdrop" aria-label="Close" onClick={() => setOpen(false)} />
					<div className="picker-panel">
						<div className="picker-list">
							{providers.map(provider => (
								<div key={provider.id} className="login-row">
									<button
										type="button"
										className="login-main"
										disabled={!provider.available}
										title={provider.authenticated ? "Re-authenticate" : "Sign in"}
										onClick={() => {
											onLogin(provider.id);
											setOpen(false);
										}}
									>
										<span className="picker-item-id">{provider.name}</span>
										<span className="picker-item-provider">
											{provider.authenticated ? "✓ signed in" : provider.available ? "sign in" : "unavailable"}
										</span>
									</button>
									{provider.authenticated ? (
										<button
											type="button"
											className="login-signout"
											onClick={() => {
												onLogout(provider.id);
												setOpen(false);
											}}
										>
											Sign out
										</button>
									) : null}
								</div>
							))}
						</div>
					</div>
				</>
			) : null}
		</div>
	);
}
