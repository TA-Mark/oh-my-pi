import { describe, expect, test } from "bun:test";
import { stageSelectionsForChanges } from "../src/components/ChangesPanel";
import type { WorkspaceFileChange } from "../src/lib/rpc-protocol";

const change = (path: string): WorkspaceFileChange => ({
	path,
	status: "modified",
	diff: "",
	additions: 1,
	deletions: 0,
});

describe("review staging contract", () => {
	test("stages every visible file without mutating the diff input", () => {
		const changes = [change("src/App.tsx"), change("README.md")];
		expect(stageSelectionsForChanges(changes)).toEqual([
			{ path: "src/App.tsx", hunks: { type: "all" } },
			{ path: "README.md", hunks: { type: "all" } },
		]);
		expect(changes.map(item => item.path)).toEqual(["src/App.tsx", "README.md"]);
	});

	test("returns no staging command when the review has no files", () => {
		expect(stageSelectionsForChanges([])).toEqual([]);
	});
});
