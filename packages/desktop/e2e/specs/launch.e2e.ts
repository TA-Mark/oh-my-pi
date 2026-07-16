import { _electron as electron, expect, test } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

test("mounts the renderer and exposes only the preload bridge", async () => {
	const userData = await fs.mkdtemp(path.join(os.tmpdir(), "omp-electron-e2e-"));
	const application = await electron.launch({ args: [".", `--user-data-dir=${userData}`], cwd: path.resolve(import.meta.dirname, "../..") });
	try {
		const page = await application.firstWindow();
		await expect(page.locator("#root")).toContainText("Choose a project");
		await expect(page).toHaveTitle(/^OMP$/);
		const surface = await page.evaluate(() => ({
			desktop: typeof window.desktop,
			writeClipboardText: typeof window.desktop.writeClipboardText,
			collectDiagnostics: typeof window.desktop.collectDiagnostics,
			listScheduledTasks: typeof window.desktop.listScheduledTasks,
			require: typeof Reflect.get(window, "require"),
			process: typeof Reflect.get(window, "process"),
		}));
		expect(surface).toEqual({ desktop: "object", writeClipboardText: "function", collectDiagnostics: "function", listScheduledTasks: "function", require: "undefined", process: "undefined" });
		const diagnostics = await page.evaluate(() => window.desktop.collectDiagnostics());
		expect(diagnostics).toMatchObject({ platform: expect.any(String), engineRunning: false });
		expect(typeof diagnostics.logTail).toBe("string");
	} finally {
		await application.close();
		await fs.rm(userData, { recursive: true, force: true });
	}
});

test("persists scheduled tasks across an Electron restart", async () => {
	const userData = await fs.mkdtemp(path.join(os.tmpdir(), "omp-electron-scheduled-"));
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "omp-electron-scheduled-workspace-"));
	let application = await electron.launch({ args: [".", `--user-data-dir=${userData}`], cwd: path.resolve(import.meta.dirname, "../..") });
	try {
		let page = await application.firstWindow();
		const created = await page.evaluate(async cwd => window.desktop.upsertScheduledTask({
			name: "Restart recovery",
			workspace: cwd,
			prompt: "Inspect the workspace",
			intervalMinutes: 60,
			maxRetries: 2,
			enabled: false,
		}), workspace) as { id: string };
		expect(created.id).toMatch(/^task_/);
		await application.close();
		application = await electron.launch({ args: [".", `--user-data-dir=${userData}`], cwd: path.resolve(import.meta.dirname, "../..") });
		page = await application.firstWindow();
		const restored = await page.evaluate(() => window.desktop.listScheduledTasks()) as Array<{ id: string; name: string; enabled: boolean }>;
		expect(restored).toEqual([expect.objectContaining({ id: created.id, name: "Restart recovery", enabled: false })]);
	} finally {
		await application.close();
		await Promise.all([fs.rm(userData, { recursive: true, force: true }), fs.rm(workspace, { recursive: true, force: true })]);
	}
});

test("starts the real engine and completes an RPC request through Electron IPC", async () => {
	const userData = await fs.mkdtemp(path.join(os.tmpdir(), "omp-electron-rpc-"));
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "omp-electron-workspace-"));
	const application = await electron.launch({ args: [".", `--user-data-dir=${userData}`], cwd: path.resolve(import.meta.dirname, "../..") });
	try {
		const page = await application.firstWindow();
		const response = await page.evaluate(async cwd => {
			const requestId = "electron-e2e-get-state";
			const result = new Promise<Record<string, unknown>>((resolve, reject) => {
				const timeout = window.setTimeout(() => reject(new Error("timeout waiting for engine RPC response")), 30_000);
				const unlisten = window.desktop.onRpcFrame(line => {
					const frame = JSON.parse(line) as Record<string, unknown>;
					if (frame.type === "ready") void window.desktop.sendRpcLine(JSON.stringify({ type: "get_state", id: requestId }));
					if (frame.type === "response" && frame.id === requestId) {
						window.clearTimeout(timeout);
						unlisten();
						resolve(frame);
					}
				});
			});
			await window.desktop.startEngine(cwd);
			return result;
		}, workspace);
		expect(response).toMatchObject({ type: "response", id: "electron-e2e-get-state", success: true });
		await page.evaluate(() => window.desktop.stopEngine());
	} finally {
		await application.close();
		await Promise.all([
			fs.rm(userData, { recursive: true, force: true }),
			fs.rm(workspace, { recursive: true, force: true }),
		]);
	}
});

test("keeps Codex-style shell controls connected to layout state", async () => {
	const userData = await fs.mkdtemp(path.join(os.tmpdir(), "omp-electron-shell-"));
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "omp-electron-shell-workspace-"));
	const application = await electron.launch({ args: [".", `--user-data-dir=${userData}`], cwd: path.resolve(import.meta.dirname, "../..") });
	try {
		const page = await application.firstWindow();
		await page.evaluate(cwd => window.localStorage.setItem("omp.desktop.lastWorkspace", cwd), workspace);
		await page.reload();
		await expect(page.locator('nav[aria-label="Primary"]')).toBeVisible();
		await expect(page.locator(".composer-input")).toBeEnabled({ timeout: 30_000 });
		await page.locator(".composer-profile-anchor > button").click();
		await expect(page.getByRole("button", { name: /Use next model/ })).toBeVisible();
		await page.getByRole("button", { name: "Close model summary" }).click();
		await page.locator(".composer-input").fill("/context");
		await page.getByRole("button", { name: "Send" }).click();
		await expect(page.locator(".bubble-system")).toContainText(/context/i, { timeout: 30_000 });
		await page.getByRole("button", { name: "Focus mode" }).click();
		await expect(page.locator(".app-shell--focus .app-sidebar")).toBeHidden();
		await page.getByRole("button", { name: "Focus mode" }).click();
		await expect(page.locator(".app-sidebar")).toBeVisible();
		await page.getByRole("button", { name: "Scheduled" }).click();
		await expect(page.locator(".sidebar-feature-empty")).toContainText("Scheduled tasks");
		await page.keyboard.press("Control+KeyK");
		await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
		await page.locator(".command-palette-search input").fill("Review changes");
		await page.getByRole("button", { name: /Review changes/ }).click();
		await expect(page.locator(".workspace-tools-panel--review")).toBeVisible();
		await page.getByRole("button", { name: "Toggle bottom panel" }).first().click();
		await expect(page.locator(".workspace-tools-panel")).toBeHidden();
		await page.getByRole("button", { name: "Toggle bottom panel" }).first().click();
		await page.getByRole("button", { name: "Terminal", exact: true }).click();
		await page.getByPlaceholder("Command").fill("echo electron-terminal-smoke");
		await page.getByRole("button", { name: "Run", exact: true }).click();
		await expect(page.locator(".tools-terminal-output")).toContainText("electron-terminal-smoke", { timeout: 30_000 });
		await expect(page.locator(".tools-terminal-output")).toContainText("[exit 0]");
		await page.getByRole("button", { name: "All tools" }).click();
		await page.getByRole("button", { name: "Session", exact: true }).click();
		await expect(page.locator(".session-controls")).toContainText("Session usage");
		await page.getByRole("button", { name: "Refresh", exact: true }).click();
		await expect(page.locator(".session-stats-grid")).toBeVisible({ timeout: 30_000 });
		await expect(page.getByRole("button", { name: "Copy last response" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Export HTML" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Handoff" })).toBeVisible();
		await expect(page.getByText("Agent controls", { exact: true })).toBeVisible();
		await expect(page.locator(".agent-controls select")).toHaveCount(3);
		await page.keyboard.press("Control+KeyK");
		await page.locator(".command-palette-search input").fill("Open settings");
		await page.getByRole("button", { name: /Open settings/ }).click();
		await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
		await expect(page.getByRole("navigation", { name: "Configuration categories" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Providers", exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "Compaction", exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "Copy diagnostics" })).toBeVisible();
		await page.getByRole("dialog", { name: "Settings" }).getByLabel("Close settings").click();
		await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();
	} finally {
		await application.close();
		await Promise.all([
			fs.rm(userData, { recursive: true, force: true }),
			fs.rm(workspace, { recursive: true, force: true }),
		]);
	}
});
