import type { ReactNode } from "react";
import type { InstallerPhase, InstallMethod, InstallMethodId } from "../types/installer";

interface Props {
	installPath: string;
	phase: InstallerPhase;
	selectedMethod: InstallMethodId | null;
	methodDef: InstallMethod | null;
	onInstallPathChange(installPath: string): void;
}

const locked: InstallerPhase[] = ["checking", "installing", "success"];

/**
 * Path setup card. Only the Windows Binary path (`windows-irm`) honours a
 * user-typed install location — every other README method is a global
 * installer that lands omp in a system-managed directory. We render an
 * info-only card with the destination hint for those methods so the user
 * is not tricked into thinking the textbox controls anything.
 */
export function SourceSetupCard({
	installPath,
	phase,
	selectedMethod,
	methodDef,
	onInstallPathChange,
}: Props): ReactNode {
	const disabled = locked.includes(phase);
	const isBinaryMode = selectedMethod === "windows-irm";

	if (!isBinaryMode) {
		return (
			<div className="ins-card">
				<div className="ins-card-title">Where omp will land</div>
				<div className="ins-card-sub">
					{methodDef?.label ?? "This method"} is a global installer — it picks the destination itself. No path
					input is needed.
				</div>
				{methodDef?.targetHint && (
					<div className="ins-field">
						<div className="ins-field-label">Destination</div>
						<code className="ins-input ins-input-mono" style={{ display: "block", whiteSpace: "pre-wrap" }}>
							{methodDef.targetHint}
						</code>
					</div>
				)}
			</div>
		);
	}

	return (
		<div className="ins-card">
			<div className="ins-card-title">Install path (Binary mode)</div>
			<div className="ins-card-sub">
				Sets <code>PI_INSTALL_DIR</code> for the official Windows installer. Ignored if the installer detects Bun
				and switches to <code>bun install -g</code>.
			</div>

			<div className="ins-field">
				<label className="ins-field-label" htmlFor="ins-path">
					Install Path
				</label>
				<input
					id="ins-path"
					className="ins-input ins-input-mono"
					type="text"
					value={installPath}
					disabled={disabled}
					placeholder="%LOCALAPPDATA%\\omp"
					onChange={e => onInstallPathChange(e.target.value)}
				/>
			</div>
		</div>
	);
}
