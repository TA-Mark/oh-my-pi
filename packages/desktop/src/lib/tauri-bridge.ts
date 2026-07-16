/**
 * Thin wrapper over Tauri IPC for the RPC bridge.
 *
 * The Rust side (src-tauri/src/rpc.rs) owns the engine process and exposes:
 *   - commands: `start_engine`, `send_rpc`, `stop_engine`
 *   - events:   `rpc://frame`, `rpc://stderr`, `rpc://exit`
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

/** Prompt the user to pick a workspace directory. Returns null if cancelled. */
export async function pickWorkspaceFolder(): Promise<string | null> {
	const selected = await open({ directory: true, multiple: false, title: "Open workspace folder" });
	return typeof selected === "string" ? selected : null;
}

/** Open a URL in the system browser (OAuth, external links). */
export async function openExternalUrl(url: string): Promise<void> {
	await openUrl(url);
}

export const FRAME_EVENT = "rpc://frame";
export const STDERR_EVENT = "rpc://stderr";
export const EXIT_EVENT = "rpc://exit";

export function startEngine(cwd?: string): Promise<void> {
	return invoke("start_engine", { args: { cwd: cwd ?? null } });
}

export function stopEngine(): Promise<void> {
	return invoke("stop_engine");
}

export function sendRpcLine(line: string): Promise<void> {
	return invoke("send_rpc", { line });
}

export function onRpcFrame(cb: (line: string) => void): Promise<UnlistenFn> {
	return listen<string>(FRAME_EVENT, event => cb(event.payload));
}

export function onRpcStderr(cb: (line: string) => void): Promise<UnlistenFn> {
	return listen<string>(STDERR_EVENT, event => cb(event.payload));
}

export function onEngineExit(cb: () => void): Promise<UnlistenFn> {
	return listen(EXIT_EVENT, () => cb());
}
