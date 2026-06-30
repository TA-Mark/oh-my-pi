/**
 * ExtensionDialog — modal renderer for omp's `extension_ui_request` frames.
 *
 * Variants:
 *   - select         → keyboard-navigable option list (first option marked "Recommended")
 *   - confirm        → yes / no
 *   - input          → single-line text
 *   - editor         → multi-line text with optional prefill
 *   - model-controls → rich /model surface (tabs: Models / Roles / Thinking / Queue / Toggles)
 *
 * Esc → cancelled response. Timeout is handled by RpcClient itself.
 */
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import type { ChatClient, DialogResponsePayload } from "../../../lib/chat-client";
import type { PendingDialog } from "../../../lib/client";
import { ModelControlsBody } from "./ModelControlsBody";

interface Props {
	dialog: PendingDialog;
	onRespond(payload: DialogResponsePayload): void;
	client?: ChatClient | null;
}

export function ExtensionDialog({ dialog, onRespond, client }: Props): ReactNode {
	const cancel = (): void => onRespond({ cancelled: true });
	const isWide = dialog.method === "model-controls";

	return (
		<div className="mc-dialog-overlay" onMouseDown={cancel}>
			<div
				className={`mc-dialog ${isWide ? "mc-dialog-wide-wrap" : ""}`}
				role="dialog"
				aria-modal="true"
				onMouseDown={e => e.stopPropagation()}
			>
				{!isWide && <div className="mc-dialog-title">{dialog.title}</div>}
				{dialog.method === "select" && <SelectBody dialog={dialog} onRespond={onRespond} />}
				{dialog.method === "confirm" && <ConfirmBody dialog={dialog} onRespond={onRespond} />}
				{dialog.method === "input" && <InputBody dialog={dialog} onRespond={onRespond} />}
				{dialog.method === "editor" && <EditorBody dialog={dialog} onRespond={onRespond} />}
				{dialog.method === "model-controls" && client ? (
					<ModelControlsBody client={client} onClose={cancel} />
				) : dialog.method === "model-controls" ? (
					<div className="mc-dialog-empty">No active session — start a chat to configure the model.</div>
				) : null}
			</div>
		</div>
	);
}

// ─── Select ──────────────────────────────────────────────────────────────────

function SelectBody({
	dialog,
	onRespond,
}: {
	dialog: Extract<PendingDialog, { method: "select" }>;
	onRespond(payload: DialogResponsePayload): void;
}): ReactNode {
	const [index, setIndex] = useState(0);
	const listRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		listRef.current?.focus();
	}, []);

	const accept = (i: number): void => {
		const option = dialog.options[i];
		if (option !== undefined) onRespond({ value: option });
	};

	const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setIndex(i => Math.min(i + 1, dialog.options.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setIndex(i => Math.max(i - 1, 0));
		} else if (e.key === "Enter") {
			e.preventDefault();
			accept(index);
		} else if (e.key === "Escape") {
			e.preventDefault();
			onRespond({ cancelled: true });
		}
	};

	return (
		<>
			<div className="mc-dialog-options" role="listbox" tabIndex={0} ref={listRef} onKeyDown={onKey}>
				{dialog.options.map((opt, i) => (
					<button
						type="button"
						key={`${i}-${opt}`}
						className="mc-dialog-option"
						data-active={i === index ? "true" : undefined}
						role="option"
						aria-selected={i === index}
						onMouseEnter={() => setIndex(i)}
						onClick={() => accept(i)}
					>
						<span className="mc-dialog-option-label">{opt}</span>
						{i === 0 && <span className="mc-dialog-option-tag">Recommended</span>}
					</button>
				))}
			</div>
			<div className="mc-dialog-hint">↑↓ navigate · Enter select · Esc cancel</div>
		</>
	);
}

// ─── Confirm ─────────────────────────────────────────────────────────────────

function ConfirmBody({
	dialog,
	onRespond,
}: {
	dialog: Extract<PendingDialog, { method: "confirm" }>;
	onRespond(payload: DialogResponsePayload): void;
}): ReactNode {
	const noRef = useRef<HTMLButtonElement | null>(null);
	useEffect(() => {
		noRef.current?.focus();
	}, []);

	const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
		if (e.key === "Escape") {
			e.preventDefault();
			onRespond({ cancelled: true });
		} else if (e.key === "y" || e.key === "Y") {
			e.preventDefault();
			onRespond({ confirmed: true });
		} else if (e.key === "n" || e.key === "N") {
			e.preventDefault();
			onRespond({ confirmed: false });
		}
	};

	return (
		<div onKeyDown={onKey}>
			<div className="mc-dialog-message">{dialog.message}</div>
			<div className="mc-dialog-actions">
				<button type="button" className="mc-btn" ref={noRef} onClick={() => onRespond({ confirmed: false })}>
					No
				</button>
				<button type="button" className="mc-btn mc-btn-primary" onClick={() => onRespond({ confirmed: true })}>
					Yes
				</button>
			</div>
			<div className="mc-dialog-hint">Y / N · Esc cancel</div>
		</div>
	);
}

// ─── Input ───────────────────────────────────────────────────────────────────

function InputBody({
	dialog,
	onRespond,
}: {
	dialog: Extract<PendingDialog, { method: "input" }>;
	onRespond(payload: DialogResponsePayload): void;
}): ReactNode {
	const [value, setValue] = useState("");
	const inputRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
		if (e.key === "Enter") {
			e.preventDefault();
			onRespond({ value });
		} else if (e.key === "Escape") {
			e.preventDefault();
			onRespond({ cancelled: true });
		}
	};

	return (
		<>
			<input
				ref={inputRef}
				className="mc-dialog-input"
				value={value}
				placeholder={dialog.placeholder ?? ""}
				onChange={e => setValue(e.target.value)}
				onKeyDown={onKey}
				spellCheck={false}
			/>
			<div className="mc-dialog-actions">
				<button type="button" className="mc-btn" onClick={() => onRespond({ cancelled: true })}>
					Cancel
				</button>
				<button type="button" className="mc-btn mc-btn-primary" onClick={() => onRespond({ value })}>
					Submit
				</button>
			</div>
			<div className="mc-dialog-hint">Enter submit · Esc cancel</div>
		</>
	);
}

// ─── Editor ──────────────────────────────────────────────────────────────────

function EditorBody({
	dialog,
	onRespond,
}: {
	dialog: Extract<PendingDialog, { method: "editor" }>;
	onRespond(payload: DialogResponsePayload): void;
}): ReactNode {
	const [value, setValue] = useState(dialog.prefill ?? "");
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	useEffect(() => {
		taRef.current?.focus();
		taRef.current?.select();
	}, []);

	const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
			e.preventDefault();
			onRespond({ value });
		} else if (e.key === "Escape") {
			e.preventDefault();
			onRespond({ cancelled: true });
		}
	};

	return (
		<>
			<textarea
				ref={taRef}
				className="mc-dialog-textarea"
				value={value}
				onChange={e => setValue(e.target.value)}
				onKeyDown={onKey}
				rows={8}
				spellCheck={false}
			/>
			<div className="mc-dialog-actions">
				<button type="button" className="mc-btn" onClick={() => onRespond({ cancelled: true })}>
					Cancel
				</button>
				<button type="button" className="mc-btn mc-btn-primary" onClick={() => onRespond({ value })}>
					Submit
				</button>
			</div>
			<div className="mc-dialog-hint">Ctrl/⌘ + Enter submit · Esc cancel</div>
		</>
	);
}
