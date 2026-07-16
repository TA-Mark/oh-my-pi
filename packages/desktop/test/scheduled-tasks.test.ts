import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ScheduledTask, ScheduledTaskStore } from "../electron/scheduled-tasks";

const cleanup: string[] = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map(target => fs.rm(target, { recursive: true, force: true })));
});

async function fixture(): Promise<{ directory: string; file: string; workspace: string }> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-scheduled-test-"));
	const workspace = path.join(directory, "workspace");
	await fs.mkdir(workspace);
	cleanup.push(directory);
	return { directory, file: path.join(directory, "scheduled-tasks.json"), workspace };
}

function input(workspace: string) {
	return {
		name: "Daily review",
		workspace,
		prompt: "Review this workspace",
		intervalMinutes: 60,
		maxRetries: 2,
		enabled: true,
	};
}

describe("ScheduledTaskStore", () => {
	test("migrates persisted tasks and preserves them across restart", async () => {
		const { file, workspace } = await fixture();
		const persisted = [
			{
				id: "legacy",
				...input(workspace),
				maxRetries: undefined,
				nextRunAt: new Date(Date.now() + 60_000).toISOString(),
				runs: [],
			},
		];
		await Bun.write(file, JSON.stringify(persisted));
		const store = new ScheduledTaskStore(
			file,
			() => ({ command: "unused", args: [] }),
			() => undefined,
		);
		await store.load();
		expect(store.list()).toMatchObject([{ id: "legacy", maxRetries: 2 }]);
		await store.upsert({ ...input(workspace), id: "legacy", name: "Updated review" });
		const restarted = new ScheduledTaskStore(
			file,
			() => ({ command: "unused", args: [] }),
			() => undefined,
		);
		await restarted.load();
		expect(restarted.list()[0]?.name).toBe("Updated review");
	});

	test("diagnostics omit task prompts and workspace paths", async () => {
		const { file, workspace } = await fixture();
		const store = new ScheduledTaskStore(
			file,
			() => ({ command: "unused", args: [] }),
			() => undefined,
		);
		await store.load();
		await store.upsert(input(workspace));
		const diagnostics = store.diagnostics();
		expect(diagnostics.taskCount).toBe(1);
		expect(JSON.stringify(diagnostics)).not.toContain(workspace);
		expect(JSON.stringify(diagnostics)).not.toContain("Review this workspace");
	});

	test("rejects a duplicate run while the same task is active", async () => {
		const { file, workspace } = await fixture();
		const gate = Promise.withResolvers<void>();
		const store = new ScheduledTaskStore(
			file,
			() => ({ command: "unused", args: [] }),
			() => undefined,
			{ execute: () => gate.promise },
		);
		await store.load();
		const task = await store.upsert(input(workspace));
		const first = store.runNow(task.id);
		await expect(store.runNow(task.id)).rejects.toThrow("already running");
		gate.resolve();
		await first;
	});

	test("retries with exponential backoff and records final success", async () => {
		const { file, workspace } = await fixture();
		let attempts = 0;
		const delays: number[] = [];
		const store = new ScheduledTaskStore(
			file,
			() => ({ command: "unused", args: [] }),
			() => undefined,
			{
				execute: async () => {
					attempts++;
					if (attempts < 3) throw new Error("temporary failure");
				},
				retryDelay: milliseconds => {
					delays.push(milliseconds);
					return Promise.resolve();
				},
			},
		);
		await store.load();
		const task = await store.upsert(input(workspace));
		await store.runNow(task.id);
		expect(attempts).toBe(3);
		expect(delays).toEqual([1000, 2000]);
		expect(store.list()[0]?.lastStatus).toBe("success");
	});

	test("does not execute when the workspace no longer exists", async () => {
		const { directory, file } = await fixture();
		let executions = 0;
		const missing = path.join(directory, "missing");
		const store = new ScheduledTaskStore(
			file,
			() => ({ command: "unused", args: [] }),
			() => undefined,
			{
				execute: async () => {
					executions++;
				},
			},
		);
		await store.load();
		const task = await store.upsert(input(missing));
		await store.runNow(task.id);
		expect(executions).toBe(0);
		expect(store.list()[0]).toMatchObject({ lastStatus: "failed", lastError: expect.stringContaining("ENOENT") });
	});

	test("runs an overdue task once after restart or resume", async () => {
		const { file, workspace } = await fixture();
		const now = Date.parse("2026-07-16T12:00:00.000Z");
		const task: ScheduledTask = {
			id: "overdue",
			...input(workspace),
			nextRunAt: new Date(now - 60_000).toISOString(),
			runs: [],
		};
		await Bun.write(file, JSON.stringify([task]));
		let executions = 0;
		const store = new ScheduledTaskStore(
			file,
			() => ({ command: "unused", args: [] }),
			() => undefined,
			{
				now: () => now,
				execute: async () => {
					executions++;
				},
			},
		);
		await store.load();
		await store.runDueTasks();
		await store.runDueTasks();
		expect(executions).toBe(1);
		expect(Date.parse(store.list()[0]?.nextRunAt ?? "")).toBeGreaterThan(now);
	});
});
