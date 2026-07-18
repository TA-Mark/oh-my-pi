/**
 * Tool renderer registry. Keys are current wire tool names; aliases keep old
 * transcript names renderable. Unknown tools fall back to the generic JSON renderer.
 */
import { genericRenderer } from "./generic";
import { askRenderer } from "./tools/ask";
import { astEditRenderer } from "./tools/ast-edit";
import { astGrepRenderer } from "./tools/ast-grep";
import { bashRenderer } from "./tools/bash";
import { browserRenderer } from "./tools/browser";
import { checkpointRenderer, rewindRenderer } from "./tools/checkpoint";
import { debugRenderer } from "./tools/debug";
import { editRenderer } from "./tools/edit";
import { evalRenderer } from "./tools/eval";
import { fetchRenderer } from "./tools/fetch";
import { generateImageRenderer } from "./tools/generate-image";
import { githubRenderer } from "./tools/github";
import { globRenderer } from "./tools/glob";
import { goalRenderer } from "./tools/goal";
import { grepRenderer } from "./tools/grep";
import { hubRenderer } from "./tools/hub";
import { inspectImageRenderer } from "./tools/inspect-image";
import { learnRenderer } from "./tools/learn";
import { lspRenderer } from "./tools/lsp";
import { manageSkillRenderer } from "./tools/manage-skill";
import { memoryEditRenderer } from "./tools/memory-edit";
import { recallRenderer } from "./tools/memory-recall";
import { reflectRenderer } from "./tools/memory-reflect";
import { retainRenderer } from "./tools/memory-retain";
import { readRenderer } from "./tools/read";
import { reportToolIssueRenderer } from "./tools/report-tool-issue";
import { resolveRenderer } from "./tools/resolve";
import { taskRenderer } from "./tools/task";
import { todoRenderer } from "./tools/todo";
import { webSearchRenderer } from "./tools/web-search";
import { writeRenderer } from "./tools/write";
import { yieldRenderer } from "./tools/yield";
import type { ToolRenderer } from "./types";

const RENDERERS: Record<string, ToolRenderer> = {
	ask: askRenderer,
	ast_edit: astEditRenderer,
	ast_grep: astGrepRenderer,
	bash: bashRenderer,
	browser: browserRenderer,
	puppeteer: browserRenderer,
	checkpoint: checkpointRenderer,
	debug: debugRenderer,
	edit: editRenderer,
	apply_patch: editRenderer,
	eval: evalRenderer,
	js: evalRenderer,
	python: evalRenderer,
	notebook: evalRenderer,
	fetch: fetchRenderer,
	glob: globRenderer,
	find: globRenderer,
	generate_image: generateImageRenderer,
	github: githubRenderer,
	goal: goalRenderer,
	inspect_image: inspectImageRenderer,
	learn: learnRenderer,
	hub: hubRenderer,
	lsp: lspRenderer,
	manage_skill: manageSkillRenderer,
	memory_edit: memoryEditRenderer,
	recall: recallRenderer,
	reflect: reflectRenderer,
	retain: retainRenderer,
	read: readRenderer,
	rewind: rewindRenderer,
	report_tool_issue: reportToolIssueRenderer,
	resolve: resolveRenderer,
	grep: grepRenderer,
	search: grepRenderer,
	task: taskRenderer,
	todo: todoRenderer,
	web_search: webSearchRenderer,
	write: writeRenderer,
	yield: yieldRenderer,
};

export function resolveToolRenderer(name: string): ToolRenderer {
	return RENDERERS[name] ?? genericRenderer;
}
