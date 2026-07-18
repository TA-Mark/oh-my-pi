/**
 * Tool card chrome + per-tool dispatch. Works in the collab-web app and inside
 * the `<omp-tool-view>` web component embedded in HTML session exports.
 */
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { ReactNode } from "react";
import { useState } from "react";
import { resolveToolRenderer } from "./registry";
import type { ToolRenderHost, ToolRenderProps, ToolResultLike } from "./types";
import { isRecord, replaceTabs, stripAnsi } from "./util";
import "./tool-render.css";

export interface ToolViewProps {
	name: string;
	args?: unknown;
	result?: ToolResultLike;
	/** Tool is still executing (live collab view). */
	running?: boolean;
	/** Model-provided intent (`i`), shown atop the body. */
	intent?: string;
	/** Streaming partial output tail while running. */
	partial?: string;
	defaultOpen?: boolean;
	/** Host capabilities (sub-session drill-down, …). */
	host?: ToolRenderHost;
}

function normalizeArgs(raw: unknown): { args: Record<string, unknown>; intent: string | undefined } {
	if (!isRecord(raw)) return { args: {}, intent: undefined };
	const intent = typeof raw[INTENT_FIELD] === "string" ? (raw[INTENT_FIELD] as string).trim() : undefined;
	if (!(INTENT_FIELD in raw)) return { args: raw, intent };
	const args: Record<string, unknown> = {};
	for (const k in raw) {
		if (k !== INTENT_FIELD) args[k] = raw[k];
	}
	return { args, intent };
}

interface XdevDispatch {
	tool: string;
	args: Record<string, unknown>;
	inner: unknown;
}

type SyntheticDisposition = "cancelled" | "skipped";

/** Core-generated results carry a structured discriminator so hosts never have
 * to guess cancellation from localized/user-visible result text. */
function syntheticDisposition(result: ToolResultLike | undefined): SyntheticDisposition | undefined {
	if (!isRecord(result?.details) || result.details.__synthetic !== true) return undefined;
	const source = result.details.source;
	if (source === "assistant_stop_aborted" || source === "tool_signal_aborted") return "cancelled";
	if (source === "assistant_stop_skipped" || source === "tool_execution_skipped") return "skipped";
	return undefined;
}

function executeXdevDispatch(props: ToolViewProps): XdevDispatch | null {
	if (props.name !== "write" || props.result?.isError === true || !isRecord(props.result?.details)) return null;
	const xdev = props.result.details.xdev;
	if (!isRecord(xdev) || xdev.mode !== "execute" || typeof xdev.tool !== "string") return null;
	return { tool: xdev.tool, args: isRecord(xdev.args) ? xdev.args : {}, inner: xdev.inner };
}

export function ToolView(props: ToolViewProps): ReactNode {
	const [open, setOpen] = useState(props.defaultOpen ?? false);
	const disposition = syntheticDisposition(props.result);
	const xdev = executeXdevDispatch(props);
	const { args, intent: argIntent } = normalizeArgs(props.args);
	const intent = props.intent?.trim() || argIntent;
	const name = xdev?.tool ?? props.name;
	const rawResult = xdev
		? { content: props.result!.content, details: xdev.inner, isError: props.result!.isError }
		: props.result;
	// Cancellation/skipping is neither success nor a tool failure. Preserve the
	// structured details and result text, but don't make specialized renderers
	// (for example bash's summary) paint it as an error.
	const result = disposition && rawResult ? { ...rawResult, isError: false } : rawResult;
	const renderer = resolveToolRenderer(name);
	const renderProps: ToolRenderProps = {
		name,
		args: xdev?.args ?? args,
		result,
		running: props.running,
		host: props.host,
	};

	const isError = props.result?.isError === true && !disposition;
	const status = props.running
		? "run"
		: disposition === "cancelled"
			? "cancelled"
			: disposition === "skipped"
				? "skipped"
				: isError
					? "err"
					: props.result
						? "ok"
						: "pending";
	const partial = props.running && !props.result && props.partial ? stripAnsi(replaceTabs(props.partial)) : "";

	return (
		<div className={`tv-card${isError ? " tv-card--error" : ""}${disposition ? ` tv-card--${disposition}` : ""}`}>
			<button
				type="button"
				className="tv-head"
				aria-expanded={open}
				onClick={() => setOpen(v => !v)}
				title={intent || undefined}
			>
				{status === "run" ? (
					<span className="tv-spin" aria-label="running" />
				) : (
					<span className={`tv-status tv-status--${status}`} aria-hidden="true" />
				)}
				<span className="tv-name">{xdev ? `xd://${name}` : name}</span>
				<span className="tv-sum">
					<renderer.Summary {...renderProps} />
				</span>
				<span className="tv-chev" aria-hidden="true" />
			</button>
			{open && (
				<div className="tv-body">
					{intent && <div className="tv-intent">{intent}</div>}
					{renderer.Body ? <renderer.Body {...renderProps} /> : null}
				</div>
			)}
			{partial && <pre className="tv-partial">{partial.length > 2048 ? `…${partial.slice(-2048)}` : partial}</pre>}
		</div>
	);
}
