import { ArrowUp, Check, ChevronDown, FolderOpen, Hand, Mic, Plus, Shield, ShieldCheck, Square } from "lucide-react";
import { type ClipboardEvent, type DragEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { ApprovalMode, ImageContent, ThinkingLevel } from "../lib/rpc-protocol";

/** Text pushed into the composer by the engine (extension_ui `set_editor_text`). */
export interface ComposerInjection {
	text: string;
	nonce: number;
}

interface ComposerProps {
	disabled: boolean;
	streaming: boolean;
	injection?: ComposerInjection;
	workspace: string;
	projectName: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	approvalMode?: ApprovalMode;
	onSelectThinking: (level: ThinkingLevel) => void;
	onSelectApprovalMode: (mode: ApprovalMode) => void;
	onChooseProject: () => void;
	onSend: (text: string, images: ImageContent[]) => void;
	onAbort: () => void;
}

type ComposerMenu = "approval" | "profile" | null;

interface ComposerChoice<T extends string> {
	id: T;
	label: string;
	detail: string;
}

const APPROVAL_CHOICES: ComposerChoice<ApprovalMode>[] = [
	{ id: "always-ask", label: "Ask for approval", detail: "Ask before workspace writes and command execution." },
	{ id: "write", label: "Approve workspace writes", detail: "Auto-approve read and write tools; ask before exec tools." },
	{ id: "yolo", label: "Full access", detail: "Auto-approve read, write, and exec tools for this OMP session." },
];

const APPROVAL_ICONS: Record<ApprovalMode, typeof Hand> = {
	"always-ask": Hand,
	write: ShieldCheck,
	yolo: Shield,
};

const THINKING_CHOICES: ComposerChoice<ThinkingLevel>[] = [
	{ id: "auto", label: "Auto", detail: "Let OMP choose the effort." },
	{ id: "off", label: "Off", detail: "Fastest response, no explicit reasoning effort." },
	{ id: "minimal", label: "Minimal", detail: "Small reasoning budget." },
	{ id: "low", label: "Low", detail: "Light reasoning for simple work." },
	{ id: "medium", label: "Medium", detail: "Balanced reasoning for coding tasks." },
	{ id: "high", label: "High", detail: "Deeper reasoning for complex changes." },
	{ id: "xhigh", label: "Extra High", detail: "Maximum OMP reasoning effort." },
];

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

function choiceLabel<T extends string>(choices: readonly ComposerChoice<T>[], id: T): string {
	return choices.find(choice => choice.id === id)?.label ?? id;
}

function composerEffortLabel(level: ThinkingLevel | undefined): string {
	switch (level) {
		case "xhigh":
			return "Extra High";
		case "high":
			return "High";
		case "medium":
			return "Medium";
		case "low":
		case "minimal":
			return "Low";
		case "off":
			return "Off";
		case "inherit":
		case "auto":
		case undefined:
			return "Auto";
	}
}

function composerModelLabel(model: string | undefined): string {
	if (!model) return "Model";
	const slash = model.indexOf("/");
	const id = slash >= 0 ? model.slice(slash + 1) : model;
	if (id.startsWith("gpt-")) return id.slice(4);
	if (id.startsWith("codex-")) return id.slice(6);
	return id;
}

function MenuCheck({ selected }: { selected: boolean }) {
	return selected ? <Check className="composer-menu-check" size={15} strokeWidth={2} /> : null;
}

export function Composer({
	disabled,
	streaming,
	injection,
	workspace,
	projectName,
	model,
	thinkingLevel,
	approvalMode = "yolo",
	onSelectThinking,
	onSelectApprovalMode,
	onChooseProject,
	onSend,
	onAbort,
}: ComposerProps) {
	const [text, setText] = useState("");
	const [images, setImages] = useState<ImageContent[]>([]);
	const [dragOver, setDragOver] = useState(false);
	const [openMenu, setOpenMenu] = useState<ComposerMenu>(null);
	const fileRef = useRef<HTMLInputElement>(null);

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
	const approvalLabel = choiceLabel(APPROVAL_CHOICES, approvalMode);
	const modelLabel = composerModelLabel(model);
	const effortLabel = composerEffortLabel(thinkingLevel);
	const currentThinkingLevel = thinkingLevel ?? "auto";
	const ApprovalIcon = APPROVAL_ICONS[approvalMode];

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
			<div className="composer-context-row" aria-label="Chat context">
				<button
					type="button"
					className="composer-context-chip composer-project-chip"
					title={workspace || projectName}
					onClick={onChooseProject}
				>
					<FolderOpen size={15} strokeWidth={1.7} />
					<span>{projectName || "Choose project"}</span>
				</button>
			</div>
			<div className="composer-input-shell">
				<textarea
					className="composer-input"
					placeholder={disabled ? "Waiting for engine..." : "Do anything"}
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
						className="composer-circle-button"
						onClick={() => fileRef.current?.click()}
						disabled={disabled}
						title="Attach image"
						aria-label="Attach image"
					>
						<Plus size={20} strokeWidth={1.7} />
					</button>
					<div className="composer-menu-anchor composer-approval-anchor">
						<button
							type="button"
							className={`composer-pill composer-pill--approval${openMenu === "approval" ? " composer-pill--active" : ""}`}
							disabled={disabled}
							onClick={() => setOpenMenu(menu => (menu === "approval" ? null : "approval"))}
						>
							<ApprovalIcon size={15} strokeWidth={1.9} />
							<span>{approvalLabel}</span>
							<ChevronDown size={14} strokeWidth={1.8} />
						</button>
						{openMenu === "approval" ? (
							<>
								<button
									type="button"
									className="picker-backdrop"
									aria-label="Close approval menu"
									onClick={() => setOpenMenu(null)}
								/>
								<div className="composer-menu composer-menu--approval">
									{APPROVAL_CHOICES.map(choice => (
										<button
											type="button"
											key={choice.id}
											className={`composer-menu-item${approvalMode === choice.id ? " composer-menu-item--selected" : ""}`}
											onClick={() => {
												onSelectApprovalMode(choice.id);
												setOpenMenu(null);
											}}
										>
											<ShieldCheck size={16} strokeWidth={1.8} />
											<span>
												<strong>{choice.label}</strong>
												<small>{choice.detail}</small>
											</span>
											<MenuCheck selected={approvalMode === choice.id} />
										</button>
									))}
								</div>
							</>
						) : null}
					</div>
					<div className="composer-spacer" />
					<div className="composer-menu-anchor composer-profile-anchor">
						<button
							type="button"
							className={`composer-text-button${openMenu === "profile" ? " composer-text-button--active" : ""}`}
							title={`Model: ${model ?? "No model selected"} / Thinking: ${effortLabel}`}
							disabled={disabled}
							onClick={() => setOpenMenu(menu => (menu === "profile" ? null : "profile"))}
						>
							<span className="composer-profile-model">{modelLabel}</span>
							<span className="composer-profile-thinking">{effortLabel}</span>
							<ChevronDown size={14} strokeWidth={1.8} />
						</button>
						{openMenu === "profile" ? (
							<>
								<button
									type="button"
									className="picker-backdrop"
									aria-label="Close model summary"
									onClick={() => setOpenMenu(null)}
								/>
								<div className="composer-menu composer-menu--profile">
									<div className="composer-menu-info">
										<span>Model</span>
										<strong>{model ?? "No model selected"}</strong>
									</div>
									<div className="composer-menu-section-title">Thinking</div>
									{THINKING_CHOICES.map(choice => (
										<button
											type="button"
											key={choice.id}
											className={`composer-menu-item${currentThinkingLevel === choice.id ? " composer-menu-item--selected" : ""}`}
											onClick={() => {
												onSelectThinking(choice.id);
												setOpenMenu(null);
											}}
										>
											<ShieldCheck size={16} strokeWidth={1.8} />
											<span>
												<strong>{choice.label}</strong>
												<small>{choice.detail}</small>
											</span>
											<MenuCheck selected={currentThinkingLevel === choice.id} />
										</button>
									))}
								</div>
							</>
						) : null}
					</div>
					<button
						type="button"
						className="composer-icon-action"
						disabled
						title="Voice input"
						aria-label="Voice input"
					>
						<Mic size={18} strokeWidth={1.8} />
					</button>
					{streaming ? (
						<button
							type="button"
							className="composer-send composer-send--stop"
							onClick={onAbort}
							aria-label="Stop"
						>
							<Square size={14} fill="currentColor" strokeWidth={1.8} />
						</button>
					) : (
						<button
							type="button"
							className="composer-send"
							disabled={!canSend}
							onClick={submit}
							aria-label="Send"
						>
							<ArrowUp size={20} strokeWidth={2.1} />
						</button>
					)}
				</div>

			</div>
		</div>
	);
}
