import { describe, expect, test } from "bun:test";
import { type CommandAction, filterCommandActions } from "../src/components/CommandPalette";

const action = (id: string, label: string, detail: string): CommandAction => ({
	id,
	label,
	detail,
	icon: (() => null) as unknown as CommandAction["icon"],
	onRun: () => undefined,
});

describe("command palette filtering contract", () => {
	test("matches labels and details case-insensitively while preserving action order", () => {
		const actions = [
			action("review", "Review changes", "Open workspace diff"),
			action("project", "Open project", "Choose a folder"),
		];
		expect(filterCommandActions(actions, "WORKSPACE").map(item => item.id)).toEqual(["review"]);
		expect(filterCommandActions(actions, "folder").map(item => item.id)).toEqual(["project"]);
	});

	test("returns every action for an empty query", () => {
		const actions = [action("a", "A", "first"), action("b", "B", "second")];
		expect(filterCommandActions(actions, "   ")).toEqual(actions);
	});
});
