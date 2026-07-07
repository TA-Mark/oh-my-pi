import { useEffect, useState } from "react";
import type { ViewModel } from "../lib/reducer";
import type { EngineStatus } from "../lib/rpc-client";
import type {
	ExtensionUIRequest,
	ExtensionUIResponse,
	LoginProvider,
	ModelInfo,
	SubagentSnapshot,
	ThinkingLevel,
} from "../lib/rpc-protocol";
import { Composer, type ComposerInjection } from "./Composer";
import { DialogHost } from "./DialogHost";
import { LoginMenu } from "./LoginMenu";
import { ModelPicker } from "./ModelPicker";
import { SubagentPanel } from "./SubagentPanel";
import { ThinkingPicker } from "./ThinkingPicker";
import { type Toast, Toasts } from "./Toasts";
import { Transcript } from "./Transcript";

export interface SessionInfo {
	model?: string;
	thinkingLevel?: ThinkingLevel;
	sessionName?: string;
	messageCount: number;
}

interface AppShellProps {
	vm: ViewModel;
	status: EngineStatus;
	statusDetail?: string;
	workspace: string;
	models: ModelInfo[];
	session: SessionInfo;
	subagents: SubagentSnapshot[];
	loginProviders: LoginProvider[];
	dialog: ExtensionUIRequest | null;
	toasts: Toast[];
	injection?: ComposerInjection;
	onSend: (text: string) => void;
	onAbort: () => void;
	onChangeFolder: () => void;
	onSelectModel: (provider: string, id: string) => void;
	onSelectThinking: (level: ThinkingLevel) => void;
	onNewSession: () => void;
	onRenameSession: (name: string) => void;
	onLogin: (providerId: string) => void;
	onDialogRespond: (response: ExtensionUIResponse) => void;
	onDismissToast: (id: string) => void;
}

const STATUS_LABEL: Record<EngineStatus, string> = {
	idle: "Idle",
	starting: "Starting engine…",
	ready: "Ready",
	error: "Error",
	stopped: "Engine stopped",
};

function shortenPath(p: string): string {
	const parts = p.split(/[\\/]/).filter(Boolean);
	return parts.length <= 2 ? p : `…/${parts.slice(-2).join("/")}`;
}

function SessionName({ name, onRename }: { name?: string; onRename: (name: string) => void }) {
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState(name ?? "");
	useEffect(() => {
		setValue(name ?? "");
	}, [name]);

	if (editing) {
		return (
			<input
				className="session-name-input"
				// biome-ignore lint/a11y/noAutofocus: focus on entering edit mode
				autoFocus
				value={value}
				onChange={event => setValue(event.target.value)}
				onBlur={() => {
					setEditing(false);
					const next = value.trim();
					if (next && next !== name) onRename(next);
				}}
				onKeyDown={event => {
					if (event.key === "Enter") event.currentTarget.blur();
					if (event.key === "Escape") {
						setValue(name ?? "");
						setEditing(false);
					}
				}}
			/>
		);
	}
	return (
		<button type="button" className="session-name" title="Rename session" onClick={() => setEditing(true)}>
			{name || "untitled"}
		</button>
	);
}

export function AppShell(props: AppShellProps) {
	const {
		vm,
		status,
		statusDetail,
		workspace,
		models,
		session,
		subagents,
		loginProviders,
		dialog,
		toasts,
		injection,
		onSend,
		onAbort,
		onChangeFolder,
		onSelectModel,
		onSelectThinking,
		onNewSession,
		onRenameSession,
		onLogin,
		onDialogRespond,
		onDismissToast,
	} = props;
	const disabled = status !== "ready";
	return (
		<div className="app-shell">
			<header className="app-header">
				<div className="app-heading">
					<span className="app-title">OMP</span>
					<button type="button" className="workspace-chip" title={workspace} onClick={onChangeFolder}>
						{shortenPath(workspace)}
					</button>
					<SessionName name={session.sessionName} onRename={onRenameSession} />
					{session.messageCount > 0 ? <span className="msg-count">{session.messageCount} msgs</span> : null}
				</div>
				<div className="app-controls">
					<ModelPicker current={session.model} models={models} disabled={disabled} onSelect={onSelectModel} />
					<ThinkingPicker current={session.thinkingLevel} disabled={disabled} onSelect={onSelectThinking} />
					<LoginMenu providers={loginProviders} disabled={disabled} onLogin={onLogin} />
					<button type="button" className="btn btn-ghost" disabled={disabled} onClick={onNewSession}>
						New
					</button>
					<div className={`status status-${status}`}>
						<span className="status-dot" />
						<span className="status-label">{STATUS_LABEL[status]}</span>
					</div>
				</div>
			</header>

			{statusDetail && status === "error" ? <div className="error-banner">{statusDetail}</div> : null}

			<main className="app-main">
				<SubagentPanel subagents={subagents} />
				<Transcript messages={vm.messages} />
			</main>

			{status === "error" && vm.stderr.length > 0 ? (
				<details className="stderr-panel">
					<summary>Engine diagnostics ({vm.stderr.length})</summary>
					<pre>{vm.stderr.join("\n")}</pre>
				</details>
			) : null}

			<footer className="app-footer">
				<Composer disabled={disabled} streaming={vm.streaming} injection={injection} onSend={onSend} onAbort={onAbort} />
			</footer>

			<DialogHost request={dialog} onRespond={onDialogRespond} />
			<Toasts toasts={toasts} onDismiss={onDismissToast} />
		</div>
	);
}
