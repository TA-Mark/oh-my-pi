import { type ClipboardEvent, type DragEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { ImageContent } from "../lib/rpc-protocol";

/** Text pushed into the composer by the engine (extension_ui `set_editor_text`). */
export interface ComposerInjection {
	text: string;
	nonce: number;
}

interface ComposerProps {
	disabled: boolean;
	streaming: boolean;
	injection?: ComposerInjection;
	onSend: (text: string, images: ImageContent[]) => void;
	onAbort: () => void;
}

/** Read an image File into an `ImageContent` (base64, no data-URL prefix). */
function fileToImage(file: File): Promise<ImageContent | null> {
	const { promise, resolve } = Promise.withResolvers<ImageContent | null>();
	if (!file.type.startsWith("image/")) {
		resolve(null);
		return promise;
	}
	const reader = new FileReader();
	reader.onload = () => {
		const result = typeof reader.result === "string" ? reader.result : "";
		const comma = result.indexOf(",");
		const data = comma >= 0 ? result.slice(comma + 1) : "";
		resolve(data ? { type: "image", data, mimeType: file.type } : null);
	};
	reader.onerror = () => resolve(null);
	reader.readAsDataURL(file);
	return promise;
}

export function Composer({ disabled, streaming, injection, onSend, onAbort }: ComposerProps) {
	const [text, setText] = useState("");
	const [images, setImages] = useState<ImageContent[]>([]);
	const [dragOver, setDragOver] = useState(false);
	const fileRef = useRef<HTMLInputElement>(null);

	// Apply engine-driven editor text (keyed on nonce so repeats re-apply).
	useEffect(() => {
		if (injection) setText(injection.text);
	}, [injection?.nonce]);

	const addFiles = async (files: Iterable<File>): Promise<void> => {
		const parsed = await Promise.all(Array.from(files).map(fileToImage));
		const valid = parsed.filter((img): img is ImageContent => img !== null);
		if (valid.length > 0) setImages(prev => [...prev, ...valid]);
	};

	const removeImage = (index: number): void => {
		setImages(prev => prev.filter((_, i) => i !== index));
	};

	const submit = () => {
		const trimmed = text.trim();
		if (disabled || (trimmed.length === 0 && images.length === 0)) return;
		onSend(trimmed, images);
		setText("");
		setImages([]);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			submit();
		}
	};

	const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
		const files = Array.from(event.clipboardData?.items ?? [])
			.filter(item => item.kind === "file" && item.type.startsWith("image/"))
			.map(item => item.getAsFile())
			.filter((file): file is File => file !== null);
		if (files.length > 0) {
			event.preventDefault();
			void addFiles(files);
		}
	};

	const onDrop = (event: DragEvent<HTMLDivElement>) => {
		event.preventDefault();
		setDragOver(false);
		if (disabled) return;
		const files = Array.from(event.dataTransfer?.files ?? []).filter(file => file.type.startsWith("image/"));
		if (files.length > 0) void addFiles(files);
	};

	const onDragOver = (event: DragEvent<HTMLDivElement>) => {
		if (disabled) return;
		event.preventDefault();
		setDragOver(true);
	};

	const canSend = !disabled && (text.trim().length > 0 || images.length > 0);

	return (
		<div
			className={`composer${dragOver ? " composer--dragover" : ""}`}
			onDragOver={onDragOver}
			onDragLeave={() => setDragOver(false)}
			onDrop={onDrop}
		>
			{images.length > 0 && (
				<div className="composer-attachments">
					{images.map((img, i) => (
						<div key={i} className="attachment">
							<img src={`data:${img.mimeType};base64,${img.data}`} alt={`attachment ${i + 1}`} />
							<button
								type="button"
								className="attachment-remove"
								onClick={() => removeImage(i)}
								aria-label="Remove attachment"
							>
								x
							</button>
						</div>
					))}
				</div>
			)}
			<div className="composer-input-shell">
				<textarea
					className="composer-input"
					placeholder={disabled ? "Waiting for engine..." : "Ask OMP to build, inspect, or change something"}
					value={text}
					disabled={disabled}
					onChange={event => setText(event.target.value)}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
					rows={3}
				/>
				<div className="composer-actions">
					<input
						ref={fileRef}
						type="file"
						accept="image/*"
						multiple
						hidden
						onChange={event => {
							if (event.target.files) void addFiles(event.target.files);
							event.target.value = "";
						}}
					/>
					<button
						type="button"
						className="btn-ghost composer-attach"
						onClick={() => fileRef.current?.click()}
						disabled={disabled}
						title="Attach image"
						aria-label="Attach image"
					>
						+
					</button>
					<span className="composer-access">Workspace</span>
					{streaming ? (
						<button type="button" className="btn btn-danger" onClick={onAbort}>
							Stop
						</button>
					) : (
						<button type="button" className="btn btn-primary composer-send" disabled={!canSend} onClick={submit}>
							↑
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
