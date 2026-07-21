import { type FormEvent, useEffect, useState } from "react";
import type { ExtensionUIRequest, ExtensionUIResponse } from "../lib/rpc-protocol";

interface DialogHostProps {
	/** Active dialog request (only select/confirm/input/editor reach here), or null. */
	request: ExtensionUIRequest | null;
	onRespond: (response: ExtensionUIResponse) => void;
}

export interface LocalConfirmOptions {
	title: string;
	message: string;
	confirmLabel?: string;
	cancelLabel?: string;
	danger?: boolean;
}

export interface LocalPromptOptions {
	title: string;
	message?: string;
	initialValue?: string;
	placeholder?: string;
	multiline?: boolean;
	confirmLabel?: string;
	cancelLabel?: string;
}

export interface LocalSelectOptions {
	title: string;
	message?: string;
	options: string[];
}

export interface LocalBranchItem {
	entryId: string;
	text: string;
}

export interface LocalBranchPickerOptions {
	title: string;
	message?: string;
	items: LocalBranchItem[];
}

export type LocalDialogInput =
	| ({ kind: "confirm" } & LocalConfirmOptions)
	| ({ kind: "prompt" } & LocalPromptOptions)
	| ({ kind: "select" } & LocalSelectOptions)
	| ({ kind: "branch" } & LocalBranchPickerOptions);

export type LocalDialogRequest = { id: string } & LocalDialogInput;

export interface LocalDialogResult {
	confirmed: boolean;
	value?: string;
	selectedIndex?: number;
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

export function LocalDialogHost({
	request,
	onRespond,
}: {
	request: LocalDialogRequest | null;
	onRespond: (result: LocalDialogResult) => void;
}) {
	if (!request) return null;
	return (
		<div className="dialog-backdrop">
			<div className="dialog" role={request.kind === "confirm" ? "alertdialog" : "dialog"} aria-modal="true">
				<LocalDialogBody key={request.id} request={request} onRespond={onRespond} />
			</div>
		</div>
	);
}

function LocalDialogBody({
	request,
	onRespond,
}: {
	request: LocalDialogRequest;
	onRespond: (result: LocalDialogResult) => void;
}) {
	const [text, setText] = useState(request.kind === "prompt" ? (request.initialValue ?? "") : "");
	const [filter, setFilter] = useState("");
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onRespond({ confirmed: false });
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onRespond]);

	if (request.kind === "confirm") {
		return (
			<>
				<h2 className="dialog-title">{request.title}</h2>
				<p className="dialog-message">{request.message}</p>
				<div className="dialog-actions">
					<button type="button" className="btn btn-ghost" onClick={() => onRespond({ confirmed: false })}>
						{request.cancelLabel ?? "Cancel"}
					</button>
					<button
						type="button"
						className={request.danger ? "btn btn-danger" : "btn btn-primary"}
						autoFocus
						onClick={() => onRespond({ confirmed: true })}
					>
						{request.confirmLabel ?? "Confirm"}
					</button>
				</div>
			</>
		);
	}

	if (request.kind === "select") {
		return (
			<>
				<h2 className="dialog-title">{request.title}</h2>
				{request.message ? <p className="dialog-message">{request.message}</p> : null}
				<div className="dialog-options">
					{request.options.map((option, index) => (
						<button
							key={`${index}-${option}`}
							type="button"
							className="dialog-option"
							autoFocus={index === 0}
							onClick={() => onRespond({ confirmed: true, selectedIndex: index })}
						>
							{option}
						</button>
					))}
				</div>
				<div className="dialog-actions">
					<button type="button" className="btn btn-ghost" onClick={() => onRespond({ confirmed: false })}>
						Cancel
					</button>
				</div>
			</>
		);
	}

	if (request.kind === "branch") {
		const normalizedFilter = filter.trim().toLowerCase();
		const items = request.items.filter(item => item.text.toLowerCase().includes(normalizedFilter)).slice(0, 50);
		return (
			<>
				<h2 className="dialog-title">{request.title}</h2>
				{request.message ? <p className="dialog-message">{request.message}</p> : null}
				<input
					className="dialog-input"
					autoFocus
					placeholder="Filter messages"
					value={filter}
					onChange={event => setFilter(event.target.value)}
				/>
				<div className="dialog-options dialog-branch-list">
					{items.length > 0 ? (
						items.map(item => (
							<button
								key={item.entryId}
								type="button"
								className="dialog-option dialog-branch-option"
								onClick={() => onRespond({ confirmed: true, value: item.entryId })}
							>
								{item.text}
							</button>
						))
					) : (
						<p className="dialog-message">No messages match the filter.</p>
					)}
				</div>
				<div className="dialog-actions">
					<button type="button" className="btn btn-ghost" onClick={() => onRespond({ confirmed: false })}>
						Cancel
					</button>
				</div>
			</>
		);
	}

	const submit = (event?: FormEvent) => {
		event?.preventDefault();
		onRespond({ confirmed: true, value: text });
	};
	return (
		<form onSubmit={submit}>
			<h2 className="dialog-title">{request.title}</h2>
			{request.message ? <p className="dialog-message">{request.message}</p> : null}
			{request.multiline ? (
				<textarea
					className="dialog-textarea"
					autoFocus
					rows={7}
					placeholder={request.placeholder}
					value={text}
					onChange={event => setText(event.target.value)}
				/>
			) : (
				<input
					className="dialog-input"
					autoFocus
					placeholder={request.placeholder}
					value={text}
					onChange={event => setText(event.target.value)}
				/>
			)}
			<div className="dialog-actions">
				<button type="button" className="btn btn-ghost" onClick={() => onRespond({ confirmed: false })}>
					{request.cancelLabel ?? "Cancel"}
				</button>
				<button type="submit" className="btn btn-primary">
					{request.confirmLabel ?? "Submit"}
				</button>
			</div>
		</form>
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
		const timeout =
			"timeout" in request && typeof request.timeout === "number" && request.timeout > 0
				? window.setTimeout(
						() => onRespond({ type: "extension_ui_response", id, cancelled: true, timedOut: true }),
						request.timeout,
					)
				: undefined;
		return () => {
			window.removeEventListener("keydown", onKey);
			if (timeout !== undefined) window.clearTimeout(timeout);
		};
	}, [id, onRespond, request]);

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
						autoFocus
						placeholder={request.placeholder}
						value={text}
						onChange={event => setText(event.target.value)}
					/>
				) : (
					<textarea
						className="dialog-textarea"
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
