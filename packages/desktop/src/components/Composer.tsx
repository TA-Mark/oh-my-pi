import {
	ArrowUp,
	Bot,
	Check,
	ChevronDown,
	ChevronRight,
	FolderOpen,
	Hand,
	Mic,
	Plus,
	Shield,
	ShieldCheck,
	Square,
} from "lucide-react";
import { type ClipboardEvent, type DragEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
	ApprovalMode,
	AvailableCommand,
	ImageContent,
	LoginProvider,
	ModelInfo,
	ThinkingLevel,
} from "../lib/rpc-protocol";

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
	models?: ModelInfo[];
	providers?: LoginProvider[];
	availableCommands?: AvailableCommand[];
	thinkingLevel?: ThinkingLevel;
	approvalMode?: ApprovalMode;
	onSelectModel?: (provider: string, id: string) => void;
	onSelectThinking: (level: ThinkingLevel) => void;
	onSelectApprovalMode: (mode: ApprovalMode) => void;
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	interruptMode?: "immediate" | "wait";
	autoCompactionEnabled?: boolean;
	autoRetryEnabled?: boolean;
	queuedMessageCount?: number;
	onSetSteeringMode?: (mode: "all" | "one-at-a-time") => void;
	onSetFollowUpMode?: (mode: "all" | "one-at-a-time") => void;
	onSetInterruptMode?: (mode: "immediate" | "wait") => void;
	onSetAutoCompaction?: (enabled: boolean) => void;
	onSetAutoRetry?: (enabled: boolean) => void;
	onCompact?: () => void;
	onAbortRetry?: () => void;
	onChooseProject: () => void;
	images: ImageContent[];
	onImagesChange: (images: ImageContent[]) => void;
	onSend: (text: string, images: ImageContent[], streamingBehavior?: "steer" | "followUp") => void;
	onAbort: () => void;
	/** Stop clicked, turn still tearing down — shows "Stopping…" and blocks repeat clicks. */
	aborting?: boolean;
}

type ComposerMenu = "approval" | "profile" | null;

interface ComposerChoice<T extends string> {
	id: T;
	label: string;
	detail: string;
}

const APPROVAL_CHOICES: ComposerChoice<ApprovalMode>[] = [
	{ id: "always-ask", label: "Ask for approval", detail: "Ask before workspace writes and command execution." },
	{
		id: "write",
		label: "Approve workspace writes",
		detail: "Auto-approve read and write tools; ask before exec tools.",
	},
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
	{ id: "max", label: "Max", detail: "Maximum reasoning supported by this model." },
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

function providerDisplayName(providers: readonly LoginProvider[], providerId: string): string {
	return providers.find(provider => provider.id === providerId)?.name ?? providerId;
}

/** Group models by provider for the composer picker: connected providers first, then alphabetical. */
function groupModelsByProvider(
	models: readonly ModelInfo[],
	providers: readonly LoginProvider[],
	filter: string,
): Array<[string, ModelInfo[]]> {
	const query = filter.trim().toLowerCase();
	const list = query ? models.filter(model => `${model.provider}/${model.id}`.toLowerCase().includes(query)) : models;
	const priority = new Map(
		providers.map((provider, index) => [provider.id, provider.authenticated ? index : index + providers.length]),
	);
	const buckets = new Map<string, ModelInfo[]>();
	for (const model of list) {
		const bucket = buckets.get(model.provider) ?? [];
		bucket.push(model);
		buckets.set(model.provider, bucket);
	}
	return [...buckets.entries()].sort((left, right) => {
		const leftPriority = priority.get(left[0]) ?? Number.MAX_SAFE_INTEGER;
		const rightPriority = priority.get(right[0]) ?? Number.MAX_SAFE_INTEGER;
		if (leftPriority !== rightPriority) return leftPriority - rightPriority;
		return providerDisplayName(providers, left[0]).localeCompare(providerDisplayName(providers, right[0]));
	});
}

function composerEffortLabel(level: ThinkingLevel | undefined): string {
	switch (level) {
		case "max":
			return "Max";
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
	aborting = false,
	injection,
	workspace,
	projectName,
	model,
	models,
	providers,
	availableCommands = [],
	thinkingLevel,
	approvalMode = "yolo",
	onSelectModel,
	onSelectThinking,
	onSelectApprovalMode,
	steeringMode,
	followUpMode,
	interruptMode,
	autoCompactionEnabled,
	autoRetryEnabled,
	queuedMessageCount = 0,
	onSetSteeringMode,
	onSetFollowUpMode,
	onSetInterruptMode,
	onSetAutoCompaction,
	onSetAutoRetry,
	onCompact,
	onAbortRetry,
	onChooseProject,
	images,
	onImagesChange,
	onSend,
	onAbort,
}: ComposerProps) {
	const [text, setText] = useState("");
	const [dragOver, setDragOver] = useState(false);
	const [openMenu, setOpenMenu] = useState<ComposerMenu>(null);
	const [modelFilter, setModelFilter] = useState("");
	const [collapsedProviders, setCollapsedProviders] = useState<Set<string>>(() => new Set());
	const [commandMenuOpen, setCommandMenuOpen] = useState(false);
	const [streamingBehavior, setStreamingBehavior] = useState<"steer" | "followUp">("steer");
	const fileRef = useRef<HTMLInputElement>(null);

	const modelGroups = useMemo(
		() => groupModelsByProvider(models ?? [], providers ?? [], modelFilter),
		[models, providers, modelFilter],
	);
	const modelGroupKey = modelGroups.map(([providerId]) => providerId).join("\n");
	const currentModelProvider = model ? model.slice(0, model.indexOf("/")) : undefined;
	const commandQuery = text.startsWith("/") ? text.slice(1).split(/\s/, 1)[0].toLowerCase() : "";
	const commandSuggestions = useMemo(() => {
		if (!text.startsWith("/") || text.includes(" ")) return [];
		return availableCommands
			.filter(command => `${command.name} ${(command.aliases ?? []).join(" ")}`.toLowerCase().includes(commandQuery))
			.slice(0, 8);
	}, [availableCommands, commandQuery, text]);

	// When the model menu opens, expand only connected providers (and the active model's provider); collapse the rest.
	useEffect(() => {
		if (openMenu !== "profile") return;
		const connected = new Set(
			(providers ?? []).filter(provider => provider.authenticated).map(provider => provider.id),
		);
		setCollapsedProviders(
			new Set(
				modelGroups
					.map(([providerId]) => providerId)
					.filter(providerId => providerId !== currentModelProvider && !connected.has(providerId)),
			),
		);
	}, [openMenu, modelGroupKey, currentModelProvider, providers]);

	const toggleProvider = (providerId: string): void => {
		setCollapsedProviders(collapsed => {
			const next = new Set(collapsed);
			if (next.has(providerId)) next.delete(providerId);
			else next.add(providerId);
			return next;
		});
	};

	useEffect(() => {
		if (injection) setText(injection.text);
	}, [injection?.nonce]);

	useEffect(() => {
		setCommandMenuOpen(commandSuggestions.length > 0);
	}, [commandSuggestions.length]);

	const addFiles = async (files: Iterable<File>): Promise<void> => {
		const parsed = await Promise.all(Array.from(files).map(fileToImage));
		const valid = parsed.filter((img): img is ImageContent => img !== null);
		if (valid.length > 0) onImagesChange([...images, ...valid]);
	};

	const removeImage = (index: number): void => {
		onImagesChange(images.filter((_, i) => i !== index));
	};

	const submit = () => {
		const trimmed = text.trim();
		if (disabled || (trimmed.length === 0 && images.length === 0)) return;
		onSend(trimmed, images, streaming ? streamingBehavior : undefined);
		setText("");
		onImagesChange([]);
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
	const thinkingChoices = useMemo(() => {
		const slash = model?.indexOf("/") ?? -1;
		const provider = slash >= 0 ? model?.slice(0, slash) : undefined;
		const id = slash >= 0 ? model?.slice(slash + 1) : model;
		const selectedModel = models?.find(candidate => candidate.provider === provider && candidate.id === id);
		if (!selectedModel?.reasoning) return THINKING_CHOICES.filter(choice => choice.id === "off");
		const supported = selectedModel.thinking?.efforts;
		if (!supported || supported.length === 0) {
			return THINKING_CHOICES.filter(choice => choice.id === "off" || choice.id === "auto");
		}
		return THINKING_CHOICES.filter(
			choice => choice.id === "off" || choice.id === "auto" || supported.includes(choice.id),
		);
	}, [model, models]);
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
				{commandMenuOpen && commandSuggestions.length > 0 ? (
					<div className="composer-command-menu" role="listbox" aria-label="Slash commands">
						{commandSuggestions.map(command => (
							<button
								type="button"
								key={command.name}
								className="composer-command-item"
								onMouseDown={event => event.preventDefault()}
								onClick={() => {
									setText(`/${command.name} `);
									setCommandMenuOpen(false);
								}}
							>
								<strong>/{command.name}</strong>
								<small>{command.description ?? command.source}</small>
							</button>
						))}
					</div>
				) : null}
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
					{streaming ? (
						<button
							type="button"
							className="composer-text-button composer-queue-button"
							onClick={() => setStreamingBehavior(mode => (mode === "steer" ? "followUp" : "steer"))}
							title="Choose how a message is queued while OMP is running"
						>
							<span>
								{streamingBehavior === "steer" ? "Steer" : "Follow-up"}
								{queuedMessageCount > 0 ? ` · ${queuedMessageCount} queued` : ""}
							</span>
							<ChevronDown size={14} strokeWidth={1.8} />
						</button>
					) : null}
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
									{onSelectModel && (models?.length ?? 0) > 0 ? (
										<div className="composer-menu-models">
											<div className="composer-menu-section-title">Model</div>
											<label className="composer-model-search">
												<input
													placeholder="Filter models…"
													value={modelFilter}
													onChange={event => setModelFilter(event.currentTarget.value)}
												/>
											</label>
											<div className="composer-model-list">
												{modelGroups.length === 0 ? (
													<div className="composer-model-empty">No models</div>
												) : (
													modelGroups.map(([providerId, providerModels]) => {
														const collapsed = collapsedProviders.has(providerId);
														return (
															<div key={providerId} className="composer-model-group">
																<button
																	type="button"
																	className="composer-model-group-title"
																	onClick={() => toggleProvider(providerId)}
																>
																	<span className="composer-model-group-name">
																		{collapsed ? (
																			<ChevronRight size={13} strokeWidth={2} />
																		) : (
																			<ChevronDown size={13} strokeWidth={2} />
																		)}
																		<span>{providerDisplayName(providers ?? [], providerId)}</span>
																	</span>
																	<span>{providerModels.length.toLocaleString()} models</span>
																</button>
																{collapsed
																	? null
																	: providerModels.map(candidate => {
																			const label = `${candidate.provider}/${candidate.id}`;
																			const selected = label === model;
																			return (
																				<button
																					type="button"
																					key={label}
																					className={`composer-menu-item${selected ? " composer-menu-item--selected" : ""}`}
																					onClick={() => {
																						onSelectModel(candidate.provider, candidate.id);
																						setOpenMenu(null);
																						setModelFilter("");
																					}}
																				>
																					<Bot size={16} strokeWidth={1.8} />
																					<span>
																						<strong>{candidate.id}</strong>
																						<small>{candidate.provider}</small>
																					</span>
																					<MenuCheck selected={selected} />
																				</button>
																			);
																		})}
															</div>
														);
													})
												)}
											</div>
										</div>
									) : (
										<div className="composer-menu-info">
											<span>Model</span>
											<strong>{model ?? "No model selected"}</strong>
										</div>
									)}
									<div className="composer-menu-section-title">Thinking</div>
									{thinkingChoices.map(choice => (
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
									<div className="composer-menu-section-title">Queue and lifecycle</div>
									{onSetSteeringMode ? (
										<div className="composer-menu-choice-row">
											<span>Steering queue</span>
											<div>
												{(["all", "one-at-a-time"] as const).map(mode => (
													<button
														type="button"
														key={mode}
														className={steeringMode === mode ? "selected" : ""}
														onClick={() => onSetSteeringMode(mode)}
													>
														{mode === "all" ? "All" : "One"}
													</button>
												))}
											</div>
										</div>
									) : null}
									{onSetFollowUpMode ? (
										<div className="composer-menu-choice-row">
											<span>Follow-up queue</span>
											<div>
												{(["all", "one-at-a-time"] as const).map(mode => (
													<button
														type="button"
														key={mode}
														className={followUpMode === mode ? "selected" : ""}
														onClick={() => onSetFollowUpMode(mode)}
													>
														{mode === "all" ? "All" : "One"}
													</button>
												))}
											</div>
										</div>
									) : null}
									{onSetInterruptMode ? (
										<div className="composer-menu-choice-row">
											<span>Interrupt mode</span>
											<div>
												{(["immediate", "wait"] as const).map(mode => (
													<button
														type="button"
														key={mode}
														className={interruptMode === mode ? "selected" : ""}
														onClick={() => onSetInterruptMode(mode)}
													>
														{mode === "immediate" ? "Immediate" : "Wait"}
													</button>
												))}
											</div>
										</div>
									) : null}
									{onSetAutoCompaction ? (
										<button
											type="button"
											className="composer-menu-item"
											onClick={() => onSetAutoCompaction(!autoCompactionEnabled)}
										>
											<span>
												<strong>Auto compaction</strong>
												<small>{autoCompactionEnabled ? "Enabled" : "Disabled"}</small>
											</span>
										</button>
									) : null}
									{onSetAutoRetry ? (
										<button
											type="button"
											className="composer-menu-item"
											onClick={() => onSetAutoRetry(!autoRetryEnabled)}
										>
											<span>
												<strong>Auto retry</strong>
												<small>{autoRetryEnabled ? "Enabled" : "Disabled"}</small>
											</span>
										</button>
									) : null}
									{onCompact ? (
										<button
											type="button"
											className="composer-menu-item"
											disabled={streaming}
											onClick={onCompact}
										>
											<span>
												<strong>Compact context</strong>
												<small>Summarize the current session context</small>
											</span>
										</button>
									) : null}
									{onAbortRetry ? (
										<button type="button" className="composer-menu-item" onClick={onAbortRetry}>
											<span>
												<strong>Abort retry</strong>
												<small>Stop an automatic retry in progress</small>
											</span>
										</button>
									) : null}
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
							className={`composer-send composer-send--stop${aborting ? " composer-send--stopping" : ""}`}
							onClick={onAbort}
							disabled={aborting}
							aria-label={aborting ? "Stopping" : "Stop"}
							title={aborting ? "Stopping…" : "Stop"}
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
