import { useState } from "react";

export interface AuthPrompt {
	provider?: string;
	url: string;
	/** Short loopback URL preferred for copying; the full URL remains the open target. */
	copyUrl?: string;
	instructions?: string;
}

interface AuthDialogProps {
	prompt: AuthPrompt | null;
	onOpen: (url: string) => void;
	onCancel: () => void;
}

export function AuthDialog({ prompt, onOpen, onCancel }: AuthDialogProps) {
	const [copied, setCopied] = useState(false);
	if (!prompt) return null;

	const copy = () => {
		navigator.clipboard?.writeText(prompt.copyUrl ?? prompt.url).then(
			() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			},
			() => {},
		);
	};

	return (
		<div className="dialog-backdrop">
			<div className="dialog" role="dialog" aria-modal="true">
				<h2 className="dialog-title">Sign in{prompt.provider ? ` — ${prompt.provider}` : ""}</h2>
				<p className="dialog-message">
					{prompt.instructions ??
						"Continue in your browser to authorize, then return here. This dialog closes automatically when sign-in completes."}
				</p>
				<input
					className="dialog-input"
					readOnly
					value={prompt.copyUrl ?? prompt.url}
					onFocus={event => event.currentTarget.select()}
				/>
				<div className="dialog-actions">
					<button type="button" className="btn btn-ghost" onClick={copy}>
						{copied ? "Copied" : "Copy link"}
					</button>
					<button type="button" className="btn btn-ghost" onClick={onCancel}>
						Cancel
					</button>
					<button type="button" className="btn btn-primary" onClick={() => onOpen(prompt.url)}>
						Open in browser
					</button>
				</div>
			</div>
		</div>
	);
}
