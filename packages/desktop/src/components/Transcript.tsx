import { ToolView } from "@oh-my-pi/collab-web/src/tool-render/ToolView";
import type { ToolResultLike } from "@oh-my-pi/collab-web/src/tool-render/types";
import { ArrowDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { agentWorkingLabel, DEFAULT_AGENT_DISPLAY_NAME } from "../lib/agent-display-name";
import type { ChatMessage } from "../lib/reducer";
import { sessionWorkTurns, transcriptMessageDomId } from "../lib/session-work-preview";
import { AgentNameLabel } from "./AgentNameLabel";
import { Markdown } from "./Markdown";

interface TranscriptProps {
	messages: ChatMessage[];
	/** Agent turn is in flight — show a working indicator until output appears. */
	streaming?: boolean;
	assistantName?: string;
	onRenameAssistant?: (name: string) => void;
}

function ToolBubble({ message, elementId }: { message: ChatMessage; elementId: string }) {
	return (
		<div id={elementId} className="chat-row chat-row--tool tool-row">
			<div className="chat-gutter">
				<span className="chat-role-label">tool</span>
			</div>
			<div className="chat-body chat-tool-body">
				<ToolView
					name={message.toolName ?? "tool"}
					args={message.toolArgs}
					result={message.toolResult as ToolResultLike | undefined}
					running={message.toolRunning}
					intent={message.toolIntent}
					partial={message.toolPartial}
				/>
			</div>
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

export function Transcript({
	messages,
	streaming = false,
	assistantName = DEFAULT_AGENT_DISPLAY_NAME,
	onRenameAssistant,
}: TranscriptProps) {
	const bottomRef = useRef<HTMLDivElement>(null);
	// Track whether the user is pinned to the bottom. We only auto-scroll on new
	// content when they already are — scrolling up to read mid-stream must not be
	// yanked back down. Recomputed on every scroll event.
	const atBottomRef = useRef(true);
	const [showScrollToWork, setShowScrollToWork] = useState(false);
	const workTurns = useMemo(() => sessionWorkTurns(messages), [messages]);
	const preview = workTurns.at(-1);
	const recentTurns = workTurns.slice(-5).reverse();

	const scrollToWork = (): void => {
		atBottomRef.current = true;
		setShowScrollToWork(false);
		bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
	};

	const scrollToMessage = (messageId: string): void => {
		document
			.getElementById(transcriptMessageDomId(messageId))
			?.scrollIntoView({ block: "start", behavior: "smooth" });
	};

	useEffect(() => {
		const scroller = findScrollParent(bottomRef.current);
		if (!scroller) return;
		const onScroll = (): void => {
			const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
			const atBottom = distance <= NEAR_BOTTOM_PX;
			atBottomRef.current = atBottom;
			setShowScrollToWork(current => (current === !atBottom ? current : !atBottom));
		};
		onScroll(); // seed initial state
		scroller.addEventListener("scroll", onScroll, { passive: true });
		return () => scroller.removeEventListener("scroll", onScroll);
	}, []);

	useEffect(() => {
		if (atBottomRef.current) {
			bottomRef.current?.scrollIntoView({ behavior: "smooth" });
			setShowScrollToWork(false);
		} else {
			setShowScrollToWork(true);
		}
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
		<div className="transcript transcript--rows">
			{messages.map(message => {
				const elementId = transcriptMessageDomId(message.id);
				if (message.role === "tool") {
					return <ToolBubble key={message.id} message={message} elementId={elementId} />;
				}
				const plain = message.role === "user" || message.error;
				const rowRole = message.error ? "error" : message.role;
				const gutterLabel = message.error ? "error" : message.role === "user" ? "you" : message.role;
				return (
					<div id={elementId} key={message.id} className={`chat-row chat-row--${rowRole}`}>
						<div className="chat-gutter">
							{message.role === "assistant" && !message.error ? (
								<AgentNameLabel name={assistantName} onRename={onRenameAssistant} />
							) : (
								<span className="chat-role-label">{gutterLabel}</span>
							)}
						</div>
						<div className={`chat-body bubble bubble-${message.role}${message.error ? " bubble-error" : ""}`}>
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
					</div>
				);
			})}
			{showThinking ? (
				<div className="chat-row chat-row--assistant chat-row--thinking">
					<div className="chat-gutter">
						<span className="chat-role-label">{assistantName}</span>
					</div>
					<div className="chat-body thinking-indicator" role="status" aria-live="polite">
						<span className="thinking-dots" aria-hidden="true">
							<span />
							<span />
							<span />
						</span>
						<span className="thinking-label">{agentWorkingLabel(assistantName)}</span>
					</div>
				</div>
			) : null}
			{showScrollToWork && preview ? (
				<div className="session-work-preview-shell" aria-label="Recent session work">
					<button
						type="button"
						className="session-work-preview"
						onClick={() => scrollToMessage(preview.targetMessageId)}
						title="Jump to this turn"
					>
						<strong>{preview.title}</strong>
						{preview.detail ? <span>{preview.detail}</span> : null}
					</button>
					{recentTurns.length > 1 ? (
						<div className="session-work-history" role="list" aria-label="Recent work in this session">
							<div className="session-work-history-title">Recent work</div>
							{recentTurns.map(turn => (
								<button
									key={turn.id}
									type="button"
									className="session-work-history-item"
									onClick={() => scrollToMessage(turn.targetMessageId)}
								>
									<strong>{turn.title}</strong>
									{turn.detail ? <span>{turn.detail}</span> : null}
									{turn.toolCount > 0 ? (
										<small>
											{turn.toolCount} tool{turn.toolCount === 1 ? "" : "s"}
										</small>
									) : null}
								</button>
							))}
						</div>
					) : null}
				</div>
			) : null}
			{showScrollToWork ? (
				<button
					type="button"
					className="scroll-to-work-button"
					onClick={scrollToWork}
					aria-label="Scroll to current work"
					title="Scroll to current work"
				>
					<ArrowDown size={24} strokeWidth={2} />
				</button>
			) : null}
			<div ref={bottomRef} />
		</div>
	);
}
