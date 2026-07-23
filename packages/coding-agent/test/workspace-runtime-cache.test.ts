import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalWorkspace, RpcWorkspaceRuntimeCache } from "../src/modes/rpc/workspace-runtime-cache";

describe("RPC workspace runtime cache", () => {
	test("canonical paths collapse equivalent workspace spellings", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-workspace-key-"));
		try {
			const workspace = path.join(root, "workspace");
			await fs.mkdir(workspace);
			const direct = await canonicalWorkspace(workspace);
			const equivalent = await canonicalWorkspace(path.join(root, ".", "workspace", "..", "workspace"));
			expect(equivalent).toEqual(direct);
		} finally {
			await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});

	test("recent access protects a runtime from bounded LRU eviction", () => {
		const cache = new RpcWorkspaceRuntimeCache<string>(3);
		expect(cache.set("a", "runtime-a")).toEqual([]);
		expect(cache.set("b", "runtime-b")).toEqual([]);
		expect(cache.set("c", "runtime-c")).toEqual([]);
		expect(cache.get("a")).toBe("runtime-a");
		expect(cache.set("d", "runtime-d")).toEqual(["runtime-b"]);
		expect(cache.values()).toEqual(["runtime-c", "runtime-a", "runtime-d"]);
	});
});
