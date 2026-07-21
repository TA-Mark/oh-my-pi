import { expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { LocalDialogHost, type LocalDialogResult } from "../src/components/DialogHost";
import { SideChatPanel } from "../src/components/SideChatPanel";
import { WorktreeManager } from "../src/components/WorktreeManager";
import { ChangesPanel } from "../src/components/ChangesPanel";
import { DiagnosticsPanel } from "../src/components/DiagnosticsPanel";
import type { ReviewScope, WorkspaceFileChange } from "../src/lib/rpc-protocol";


function installDom(): { container: Element; restore: () => void } {
	const domWindow = new HappyWindow({ url: "http://localhost" });
	const IntersectionObserverStub = class {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
		takeRecords(): IntersectionObserverEntry[] {
			return [];
		}
	};

	const globals: Record<string, unknown> = {
		window: domWindow,
		document: domWindow.document,
		navigator: domWindow.navigator,
		HTMLElement: domWindow.HTMLElement,
		Event: domWindow.Event,
		KeyboardEvent: domWindow.KeyboardEvent,
		MouseEvent: domWindow.MouseEvent,
		IntersectionObserver: IntersectionObserverStub,
	};
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries(globals)) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const container = domWindow.document.createElement("div");
	domWindow.document.body.append(container);
	return {
		container: container as unknown as Element,
		restore: () => {
			for (const [key, descriptor] of previous) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else Reflect.deleteProperty(globalThis, key);
			}
		},
	};
}

const noop = () => {};
function makeChange(
	path: string,
	status: WorkspaceFileChange["status"],
	additions: number,
	deletions: number,
): WorkspaceFileChange {
	return { path, status, diff: "", additions, deletions };
}

async function waitForText(container: Element, text: string): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt++) {
		if (container.textContent?.includes(text)) return;
		await act(async () => {
			await Promise.resolve();
		});
	}
	throw new Error(`Timed out waiting for ${text}`);
}

test("diagnostics panel renders recent session timeline", () => {
	const markup = renderToStaticMarkup(
		<DiagnosticsPanel
			open={true}
			snapshot={null}
			sessionStats={null}
			timeline={[
				{
					id: "e1",
					at: Date.UTC(2026, 0, 1, 12, 0, 0),
					type: "tool_execution_end",
					label: "Tool failed: bash",
					tone: "error",
					detail: "failed",
				},
			]}
			loading={false}
			onRefresh={noop}
			onExport={noop}
			onClose={noop}
		/>,
	);

	expect(markup).toContain("Session timeline");
	expect(markup).toContain("Tool failed: bash");
	expect(markup).toContain("failed");
});

test("changes panel splits staged and unstaged changes", async () => {
	const { container, restore } = installDom();
	const root = createRoot(container);
	const unstaged = makeChange("src/unstaged.ts", "modified", 1, 0);
	const staged = makeChange("src/staged.ts", "modified", 0, 2);
	const loadCalls: ReviewScope[] = [];
	try {
		await act(async () => {
			root.render(
				<ChangesPanel
					changes={[unstaged, staged]}
					workspaceEntries={[]}
					workspaceFilesLoading={false}
					workspaceFilesTruncated={false}
					onRefreshWorkspaceFiles={noop}
					gitStatus={{
						branch: "main",
						upstream: "origin/main",
						baseBranch: "main",
						branches: ["main"],
						localBranches: ["main"],
						staged: 1,
						unstaged: 1,
						untracked: 0,
					}}
					onRefresh={noop}
					onLoadReview={async scope => {
						loadCalls.push(scope);
						return scope === "unstaged" ? [unstaged] : [staged];
					}}
					onLoadReviewCommits={async () => []}
					onStageHunks={noop}
					onUnstage={noop}
					onRevertFiles={noop}
					onCommit={noop}
					onPush={noop}
					onCreatePullRequest={noop}
					disabled={false}
				/>,
			);
			await Promise.resolve();
			await Promise.resolve();
		});
		await waitForText(container, "src/unstaged.ts");
		expect(loadCalls).toEqual(["unstaged", "staged"]);
		expect(container.textContent).toContain("Unstaged");
		expect(container.textContent).toContain("Staged");
		expect(container.textContent).toContain("Stage all");
		expect(container.textContent).toContain("Unstage all");
		expect(container.textContent).toContain("src/unstaged.ts");
		expect(container.textContent).toContain("src/staged.ts");
	} finally {
		await act(async () => root.unmount());
		restore();
	}
});


test("local confirm dialog resolves through rendered controls", async () => {
	const { container, restore } = installDom();
	const root = createRoot(container);
	let result: LocalDialogResult | undefined;
	try {
		await act(async () =>
			root.render(
				<LocalDialogHost
					request={{
						id: "confirm-1",
						kind: "confirm",
						title: "Drop goal",
						message: "Drop the current goal?",
						confirmLabel: "Drop",
						danger: true,
					}}
					onRespond={next => (result = next)}
				/>,
			),
		);
		const button = Array.from(container.querySelectorAll("button")).find(item => item.textContent === "Drop");
		expect(button).toBeDefined();
		await act(async () => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(result).toEqual({ confirmed: true });
	} finally {
		await act(async () => root.unmount());
		restore();
	}
});

test("local prompt dialog submits the edited value", async () => {
	const { container, restore } = installDom();
	const root = createRoot(container);
	let result: LocalDialogResult | undefined;
	try {
		await act(async () =>
			root.render(
				<LocalDialogHost
					request={{
						id: "prompt-1",
						kind: "prompt",
						title: "Rename chat",
						initialValue: "Current name",
						confirmLabel: "Rename",
					}}
					onRespond={next => (result = next)}
				/>,
			),
		);
		const button = Array.from(container.querySelectorAll("button")).find(item => item.textContent === "Rename");
		expect(button).toBeDefined();
		await act(async () => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(result).toEqual({ confirmed: true, value: "Current name" });
	} finally {
		await act(async () => root.unmount());
		restore();
	}
});

test("local select dialog resolves the chosen option", async () => {
	const { container, restore } = installDom();
	const root = createRoot(container);
	let result: LocalDialogResult | undefined;
	try {
		await act(async () =>
			root.render(
				<LocalDialogHost
					request={{
						id: "select-1",
						kind: "select",
						title: "Branch session",
						message: "Choose the user message to branch from.",
						options: ["1. Investigate the cache", "2. Fix the retry loop"],
					}}
					onRespond={next => (result = next)}
				/>,
			),
		);
		const buttons = Array.from(container.querySelectorAll("button"));
		expect(buttons.map(button => button.textContent)).toContain("2. Fix the retry loop");
		const button = buttons.find(item => item.textContent === "2. Fix the retry loop");
		expect(button).toBeDefined();
		await act(async () => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(result).toEqual({ confirmed: true, selectedIndex: 1 });
	} finally {
		await act(async () => root.unmount());
		restore();
	}
});

test("local branch picker resolves the chosen entry id", async () => {
	const { container, restore } = installDom();
	const root = createRoot(container);
	let result: LocalDialogResult | undefined;
	try {
		await act(async () =>
			root.render(
				<LocalDialogHost
					request={{
						id: "branch-1",
						kind: "branch",
						title: "Branch session",
						message: "Choose the user message to branch from.",
						items: [
							{ entryId: "msg-1", text: "1. Investigate the cache" },
							{ entryId: "msg-2", text: "2. Fix the retry loop" },
						],
					}}
					onRespond={next => (result = next)}
				/>,
			),
		);
		const input = container.querySelector("input");
		expect(input).toBeDefined();
		const buttons = Array.from(container.querySelectorAll("button"));
		expect(buttons.map(button => button.textContent)).toContain("2. Fix the retry loop");
		const button = buttons.find(item => item.textContent === "2. Fix the retry loop");
		expect(button).toBeDefined();
		await act(async () => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(result).toEqual({ confirmed: true, value: "msg-2" });
	} finally {
		await act(async () => root.unmount());
		restore();
	}
});

test("side chat renders its isolated context inspector", () => {
	const markup = renderToStaticMarkup(
		<SideChatPanel
			ready={true}
			starting={false}
			busy={false}
			messages={[]}
			onEnsure={noop}
			onStop={noop}
			onFork={noop}
			onAddResult={noop}
			worktreePath={null}
			models={[]}
			providers={[]}
			model={undefined}
			contextUsage={{ tokens: 5000, contextWindow: 20000, percent: 25 }}
			contextBreakdown={{
				contextWindow: 20000,
				anchored: false,
				usedTokens: 5000,
				systemPromptTokens: 1000,
				systemToolsTokens: 1200,
				systemContextTokens: 300,
				skillsTokens: 500,
				messagesTokens: 2000,
			}}
			contextSkills={["side-review"]}
			contextMemoryBackend="local"
			onSelectModel={noop}
			onToggleWorktree={noop}
			onSend={noop}
			onClose={noop}
		/>,
	);

	expect(markup).toContain("Context inspector");
	expect(markup).toContain("5,000 / 20,000 tokens");
	expect(markup).toContain("System prompt");
	expect(markup).toContain("Memory: local");
	expect(markup).toContain("Skills: side-review");
});

test("worktree manager uses explicit action labels", () => {
	const markup = renderToStaticMarkup(
		<WorktreeManager
			open={true}
			workspace="C:\\repo"
			worktrees={[{ path: "C:\\repo", branch: "main", detached: false, head: "abc123" }]}
			loading={false}
			mutatingPath={null}
			onClose={noop}
			onRefresh={noop}
			onCreate={noop}
			onOpen={noop}
			onRemove={noop}
		/>,
	);

	expect(markup).toContain("Create worktree");
	expect(markup).toContain("Open worktree");
	expect(markup).toContain("Remove worktree");
	expect(markup).toContain("Force remove worktree");
});
