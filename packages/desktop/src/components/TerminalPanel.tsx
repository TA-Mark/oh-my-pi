import { Play, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import type { BashResult } from "../lib/rpc-protocol";

interface TerminalEntry {
	id: string;
	command: string;
	result?: BashResult;
	error?: string;
}

interface TerminalPanelProps {
	disabled: boolean;
	onRun: (command: string) => Promise<BashResult>;
	onAbort: () => Promise<void>;
}

export function TerminalPanel({ disabled, onRun, onAbort }: TerminalPanelProps) {
	const [command, setCommand] = useState("");
	const [entries, setEntries] = useState<TerminalEntry[]>([]);
	const [running, setRunning] = useState(false);

	const execute = async (): Promise<void> => {
		const value = command.trim();
		if (!value || disabled || running) return;
		const id = `terminal-${Date.now()}`;
		setEntries(current => [...current, { id, command: value }]);
		setCommand("");
		setRunning(true);
		try {
			const result = await onRun(value);
			setEntries(current => current.map(entry => (entry.id === id ? { ...entry, result } : entry)));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setEntries(current => current.map(entry => (entry.id === id ? { ...entry, error: message } : entry)));
		} finally {
			setRunning(false);
		}
	};

	return (
		<div className="terminal-panel">
			<div className="terminal-output" aria-live="polite">
				{entries.length === 0 ? <p>Run a command in the active OMP workspace.</p> : null}
				{entries.map(entry => (
					<article className="terminal-entry" key={entry.id}>
						<div className="terminal-command">$ {entry.command}</div>
						{entry.result ? (
							<>
								<pre>{entry.result.output || "(no output)"}</pre>
								<footer>
									exit {entry.result.exitCode ?? "unknown"}
									{entry.result.cancelled ? " · cancelled" : ""}
									{entry.result.truncated ? " · truncated" : ""}
								</footer>
							</>
						) : entry.error ? (
							<pre className="terminal-error">{entry.error}</pre>
						) : (
							<pre>Running…</pre>
						)}
					</article>
				))}
			</div>
			<form
				className="terminal-input"
				onSubmit={event => {
					event.preventDefault();
					void execute();
				}}
			>
				<input
					value={command}
					disabled={disabled || running}
					onChange={event => setCommand(event.currentTarget.value)}
					placeholder="Enter a shell command"
				/>
				{running ? (
					<button type="button" onClick={() => void onAbort()} title="Stop command">
						<Square size={14} /> Stop
					</button>
				) : (
					<button type="submit" disabled={disabled || !command.trim()}>
						<Play size={14} /> Run
					</button>
				)}
				<button type="button" disabled={running || entries.length === 0} onClick={() => setEntries([])}>
					<Trash2 size={14} /> Clear
				</button>
			</form>
		</div>
	);
}
