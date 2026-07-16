import { Brain, Check, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { type ModelInfo, THINKING_LEVELS, type ThinkingLevel } from "../lib/rpc-protocol";

interface ThinkingPickerProps {
	current?: ThinkingLevel;
	model?: string;
	models: ModelInfo[];
	disabled?: boolean;
	onSelect: (level: ThinkingLevel) => void;
}

type SelectableThinkingLevel = (typeof THINKING_LEVELS)[number];

const THINKING_COPY: Record<SelectableThinkingLevel, string> = {
	off: "Fastest responses",
	auto: "Auto-detect per prompt",
	minimal: "Tiny planning budget",
	low: "Light reasoning",
	medium: "Balanced reasoning",
	high: "Deeper reasoning",
	xhigh: "Very deep reasoning",
	max: "Maximum reasoning",
};

function splitModelLabel(label?: string): { provider?: string; id?: string } {
	if (!label) return {};
	const slash = label.indexOf("/");
	if (slash < 0) return { id: label };
	return { provider: label.slice(0, slash), id: label.slice(slash + 1) };
}

function supportedLevelsForModel(modelLabel: string | undefined, models: ModelInfo[]): SelectableThinkingLevel[] {
	const currentModel = splitModelLabel(modelLabel);
	const model = models.find(
		candidate => candidate.provider === currentModel.provider && candidate.id === currentModel.id,
	);
	const efforts = model?.thinking?.efforts?.filter((level): level is SelectableThinkingLevel =>
		(THINKING_LEVELS as readonly string[]).includes(level),
	);
	if (efforts && efforts.length > 0) return ["off", "auto", ...efforts];
	if (model?.reasoning) return ["off", "auto"];
	return ["off"];
}

export function ThinkingPicker({ current, model, models, disabled, onSelect }: ThinkingPickerProps) {
	const [open, setOpen] = useState(false);
	const levels = useMemo(() => supportedLevelsForModel(model, models), [model, models]);
	const known = current !== undefined && (levels as readonly string[]).includes(current);
	const currentLabel = known ? current : "Select thinking";
	const close = (): void => setOpen(false);

	return (
		<div className="setting-menu setting-menu--thinking">
			<button
				type="button"
				className={`setting-trigger${open ? " setting-trigger--open" : ""}`}
				disabled={disabled}
				aria-expanded={open}
				onClick={() => setOpen(currentOpen => !currentOpen)}
			>
				<span className="setting-avatar setting-avatar--thinking">
					<Brain size={16} strokeWidth={1.9} />
				</span>
				<span className="setting-trigger-copy">
					<span className="setting-trigger-title">{currentLabel}</span>
					<span className="setting-trigger-subtitle">thinking level</span>
				</span>
				<ChevronRight className="setting-trigger-caret" size={15} strokeWidth={1.9} />
			</button>
			{open ? (
				<>
					<button type="button" className="picker-backdrop" aria-label="Close thinking levels" onClick={close} />
					<div className="setting-panel setting-panel--thinking">
						<div className="setting-panel-head">
							<span className="setting-panel-title">Thinking</span>
							<span className="setting-panel-subtitle">OMP order: off → auto → supported efforts</span>
						</div>
						<div className="setting-list">
							{levels.map(level => (
								<button
									key={level}
									type="button"
									className={`setting-item${level === current ? " setting-item--active" : ""}`}
									onClick={() => {
										onSelect(level);
										close();
									}}
								>
									<span className="setting-item-copy">
										<span className="setting-item-title">{level}</span>
										<span className="setting-item-subtitle">{THINKING_COPY[level]}</span>
									</span>
									<span className="setting-item-meta">
										{level === current ? <Check size={13} strokeWidth={2.1} /> : null}
									</span>
								</button>
							))}
						</div>
					</div>
				</>
			) : null}
		</div>
	);
}
