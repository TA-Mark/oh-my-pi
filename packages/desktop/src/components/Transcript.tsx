import { type ToolResultLike, ToolView } from "@oh-my-pi/collab-web/src/tool-render";
import { useEffect, useRef } from "react";
import type { ChatMessage } from "../lib/reducer";
import { Markdown } from "./Markdown";

interface TranscriptProps {
	messages: ChatMessage[];
	/** Agent turn is in flight — show a working indicator until output appears. */
	streaming?: boolean;
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

/** Nearest scrollable ancestor (the `.app-content` container), or null. */
function findScrollParent(element: HTMLElement | null): HTMLElement | null {
	let current = element?.parentElement ?? null;
	while (current) {
		const overflowY = window.getComputedStyle(current).overflowY;
		if (overflowY === "auto" || overflowY === "scroll") return current;
		current = current.parentElement;
	}
	return null;
}

/** Distance in px from the bottom of the scroll container's viewport. */
const NEAR_BOTTOM_PX = 120;

export function Transcript({ messages, streaming = false }: TranscriptProps) {
	const bottomRef = useRef<HTMLDivElement>(null);
	// Track whether the user is pinned to the bottom. We only auto-scroll on new
	// content when they already are — scrolling up to read mid-stream must not be
	// yanked back down. Recomputed on every scroll event.
	const atBottomRef = useRef(true);

	useEffect(() => {
		const scroller = findScrollParent(bottomRef.current);
		if (!scroller) return;
		const onScroll = (): void => {
			const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
			atBottomRef.current = distance <= NEAR_BOTTOM_PX;
		};
		onScroll(); // seed initial state
		scroller.addEventListener("scroll", onScroll, { passive: true });
		return () => scroller.removeEventListener("scroll", onScroll);
	}, []);

	useEffect(() => {
		if (atBottomRef.current) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages, streaming]);

	// Show a working indicator only in the gap between sending and the first
	// output of the turn: once assistant text streams or a tool card appears, the
	// last message is no longer the user's and those rows carry their own progress.
	const lastRole = messages.length > 0 ? messages[messages.length - 1].role : undefined;
	const showThinking = streaming && (messages.length === 0 || lastRole === "user");

	if (messages.length === 0) {
		return (
			<div className="transcript transcript-empty">
				<h1>What should we build in OMP?</h1>
				<div className="empty-prompts" aria-label="Prompt ideas">
					<div>Update desktop smoke-rpc for images, changes, and extension UI drift</div>
					<div>Finish the desktop Changes sidebar with real rename and truncation behavior</div>
					<div>Connect your favorite apps to OMP</div>
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
									<img key={i} src={`data:${img.mimeType};base64,${img.data}`} alt={`attachment ${i + 1}`} />
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
			{showThinking ? (
				<div className="thinking-indicator" role="status" aria-live="polite">
					<span className="thinking-dots" aria-hidden="true">
						<span />
						<span />
						<span />
					</span>
					<span className="thinking-label">OMP is working…</span>
				</div>
			) : null}
			<div ref={bottomRef} />
		</div>
	);
}
