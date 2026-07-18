import { Send, Square } from "lucide-react";
import { useState } from "react";

export interface SideChatMessage {
	role: "user" | "assistant" | "system";
	text: string;
}

interface SideChatPanelProps {
	ready: boolean;
	starting: boolean;
	messages: SideChatMessage[];
	onEnsure: () => void;
	onFork: () => void;
	onAddResult: () => void;
	worktreePath: string | null;
	onToggleWorktree: () => void;
	onSend: (text: string) => void;
	onClose: () => void;
}

export function SideChatPanel({
	ready,
	starting,
	messages,
	onEnsure,
	onFork,
	onAddResult,
	worktreePath,
	onToggleWorktree,
	onSend,
	onClose,
}: SideChatPanelProps) {
	const [text, setText] = useState("");
	return (
		<div className="side-chat-panel">
			<div className="side-chat-status">
				{starting ? "Starting isolated engine…" : ready ? "Isolated session ready" : "Side engine stopped"}
				{!ready && !starting ? (
					<button type="button" onClick={onEnsure}>
						Start
					</button>
				) : null}
				<button type="button" disabled={!ready} onClick={onFork}>
					Fork context
				</button>
				<button type="button" disabled={starting} onClick={onToggleWorktree}>
					{worktreePath ? "Remove isolated worktree" : "Use isolated worktree"}
				</button>
				<button type="button" onClick={onClose}>
					Close
				</button>
			</div>
			<div className="side-chat-messages">
				{messages.length === 0 ? (
					<p className="tools-placeholder-copy">This chat has its own engine, session and transcript.</p>
				) : (
					messages.map((message, index) => (
						<article
							className={`side-chat-message side-chat-message--${message.role}`}
							key={`${message.role}:${index}`}
						>
							<strong>{message.role}</strong>
							<p>{message.text}</p>
							{message.role === "assistant" && index === messages.length - 1 ? (
								<button type="button" onClick={onAddResult}>
									Add response to main context
								</button>
							) : null}
						</article>
					))
				)}
			</div>
			<form
				className="side-chat-composer"
				onSubmit={event => {
					event.preventDefault();
					if (text.trim() && ready) {
						onSend(text.trim());
						setText("");
					}
				}}
			>
				<textarea
					value={text}
					onChange={event => setText(event.currentTarget.value)}
					disabled={!ready}
					placeholder={ready ? "Message side chat…" : "Waiting for side engine…"}
					rows={3}
				/>
				<button type="submit" disabled={!ready || !text.trim()}>
					<Send size={15} /> Send
				</button>
				<button type="button" disabled={!ready} title="Stop side engine" onClick={onClose}>
					<Square size={14} />
				</button>
			</form>
		</div>
	);
}
