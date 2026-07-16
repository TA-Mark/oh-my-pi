/** Electron updater hook. Configure electron-updater when a release endpoint is available. */
export interface UpdateInfo {
	version: string;
	currentVersion: string;
	notes?: string;
}
export interface UpdateHandle {
	version: string;
}

export async function checkForUpdate(): Promise<{ info: UpdateInfo; update: UpdateHandle } | null> {
	return null;
}

export async function installUpdate(_update: UpdateHandle, _onProgress?: (fraction: number) => void): Promise<void> {
	throw new Error("Electron auto-update is not configured yet");
}
