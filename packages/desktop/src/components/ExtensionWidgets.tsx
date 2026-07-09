import { replaceTabs, stripAnsi } from "@oh-my-pi/collab-web/src/tool-render";

export type WidgetPlacement = "aboveEditor" | "belowEditor";

/** A keyed, multi-line widget pushed by an extension via `setWidget`. */
export interface WidgetEntry {
	lines: string[];
	placement: WidgetPlacement;
}

/** Extension-provided text is TUI-oriented: strip ANSI escapes + widen tabs before display. */
function clean(line: string): string {
	return replaceTabs(stripAnsi(line));
}

/** Keyed status strings pushed via `setStatus`, rendered as a compact chip row. */
export function StatusBar({ statuses }: { statuses: Record<string, string> }) {
	const entries = Object.entries(statuses);
	if (entries.length === 0) return null;
	return (
		<div className="status-bar">
			{entries.map(([key, text]) => (
				<span key={key} className="status-chip" title={key}>
					{clean(text)}
				</span>
			))}
		</div>
	);
}

/** Multi-line widgets for a single placement slot (above/below the composer). */
export function WidgetArea({
	widgets,
	placement,
}: {
	widgets: Record<string, WidgetEntry>;
	placement: WidgetPlacement;
}) {
	const entries = Object.entries(widgets).filter(([, widget]) => widget.placement === placement);
	if (entries.length === 0) return null;
	return (
		<div className={`widget-area widget-area--${placement}`}>
			{entries.map(([key, widget]) => (
				<div key={key} className="widget-box">
					{widget.lines.map((line, i) => (
						<div key={i} className="widget-line">
							{clean(line) || "\u00a0"}
						</div>
					))}
				</div>
			))}
		</div>
	);
}
