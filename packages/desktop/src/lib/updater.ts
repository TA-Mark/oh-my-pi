/**
 * Auto-update bridge over `@tauri-apps/plugin-updater`. The engine sidecar is
 * bundled inside the installer, so an app update also replaces the engine — no
 * separate engine update path is needed.
 *
 * Flow: check() → if an update exists, downloadAndInstall() streams it, then the
 * process plugin relaunches into the new version. All of this is gated on the
 * updater plugin being present (desktop builds only); in dev / web it no-ops.
 */
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

export interface UpdateInfo {
	version: string;
	currentVersion: string;
	notes?: string;
}

/** Check for an available update. Returns null when up to date or when the check fails. */
export async function checkForUpdate(): Promise<{ info: UpdateInfo; update: Update } | null> {
	try {
		const update = await check();
		if (!update) return null;
		return {
			update,
			info: { version: update.version, currentVersion: update.currentVersion, notes: update.body },
		};
	} catch {
		// Offline, no endpoint, or dev build without the plugin — treat as "no update".
		return null;
	}
}

/**
 * Download + install the update (streaming progress via onProgress), then relaunch
 * into the new version. Throws if the download or install fails so the caller can
 * surface the error and leave the current version running.
 */
export async function installUpdate(update: Update, onProgress?: (fraction: number) => void): Promise<void> {
	let downloaded = 0;
	let total = 0;
	await update.downloadAndInstall(event => {
		if (event.event === "Started") {
			total = event.data.contentLength ?? 0;
		} else if (event.event === "Progress") {
			downloaded += event.data.chunkLength;
			if (total > 0 && onProgress) onProgress(Math.min(1, downloaded / total));
		} else if (event.event === "Finished") {
			onProgress?.(1);
		}
	});
	await relaunch();
}
