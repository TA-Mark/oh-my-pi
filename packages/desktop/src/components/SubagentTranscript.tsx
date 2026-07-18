import type { ArtifactContent, SessionMessage, SubagentMessagesSnapshot, SubagentSnapshot } from "../lib/rpc-protocol";

interface SubagentTranscriptProps {
	agent: SubagentSnapshot | null;
	result: SubagentMessagesSnapshot | null;
	loading: boolean;
	artifact: ArtifactContent | null;
	artifactLoading: boolean;
	onOpenArtifact: (artifactId: string) => void;
	onClose: () => void;
}

function messageText(message: SessionMessage): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return message.errorMessage ?? "";
	const text = message.content
		.flatMap(part => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
		.join("");
	if (text) return text;
	return JSON.stringify(message.content, null, 2);
}

export function artifactIdsFromMessage(message: SessionMessage): string[] {
	const serialized = JSON.stringify(message);
	const ids = new Set<string>();
	for (const match of serialized.matchAll(/artifact:\/\/([0-9]+)/g)) ids.add(match[1]);
	if (message.details !== null && typeof message.details === "object" && "artifactId" in message.details) {
		const artifactId = message.details.artifactId;
		if (typeof artifactId === "string" && /^\d+$/.test(artifactId)) ids.add(artifactId);
	}
	return [...ids];
}

export function SubagentTranscript({
	agent,
	result,
	loading,
	artifact,
	artifactLoading,
	onOpenArtifact,
	onClose,
}: SubagentTranscriptProps) {
	if (!agent) return null;
	return (
		<div className="subagent-transcript" role="dialog" aria-label={`Subagent transcript: ${agent.agent}`}>
			<div className="subagent-transcript-head">
				<div>
					<strong>{agent.agent}</strong>
					<span>{agent.status}</span>
				</div>
				<button type="button" className="top-icon-button" onClick={onClose} aria-label="Close subagent transcript">
					×
				</button>
			</div>
			{loading ? <div className="settings-empty">Loading transcript…</div> : null}
			{result ? (
				<>
					<div className="subagent-transcript-meta">
						{result.messages.length} messages · byte {result.fromByte}–{result.nextByte}
					</div>
					<div className="subagent-message-list">
						{result.messages.map((message, index) => {
							const artifactIds = artifactIdsFromMessage(message);
							return (
								<div
									className="subagent-message"
									key={`${message.role}-${message.toolCallId ?? index}-${index}`}
								>
									<div className="subagent-message-head">
										<strong>{message.role}</strong>
										{message.toolName ? <code>{message.toolName}</code> : null}
										{message.isError ? <span className="subagent-message-error">error</span> : null}
									</div>
									<pre>{messageText(message) || "(no text content)"}</pre>
									{artifactIds.length > 0 ? (
										<div className="subagent-artifact-actions">
											{artifactIds.map(artifactId => (
												<button type="button" key={artifactId} onClick={() => onOpenArtifact(artifactId)}>
													Preview artifact://{artifactId}
												</button>
											))}
										</div>
									) : null}
								</div>
							);
						})}
					</div>
					{artifactLoading ? <div className="settings-empty">Loading artifact…</div> : null}
					{artifact ? (
						<div className="subagent-artifact-preview">
							<div className="subagent-transcript-meta">
								artifact://{artifact.id} · {artifact.size.toLocaleString()} bytes
								{artifact.truncated ? " · preview truncated" : ""}
							</div>
							<pre>{artifact.content}</pre>
						</div>
					) : null}
				</>
			) : !loading ? (
				<div className="settings-empty">No transcript available.</div>
			) : null}
		</div>
	);
}
