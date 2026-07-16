// Packaged-app launch smoke test (WebDriver via tauri-driver).
//
// Goal: prove the shipped bundle actually runs. If the Rust bridge, Vite asset
// bundling, or the CSP were broken, the WebView would render a blank page and
// these assertions would fail. We deliberately assert only on shell chrome that
// renders without the engine sidecar, so the test is deterministic offline.

import { browser, expect, $ } from "@wdio/globals";

describe("OMP Desktop — packaged launch", () => {
	it("mounts the React shell", async () => {
		const shell = await $(".app-shell");
		await shell.waitForExist({ timeout: 60_000 });
		await expect(shell).toBeExisting();
	});

	it("renders the primary navigation", async () => {
		const nav = await $('nav[aria-label="Primary"]');
		await nav.waitForExist({ timeout: 30_000 });
		await expect(nav).toBeExisting();
	});

	it("has the expected window title", async () => {
		const title = await browser.getTitle();
		expect(title).toContain("OMP Desktop");
	});

	it("did not render a fatal error boundary", async () => {
		// The React root should hold the shell, not an unhandled-error fallback.
		const root = await $("#root");
		const text = await root.getText();
		expect(text).not.toContain("Something went wrong");
	});
});
