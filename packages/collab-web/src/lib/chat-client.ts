/**
 * Shared interface implemented by both {@link GuestClient} (collab/relay) and
 * {@link RpcClient} (omp child via desktop-bridge). MainChatPage + ChatComposer
 * depend on this surface only, so the underlying transport is interchangeable.
 */

import type { ImageContent } from "@oh-my-pi/pi-wire";
import type { GuestSnapshot } from "./client";
import type {
	AvailableModel,
	DialogResponse,
	FollowUpMode,
	InterruptMode,
	LoginProvider,
	SessionStats,
	SteeringMode,
} from "./rpc-client";

export type DialogResponsePayload =
	| { value: string }
	| { confirmed: boolean }
	| { cancelled: true; timedOut?: boolean };

export interface ChatClient {
	subscribe(listener: () => void): () => void;
	getSnapshot(): GuestSnapshot;
	sendPrompt(text: string, images?: ImageContent[]): void;
	sendAbort(): void;
	sendRegenerate?(): void;
	/** Optional — only RpcClient forwards runtime controls to the agent. */
	sendSetModel?(provider: string, modelId: string): void;
	/** Levels: "off" | "minimal" | "low" | "medium" | "high" | "max" | "inherit". */
	sendSetThinkingLevel?(level: string): void;
	/** Optional — only RpcClient supports extension UI dialogs. */
	respondToDialog?(payload: DialogResponsePayload): void;
	/** Optional — only RpcClient supports set_editor_text. */
	registerEditorTextSetter?(fn: ((text: string) => void) | null): void;
	/** Optional — RpcClient-only: fetch provider/model lists for settings UIs. */
	sendGetLoginProviders?(): Promise<LoginProvider[]>;
	sendLogin?(providerId: string): void;
	sendGetAvailableModels?(): Promise<AvailableModel[]>;
	sendCycleModel?(): void;
	sendCycleThinkingLevel?(): void;
	/** Session control — RpcClient-only. */
	sendSteer?(text: string): void;
	sendFollowUp?(text: string): void;
	sendGetSessionStats?(): Promise<SessionStats>;
	sendCompact?(customInstructions?: string): void;
	sendSetAutoCompaction?(enabled: boolean): void;
	sendSetAutoRetry?(enabled: boolean): void;
	sendAbortRetry?(): void;
	sendSetSessionName?(name: string): void;
	sendExportHtml?(outputPath?: string): Promise<{ path: string }>;
	sendSetSteeringMode?(mode: SteeringMode): void;
	sendSetFollowUpMode?(mode: FollowUpMode): void;
	sendSetInterruptMode?(mode: InterruptMode): void;
	sendBash?(command: string): Promise<{ output?: string; exitCode?: number }>;
	sendBashStreaming?(command: string, hidden: boolean, onChunk: (chunk: string) => void): Promise<{ exitCode: number | null; cancelled: boolean }>;
	sendHandoff?(customInstructions?: string): void;
	sendGetBranchMessages?(): Promise<Array<{ entryId: string; text: string }>>;
	sendBranch?(entryId: string): void;
	/** Plan-mode state is owned by the desktop bridge (no wire event); slash-intercept
	 *  mirrors the result into sessionExtras so the UI banner reacts without polling. */
	setLocalPlanMode?(active: boolean, objective: string | null): void;
	showSyntheticDialog?(dialog: import("./client").PendingDialog, onRespond: (payload: DialogResponse) => void): void;
	connect(): void;
	close(): void;
}
