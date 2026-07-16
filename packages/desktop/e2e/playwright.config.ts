import { defineConfig } from "@playwright/test";
import * as path from "node:path";

export default defineConfig({
	testDir: path.join(import.meta.dirname, "specs"),
	testMatch: "**/*.e2e.ts",
	timeout: 60_000,
	workers: 1,
	retries: 0,
	reporter: "line",
});
