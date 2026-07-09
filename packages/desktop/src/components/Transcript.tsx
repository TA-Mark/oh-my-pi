import { ToolView, type ToolResultLike } from "@oh-my-pi/collab-web/src/tool-render";
import { useEffect, useRef } from "react";
import type { ChatMessage } from "../lib/reducer";
import { Markdown } from "./Markdown";

interface TranscriptProps {
	messages: ChatMessage[];
}

function ToolBubble({ message }: { message: ChatMessage }) {
	return (
		<div className="tool-row">
			<ToolView
				name={message.toolName ?? "tool"}
				args={message.toolArgs}
				result={message.toolResult as ToolResultLike | undefined}
				running={message.toolRunning}
				intent={message.toolIntent}
				partial={message.toolPartial}
			/>
		</div>
	);
}

export function Transcript({ messages }: TranscriptProps) {
	const bottomRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

	if (messages.length === 0) {
		return (
			<div className="transcript transcript-empty">
				<h1>What should we build in OMP?</h1>
				<div className="empty-prompts" aria-label="Prompt ideas">
					<div>Review current desktop changes</div>
					<div>Improve the session workflow</div>
					<div>Plan the next release pass</div>
				</div>
			</div>
		);
	}

	return (
		<div className="transcript">
			{messages.map(message => {
				if (message.role === "tool") return <ToolBubble key={message.id} message={message} />;
				const plain = message.role === "user" || message.error;
				return (
					<div key={message.id} className={`bubble bubble-${message.role}${message.error ? " bubble-error" : ""}`}>
						<div className="bubble-role">{message.error ? "error" : message.role}</div>
						{message.images && message.images.length > 0 && (
							<div className="bubble-images">
								{message.images.map((img, i) => (
									<img
										key={i}
										src={`data:${img.mimeType};base64,${img.data}`}
										alt={`attachment ${i + 1}`}
									/>
								))}
							</div>
						)}
						{message.text ? (
							plain ? (
								<div className="bubble-text">{message.text}</div>
							) : (
								<Markdown text={message.text} />
							)
						) : null}
					</div>
				);
			})}
			<div ref={bottomRef} />
		</div>
	);
}
