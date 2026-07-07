import { type KeyboardEvent, useEffect, useState } from "react";

/** Text pushed into the composer by the engine (extension_ui `set_editor_text`). */
export interface ComposerInjection {
	text: string;
	nonce: number;
}

interface ComposerProps {
	disabled: boolean;
	streaming: boolean;
	injection?: ComposerInjection;
	onSend: (text: string) => void;
	onAbort: () => void;
}

export function Composer({ disabled, streaming, injection, onSend, onAbort }: ComposerProps) {
	const [text, setText] = useState("");

	// Apply engine-driven editor text (keyed on nonce so repeats re-apply).
	// biome-ignore lint/correctness/useExhaustiveDependencies: apply only when nonce changes
	useEffect(() => {
		if (injection) setText(injection.text);
	}, [injection?.nonce]);

	const submit = () => {
		const trimmed = text.trim();
		if (!trimmed || disabled) return;
		onSend(trimmed);
		setText("");
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			submit();
		}
	};

	return (
		<div className="composer">
			<textarea
				className="composer-input"
				placeholder={disabled ? "Waiting for engine…" : "Message the agent…  (Enter to send, Shift+Enter for newline)"}
				value={text}
				disabled={disabled}
				onChange={event => setText(event.target.value)}
				onKeyDown={onKeyDown}
				rows={3}
			/>
			<div className="composer-actions">
				{streaming ? (
					<button type="button" className="btn btn-danger" onClick={onAbort}>
						Stop
					</button>
				) : (
					<button
						type="button"
						className="btn btn-primary"
						disabled={disabled || text.trim().length === 0}
						onClick={submit}
					>
						Send
					</button>
				)}
			</div>
		</div>
	);
}
