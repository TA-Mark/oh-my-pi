import type { HostToolCallRequest } from "../lib/rpc-protocol";

interface HostApprovalDialogProps {
	request: HostToolCallRequest | null;
	label?: string;
	onDecision: (approved: boolean) => void;
}

export function HostApprovalDialog({ request, label, onDecision }: HostApprovalDialogProps) {
	if (!request) return null;
	return (
		<div className="dialog-backdrop">
			<div className="dialog" role="alertdialog" aria-modal="true" aria-label="Host tool approval">
				<h2 className="dialog-title">Allow host tool?</h2>
				<p className="dialog-message">
					<strong>{label ?? request.toolName}</strong> requested by the OMP agent.
				</p>
				<pre className="dialog-code">{JSON.stringify(request.arguments, null, 2)}</pre>
				<div className="dialog-actions">
					<button type="button" className="btn btn-ghost" onClick={() => onDecision(false)}>
						Deny
					</button>
					<button type="button" className="btn btn-primary" autoFocus onClick={() => onDecision(true)}>
						Allow once
					</button>
				</div>
			</div>
		</div>
	);
}
