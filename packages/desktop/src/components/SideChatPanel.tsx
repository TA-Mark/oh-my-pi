import { Bot, GitBranch, MessageCircle, Plus, Send, Square, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { LoginProvider, ModelInfo } from "../lib/rpc-protocol";
import { ModelPicker } from "./ModelPicker";

export interface SideChatMessage {
	role: "user" | "assistant" | "system";
	text: string;
}

interface SideChatPanelProps {
	ready: boolean;
	starting: boolean;
	busy: boolean;
	messages: SideChatMessage[];
	onEnsure: () => void;
	onStop: () => void;
	onFork: () => void;
	onAddResult: () => void;
	worktreePath: string | null;
	models: ModelInfo[];
	providers: LoginProvider[];
	model?: string;
	onSelectModel: (provider: string, modelId: string) => void;
	onToggleWorktree: () => void;
	onSend: (text: string) => void;
	onClose: () => void;
}

function worktreeName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function roleLabel(role: SideChatMessage["role"]): string {
	if (role === "user") return "You";
	if (role === "assistant") return "Side chat";
	return "System";
}

export function SideChatPanel({
	ready,
	starting,
	busy,
	messages,
	onEnsure,
	onStop,
	onFork,
	onAddResult,
	worktreePath,
	models,
	providers,
	model,
	onSelectModel,
	onToggleWorktree,
	onSend,
	onClose,
}: SideChatPanelProps) {
	const [text, setText] = useState("");
	const composerRef = useRef<HTMLTextAreaElement | null>(null);
	const messagesEndRef = useRef<HTMLDivElement | null>(null);
	const lastAssistantIndex = messages.reduce(
		(index, message, messageIndex) => (message.role === "assistant" ? messageIndex : index),
		-1,
	);

	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ block: "end" });
	}, [messages.length, busy]);

	const resizeComposer = (): void => {
		const composer = composerRef.current;
		if (!composer) return;
		composer.style.height = "auto";
		composer.style.height = `${Math.min(composer.scrollHeight, 160)}px`;
	};

	const submit = (): void => {
		const value = text.trim();
		if (!value || !ready || busy) return;
		onSend(value);
		setText("");
		requestAnimationFrame(resizeComposer);
	};

	const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (event.key !== "Enter" || event.shiftKey) return;
		event.preventDefault();
		submit();
	};

	const statusLabel = starting ? "Starting isolated session" : busy ? "Thinking" : ready ? "Ready" : "Not running";
	return (
		<div className="side-chat-panel">
			<header className="side-chat-header">
				<div className="side-chat-heading">
					<span className="side-chat-icon">
						<MessageCircle size={16} strokeWidth={1.8} />
					</span>
					<div>
						<strong>Side chat</strong>
						<span>Separate context for quick exploration</span>
					</div>
				</div>
				<div className="side-chat-header-actions">
					<button type="button" onClick={onFork} disabled={!ready || busy} title="Fork recent main-task context">
						<GitBranch size={14} strokeWidth={1.8} />
						<span>Fork context</span>
					</button>
					<button type="button" onClick={onClose} title="Close side chat">
						<X size={15} strokeWidth={1.8} />
					</button>
				</div>
			</header>

			<div className="side-chat-meta">
				<span
					className={`side-chat-dot${ready ? " side-chat-dot--ready" : starting ? " side-chat-dot--busy" : ""}`}
				/>
				<span>{statusLabel}</span>
				{worktreePath ? (
					<span className="side-chat-worktree" title={worktreePath}>
						<GitBranch size={12} strokeWidth={1.8} /> {worktreeName(worktreePath)}
					</span>
				) : null}
				<div className="side-chat-meta-actions">
					{!ready && !starting ? (
						<button type="button" onClick={onEnsure}>
							<Plus size={13} strokeWidth={1.8} /> Start session
						</button>
					) : null}
					<button type="button" disabled={starting} onClick={onToggleWorktree}>
						{worktreePath ? "Remove worktree" : "Use worktree"}
					</button>
				</div>
			</div>

			<div className="side-chat-messages" aria-live="polite">
				{messages.length === 0 ? (
					<div className="side-chat-empty">
						<Bot size={28} strokeWidth={1.4} />
						<strong>Explore without interrupting the main task</strong>
						<span>Ask for an alternative, inspect an idea, or fork the latest main-task context.</span>
					</div>
				) : (
					messages.map((message, index) => (
						<article
							className={`side-chat-message side-chat-message--${message.role}`}
							key={`${message.role}:${index}`}
						>
							<div className="side-chat-message-head">
								<span className="side-chat-message-avatar">
									{message.role === "assistant" ? (
										<Bot size={13} strokeWidth={1.8} />
									) : message.role === "user" ? (
										"Y"
									) : (
										"!"
									)}
								</span>
								<strong>{roleLabel(message.role)}</strong>
							</div>
							<p>{message.text}</p>
							{message.role === "assistant" && index === lastAssistantIndex ? (
								<button type="button" className="side-chat-add-result" onClick={onAddResult}>
									<Plus size={13} strokeWidth={1.8} /> Add response to context
								</button>
							) : null}
						</article>
					))
				)}
				<div ref={messagesEndRef} />
			</div>

			<form
				className="side-chat-composer"
				onSubmit={event => {
					event.preventDefault();
					submit();
				}}
			>
				<textarea
					ref={composerRef}
					value={text}
					onChange={event => {
						setText(event.currentTarget.value);
						resizeComposer();
					}}
					onKeyDown={onComposerKeyDown}
					disabled={!ready || busy}
					placeholder={
						starting ? "Starting side chat…" : ready ? "Message side chat…" : "Start the side session to begin"
					}
					rows={1}
				/>
				<div className="side-chat-composer-footer">
					<div className="side-chat-composer-hint">
						<span>Enter to send · Shift+Enter for a new line</span>
						{models.length > 0 ? (
							<div className="side-chat-model-picker">
								<ModelPicker
									current={model}
									models={models}
									providers={providers}
									disabled={!ready || busy}
									onSelect={onSelectModel}
								/>
							</div>
						) : null}
					</div>
					{busy ? (
						<button type="button" className="side-chat-stop" onClick={onStop} title="Stop response">
							<Square size={13} strokeWidth={1.8} /> Stop
						</button>
					) : (
						<button
							type="submit"
							className="side-chat-send"
							disabled={!ready || !text.trim()}
							title="Send message"
						>
							<Send size={14} strokeWidth={1.8} /> Send
						</button>
					)}
				</div>
			</form>
		</div>
	);
}
