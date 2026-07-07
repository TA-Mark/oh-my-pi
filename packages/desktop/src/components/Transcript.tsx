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

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new content
	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

	if (messages.length === 0) {
		return (
			<div className="transcript transcript-empty">
				<p>No messages yet. Send a prompt to start.</p>
			</div>
		);
	}

	return (
		<div className="transcript">
			{messages.map(message => {
				if (message.role === "tool") return <ToolBubble key={message.id} message={message} />;
				return (
					<div key={message.id} className={`bubble bubble-${message.role}`}>
						<div className="bubble-role">{message.role}</div>
						{message.role === "user" ? (
							<div className="bubble-text">{message.text}</div>
						) : (
							<Markdown text={message.text} />
						)}
					</div>
				);
			})}
			<div ref={bottomRef} />
		</div>
	);
}
