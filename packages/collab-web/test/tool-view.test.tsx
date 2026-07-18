import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolView } from "../src/tool-render/ToolView";

describe("ToolView xd:// dispatches", () => {
	it("renders successful execute-mode xdev writes as the inner generate_image tool", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="write"
				defaultOpen
				result={{
					content: [],
					details: {
						xdev: {
							tool: "generate_image",
							mode: "execute",
							args: { subject: "alpine lake" },
							inner: {
								images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
							},
						},
					},
				}}
			/>,
		);

		expect(html).toContain("xd://generate_image");
		expect(html).toContain("alpine lake");
		expect(html).toContain('src="data:image/png;base64,aW1hZ2U="');
	});
});

describe("ToolView cancellation state", () => {
	it("renders structured aborts as cancelled rather than tool errors", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="bash"
				args={{ command: "bun install" }}
				result={{
					content: [{ type: "text", text: "Tool execution was aborted." }],
					details: { __synthetic: true, source: "tool_signal_aborted", executed: true },
					isError: true,
				}}
			/>,
		);

		expect(html).toContain("tv-card--cancelled");
		expect(html).toContain("tv-status--cancelled");
		expect(html).not.toContain("tv-card--error");
		expect(html).not.toContain("tv-err-text");
	});

	it("keeps genuine tool failures in the error state", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="bash"
				args={{ command: "exit 1" }}
				result={{ content: [{ type: "text", text: "failed" }], isError: true }}
			/>,
		);

		expect(html).toContain("tv-card--error");
		expect(html).toContain("tv-status--err");
	});
});

describe("ToolView lifecycle renderers", () => {
	it("renders checkpoint and rewind semantics instead of generic argument JSON", () => {
		const checkpoint = renderToStaticMarkup(
			<ToolView
				name="checkpoint"
				args={{ goal: "Investigate the renderer mismatch" }}
				result={{
					content: [{ type: "text", text: "Checkpoint created." }],
					details: { goal: "Investigate the renderer mismatch", startedAt: "2026-07-18T00:00:00Z" },
				}}
				defaultOpen
			/>,
		);
		const rewind = renderToStaticMarkup(
			<ToolView
				name="rewind"
				args={{ report: "The mismatch came from stale generic dispatch." }}
				result={{
					content: [{ type: "text", text: "Rewind requested." }],
					details: { report: "The mismatch came from stale generic dispatch.", rewound: true },
				}}
				defaultOpen
			/>,
		);

		expect(checkpoint).toContain("active");
		expect(checkpoint).toContain("Investigate the renderer mismatch");
		expect(rewind).toContain("rewound");
		expect(rewind).toContain("Retained report");
	});

	it("renders memory and managed-skill lifecycle fields", () => {
		const memory = renderToStaticMarkup(
			<ToolView
				name="memory_edit"
				args={{ op: "invalidate", id: "memory-7", replacement_id: "memory-8" }}
				result={{ content: [], details: { status: "invalidated", bank: "project" } }}
				defaultOpen
			/>,
		);
		const learn = renderToStaticMarkup(
			<ToolView
				name="learn"
				args={{ memory: "Keep RPC state authoritative", skill: { action: "create", name: "rpc-parity" } }}
				result={{ content: [], details: { skill: "rpc-parity" } }}
				defaultOpen
			/>,
		);
		const skill = renderToStaticMarkup(
			<ToolView
				name="manage_skill"
				args={{ action: "update", name: "rpc-parity", description: "RPC parity workflow", body: "Use core state." }}
				result={{ content: [], details: { action: "update", name: "rpc-parity" } }}
				defaultOpen
			/>,
		);

		expect(memory).toContain("memory-7");
		expect(memory).toContain("replacement");
		expect(learn).toContain("Keep RPC state authoritative");
		expect(learn).toContain("skill rpc-parity");
		expect(skill).toContain("SKILL.md body");
		expect(skill).toContain("Use core state.");
	});
});
