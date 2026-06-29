/**
 * Shared interface implemented by both {@link GuestClient} (collab/relay) and
 * {@link RpcClient} (omp child via desktop-bridge). MainChatPage + ChatComposer
 * depend on this surface only, so the underlying transport is interchangeable.
 */

import type { GuestSnapshot } from "./client";
import type { AvailableModel, LoginProvider } from "./rpc-client";

export type DialogResponsePayload =
	| { value: string }
	| { confirmed: boolean }
	| { cancelled: true; timedOut?: boolean };

export interface ChatClient {
	subscribe(listener: () => void): () => void;
	getSnapshot(): GuestSnapshot;
	sendPrompt(text: string): void;
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
	connect(): void;
	close(): void;
}
