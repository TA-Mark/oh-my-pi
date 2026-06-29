/**
 * StatusWidgetPanel — renders the `setStatus` strip and `setWidget` cards
 * from omp's extension UI requests.
 *
 *   - Status entries: one-line key → text pairs in a horizontal strip.
 *   - Widgets: stacked panels split by placement (above / below composer).
 */
import type { ReactNode } from "react";
import type { StatusEntry, WidgetState } from "../../../lib/client";

interface Props {
	statusEntries: readonly StatusEntry[];
	widgets: readonly WidgetState[];
	placement: "aboveEditor" | "belowEditor";
}

export function StatusWidgetPanel({ statusEntries, widgets, placement }: Props): ReactNode {
	const filteredWidgets = widgets.filter(w => w.placement === placement);
	const showStatus = placement === "aboveEditor" && statusEntries.length > 0;

	if (!showStatus && filteredWidgets.length === 0) return null;

	return (
		<div className="mc-status-widget-panel" data-placement={placement}>
			{showStatus && (
				<div className="mc-status-strip" role="status">
					{statusEntries.map(s => (
						<span key={s.key} className="mc-status-entry" title={s.key}>
							{s.text}
						</span>
					))}
				</div>
			)}
			{filteredWidgets.map(w => (
				<div key={w.key} className="mc-widget" title={w.key}>
					{w.lines.map((line, i) => (
						<div key={i} className="mc-widget-line">
							{line}
						</div>
					))}
				</div>
			))}
		</div>
	);
}
