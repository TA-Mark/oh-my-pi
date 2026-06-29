/**
 * InstallChoicesCard — lists the 5 README-documented install methods,
 * auto-highlights the one recommended for the current OS, and lets the
 * user pick + run one with a single click. Falls back to "Copy command"
 * for cases where the user wants to run it in their own terminal.
 *
 * Wired to `/api/v1/installer/methods` (list) and `/api/v1/installer/jobs`
 * (dispatch by method id).
 */

import { type ReactNode, useCallback, useState } from "react";
import type { InstallMethod, InstallMethodsResponse } from "../api/installerApi";

interface Props {
	methods: InstallMethodsResponse;
	installPath: string;
	busy: boolean;
	selectedId: InstallMethod["id"] | null;
	onSelect(id: InstallMethod["id"]): void;
	onInstall(id: InstallMethod["id"]): void;
}

function platformLabel(p: InstallMethodsResponse["platform"]): string {
	switch (p) {
		case "win32":
			return "Windows";
		case "darwin":
			return "macOS";
		case "linux":
			return "Linux";
		default:
			return p;
	}
}

export function InstallChoicesCard({ methods, installPath, busy, selectedId, onSelect, onInstall }: Props): ReactNode {
	const [copiedId, setCopiedId] = useState<string | null>(null);

	const copy = useCallback(async (id: string, command: string) => {
		try {
			await navigator.clipboard.writeText(command);
			setCopiedId(id);
			setTimeout(() => setCopiedId(prev => (prev === id ? null : prev)), 1500);
		} catch {
			/* clipboard unavailable */
		}
	}, []);

	return (
		<div className="ins-card">
			<div className="ins-card-title">Choose how to install omp</div>
			<div className="ins-card-sub">
				Detected OS: <strong>{platformLabel(methods.platform)}</strong> · The highlighted method is the one omp.sh
				recommends. You can pick a different one.
			</div>

			<div className="ins-choices">
				{methods.methods.map(m => {
					const isRecommended = m.id === methods.recommended;
					const isSelected = selectedId === m.id || (selectedId === null && isRecommended);
					return (
						<button
							key={m.id}
							type="button"
							className={[
								"ins-choice",
								isSelected ? "ins-choice-selected" : "",
								isRecommended ? "ins-choice-recommended" : "",
							]
								.filter(Boolean)
								.join(" ")}
							onClick={() => onSelect(m.id)}
							disabled={busy}
							aria-pressed={isSelected}
						>
							<div className="ins-choice-head">
								<span className="ins-choice-label">{m.label}</span>
								{isRecommended && <span className="ins-choice-pill">recommended</span>}
							</div>
							<code className="ins-choice-command">{m.command}</code>
							{m.requires.length > 0 && (
								<div className="ins-choice-requires">needs: {m.requires.join(", ")}</div>
							)}
							{m.notes && <div className="ins-choice-notes">{m.notes}</div>}
						</button>
					);
				})}
			</div>

			<div className="ins-choices-meta">
				Install path: <code>{installPath}</code>
			</div>

			<div className="ins-choices-actions">
				<button
					type="button"
					className="sh-btn"
					onClick={() => {
						const id = selectedId ?? methods.recommended;
						const m = methods.methods.find(x => x.id === id);
						if (m) void copy(m.id, m.command);
					}}
					disabled={busy}
				>
					{copiedId ? "✓ Copied" : "Copy command"}
				</button>
				<button
					type="button"
					className="sh-btn sh-btn-primary"
					onClick={() => onInstall(selectedId ?? methods.recommended)}
					disabled={busy}
				>
					{busy ? "Installing…" : "Install"}
				</button>
			</div>
		</div>
	);
}
