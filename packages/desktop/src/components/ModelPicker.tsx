import { useMemo, useState } from "react";
import type { ModelInfo } from "../lib/rpc-protocol";

interface ModelPickerProps {
	current?: string;
	models: ModelInfo[];
	disabled?: boolean;
	onSelect: (provider: string, id: string) => void;
}

const MAX_VISIBLE = 200;

export function ModelPicker({ current, models, disabled, onSelect }: ModelPickerProps) {
	const [open, setOpen] = useState(false);
	const [filter, setFilter] = useState("");

	const filtered = useMemo(() => {
		const q = filter.trim().toLowerCase();
		const list = q ? models.filter(m => `${m.provider}/${m.id}`.toLowerCase().includes(q)) : models;
		return list.slice(0, MAX_VISIBLE);
	}, [models, filter]);

	const close = () => {
		setOpen(false);
		setFilter("");
	};

	return (
		<div className="picker">
			<button type="button" className="picker-trigger" disabled={disabled} onClick={() => setOpen(o => !o)}>
				{current ?? "Select model"} <span className="picker-caret">▾</span>
			</button>
			{open ? (
				<>
					<button type="button" className="picker-backdrop" aria-label="Close" onClick={close} />
					<div className="picker-panel">
						<input
							className="picker-filter"
							// biome-ignore lint/a11y/noAutofocus: focus the filter when the picker opens
							autoFocus
							placeholder="Filter models…"
							value={filter}
							onChange={event => setFilter(event.target.value)}
						/>
						<div className="picker-list">
							{filtered.length === 0 ? (
								<div className="picker-empty">No models</div>
							) : (
								filtered.map(model => {
									const label = `${model.provider}/${model.id}`;
									return (
										<button
											key={label}
											type="button"
											className={`picker-item ${label === current ? "picker-item-active" : ""}`}
											onClick={() => {
												onSelect(model.provider, model.id);
												close();
											}}
										>
											<span className="picker-item-id">{model.id}</span>
											<span className="picker-item-provider">{model.provider}</span>
										</button>
									);
								})
							)}
						</div>
					</div>
				</>
			) : null}
		</div>
	);
}
