import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionWorkflowActions } from "../src/components/SessionWorkflowActions";
import type { GoalModeState } from "../src/lib/rpc-protocol";

const noop = () => {};

function renderActions(goalMode?: GoalModeState): string {
	return renderToStaticMarkup(
		<SessionWorkflowActions
			disabled={false}
			goalMode={goalMode}
			onBranch={noop}
			onExport={noop}
			onHandoff={noop}
			onCreateGoal={noop}
			onPauseGoal={noop}
			onResumeGoal={noop}
			onDropGoal={noop}
		/>,
	);
}

test("keeps the four primary OMP task workflows visible without an overflow menu", () => {
	const markup = renderActions();

	expect(markup).toContain("Task actions");
	expect(markup).toContain(">Branch<");
	expect(markup).toContain(">Export<");
	expect(markup).toContain(">Handoff<");
	expect(markup).toContain(">Start goal<");
	expect(markup).not.toContain('role="menu"');
});

test("shows goal lifecycle actions and status while a goal is active", () => {
	const markup = renderActions({
		enabled: true,
		mode: "active",
		goal: {
			id: "goal-1",
			objective: "Ship the desktop workflow toolbar",
			status: "active",
			tokensUsed: 120,
			timeUsedSeconds: 30,
			createdAt: 1,
			updatedAt: 2,
		},
	});

	expect(markup).toContain(">Pause goal<");
	expect(markup).toContain(">active<");
	expect(markup).toContain(">Drop<");
});
