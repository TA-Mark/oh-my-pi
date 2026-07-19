import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PinnedSummary } from "../src/components/PinnedSummary";

const noop = () => {};

function renderSummary(): string {
	return renderToStaticMarkup(
		<PinnedSummary
			workspace={"C:\\Users\\mark-MJ\\Documents\\Api-Go"}
			projectName="Api-Go"
			gitStatus={{
				branch: "feature/router",
				upstream: "origin/feature/router",
				baseBranch: "main",
				branches: ["feature/router", "main"],
				localBranches: ["feature/router", "main"],
				staged: 2,
				unstaged: 3,
				untracked: 1,
			}}
			changes={[]}
			status="ready"
			vm={{
				streaming: true,
				messages: [
					{
						id: "tool-1",
						role: "tool",
						text: "",
						toolName: "bash",
						toolRunning: true,
					},
				],
			}}
			subagents={[]}
			scheduledTasks={[]}
			sideChatReady={false}
			sideChatBusy={false}
			contextItems={[{ id: "file-1", kind: "file", path: "proxy/handler.go" }]}
			contextImages={[]}
			contextSkills={["go-review"]}
			contextMemoryBackend={null}
			sessionModel="openai/gpt-5"
			sessionName="Router task"
			sessionMessageCount={12}
			onCopy={noop}
			onOpenContext={noop}
			onOpenTerminal={noop}
			onCommit={noop}
			onPush={noop}
			onClose={noop}
		/>,
	);
}

test("pinned summary exposes environment, running tools, and attached sources", () => {
	const markup = renderSummary();

	expect(markup).toContain("Workspace summary");
	expect(markup).toContain("C:\\Users\\mark-MJ\\Documents\\Api-Go");
	expect(markup).toContain("feature/router");
	expect(markup).toContain("bash");
	expect(markup).toContain("proxy/handler.go");
	expect(markup).toContain("go-review");
	expect(markup).toContain("Sources · 2");
	expect(markup).toContain(">Commit<");
});

test("pinned summary communicates when no background process or source is active", () => {
	const markup = renderToStaticMarkup(
		<PinnedSummary
			workspace="/tmp/project"
			projectName="project"
			gitStatus={{
				branch: null,
				upstream: null,
				baseBranch: null,
				branches: [],
				localBranches: [],
				staged: 0,
				unstaged: 0,
				untracked: 0,
			}}
			changes={[]}
			status="idle"
			vm={{ messages: [], streaming: false }}
			subagents={[]}
			scheduledTasks={[]}
			sideChatReady={false}
			sideChatBusy={false}
			contextItems={[]}
			contextImages={[]}
			contextSkills={[]}
			contextMemoryBackend={null}
			sessionMessageCount={0}
			onCopy={noop}
			onOpenContext={noop}
			onOpenTerminal={noop}
			onCommit={noop}
			onPush={noop}
			onClose={noop}
		/>,
	);

	expect(markup).toContain("No background processes.");
	expect(markup).toContain("No sources attached.");
	expect(markup).toContain("No Git branch");
});
