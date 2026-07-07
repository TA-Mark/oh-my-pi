export interface Toast {
	id: string;
	message: string;
	type: "info" | "warning" | "error";
}

interface ToastsProps {
	toasts: Toast[];
	onDismiss: (id: string) => void;
}

export function Toasts({ toasts, onDismiss }: ToastsProps) {
	if (toasts.length === 0) return null;
	return (
		<div className="toasts">
			{toasts.map(toast => (
				<button key={toast.id} type="button" className={`toast toast-${toast.type}`} onClick={() => onDismiss(toast.id)}>
					{toast.message}
				</button>
			))}
		</div>
	);
}
