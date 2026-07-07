import { type FormEvent, useEffect, useState } from "react";
import type { ExtensionUIRequest, ExtensionUIResponse } from "../lib/rpc-protocol";

interface DialogHostProps {
	/** Active dialog request (only select/confirm/input/editor reach here), or null. */
	request: ExtensionUIRequest | null;
	onRespond: (response: ExtensionUIResponse) => void;
}

export function DialogHost({ request, onRespond }: DialogHostProps) {
	if (!request) return null;
	return (
		<div className="dialog-backdrop">
			<div className="dialog" role="dialog" aria-modal="true">
				<DialogBody key={request.id} request={request} onRespond={onRespond} />
			</div>
		</div>
	);
}

function DialogBody({
	request,
	onRespond,
}: {
	request: ExtensionUIRequest;
	onRespond: (response: ExtensionUIResponse) => void;
}) {
	const id = request.id;
	const initial = request.method === "editor" ? (request.prefill ?? "") : "";
	const [text, setText] = useState(initial);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onRespond({ type: "extension_ui_response", id, cancelled: true });
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [id, onRespond]);

	const cancel = () => onRespond({ type: "extension_ui_response", id, cancelled: true });

	if (request.method === "confirm") {
		return (
			<>
				<h2 className="dialog-title">{request.title}</h2>
				<p className="dialog-message">{request.message}</p>
				<div className="dialog-actions">
					<button
						type="button"
						className="btn btn-ghost"
						onClick={() => onRespond({ type: "extension_ui_response", id, confirmed: false })}
					>
						No
					</button>
					<button
						type="button"
						className="btn btn-primary"
						// biome-ignore lint/a11y/noAutofocus: default action in a modal dialog
						autoFocus
						onClick={() => onRespond({ type: "extension_ui_response", id, confirmed: true })}
					>
						Yes
					</button>
				</div>
			</>
		);
	}

	if (request.method === "select") {
		return (
			<>
				<h2 className="dialog-title">{request.title}</h2>
				<div className="dialog-options">
					{request.options.map((option, index) => (
						<button
							key={`${index}-${option}`}
							type="button"
							className="dialog-option"
							onClick={() => onRespond({ type: "extension_ui_response", id, value: option })}
						>
							{option}
						</button>
					))}
				</div>
				<div className="dialog-actions">
					<button type="button" className="btn btn-ghost" onClick={cancel}>
						Cancel
					</button>
				</div>
			</>
		);
	}

	if (request.method === "input" || request.method === "editor") {
		const submit = (event?: FormEvent) => {
			event?.preventDefault();
			onRespond({ type: "extension_ui_response", id, value: text });
		};
		return (
			<form onSubmit={submit}>
				<h2 className="dialog-title">{request.title}</h2>
				{request.method === "input" ? (
					<input
						className="dialog-input"
						// biome-ignore lint/a11y/noAutofocus: focus the field when the dialog opens
						autoFocus
						placeholder={request.placeholder}
						value={text}
						onChange={event => setText(event.target.value)}
					/>
				) : (
					<textarea
						className="dialog-textarea"
						// biome-ignore lint/a11y/noAutofocus: focus the field when the dialog opens
						autoFocus
						rows={8}
						value={text}
						onChange={event => setText(event.target.value)}
					/>
				)}
				<div className="dialog-actions">
					<button type="button" className="btn btn-ghost" onClick={cancel}>
						Cancel
					</button>
					<button type="submit" className="btn btn-primary">
						Submit
					</button>
				</div>
			</form>
		);
	}

	return null;
}
