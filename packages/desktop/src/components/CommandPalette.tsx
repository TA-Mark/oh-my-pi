import { Command, FolderOpen, GitBranch, MessageSquarePlus, PanelLeft, Search, Settings2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

export interface CommandAction {
	id: string;
	label: string;
	detail: string;
	shortcut?: string;
	icon: typeof Command;
	onRun: () => void;
}

export function filterCommandActions(actions: readonly CommandAction[], query: string): CommandAction[] {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return [...actions];
	return actions.filter(action => `${action.label} ${action.detail}`.toLowerCase().includes(normalized));
}

interface CommandPaletteProps {
	open: boolean;
	actions: readonly CommandAction[];
	onClose: () => void;
}

export function CommandPalette({ open, actions, onClose }: CommandPaletteProps) {
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const visibleActions = useMemo(() => filterCommandActions(actions, query), [actions, query]);

	useEffect(() => {
		if (!open) return;
		setQuery("");
		setActiveIndex(0);
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") onClose();
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setActiveIndex(index => (visibleActions.length === 0 ? 0 : (index + 1) % visibleActions.length));
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				setActiveIndex(index =>
					visibleActions.length === 0 ? 0 : (index - 1 + visibleActions.length) % visibleActions.length,
				);
			}
			if (event.key === "Enter" && visibleActions[activeIndex]) {
				event.preventDefault();
				visibleActions[activeIndex].onRun();
				onClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [activeIndex, onClose, open, visibleActions]);

	useEffect(() => {
		setActiveIndex(index => Math.min(index, Math.max(visibleActions.length - 1, 0)));
	}, [visibleActions.length]);

	if (!open) return null;
	return (
		<div className="command-palette-layer" role="presentation">
			<button type="button" className="picker-backdrop" aria-label="Close command palette" onClick={onClose} />
			<section className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
				<label className="command-palette-search">
					<Search size={17} strokeWidth={1.8} />
					<input
						autoFocus
						value={query}
						onChange={event => setQuery(event.currentTarget.value)}
						placeholder="Search commands..."
					/>
					<kbd>Esc</kbd>
				</label>
				<div className="command-palette-list">
					{visibleActions.length === 0 ? <div className="command-palette-empty">No matching commands.</div> : null}
					{visibleActions.map((action, index) => {
						const Icon = action.icon;
						return (
							<button
								type="button"
								key={action.id}
								className={`command-palette-item${activeIndex === index ? " command-palette-item--active" : ""}`}
								onMouseEnter={() => setActiveIndex(index)}
								onClick={() => {
									action.onRun();
									onClose();
								}}
							>
								<Icon size={17} strokeWidth={1.8} />
								<span className="command-palette-copy">
									<strong>{action.label}</strong>
									<small>{action.detail}</small>
								</span>
								{action.shortcut ? <kbd>{action.shortcut}</kbd> : null}
							</button>
						);
					})}
				</div>
			</section>
		</div>
	);
}

export const COMMAND_ICONS = { Command, FolderOpen, GitBranch, MessageSquarePlus, PanelLeft, Settings2 };
