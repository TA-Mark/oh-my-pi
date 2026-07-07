import { type ThinkingLevel, THINKING_LEVELS } from "../lib/rpc-protocol";

interface ThinkingPickerProps {
	current?: ThinkingLevel;
	disabled?: boolean;
	onSelect: (level: ThinkingLevel) => void;
}

export function ThinkingPicker({ current, disabled, onSelect }: ThinkingPickerProps) {
	const known = current !== undefined && (THINKING_LEVELS as readonly string[]).includes(current);
	return (
		<label className="thinking-picker">
			<span className="thinking-label">think</span>
			<select
				className="thinking-select"
				value={known ? current : ""}
				disabled={disabled}
				onChange={event => onSelect(event.target.value as ThinkingLevel)}
			>
				{known ? null : (
					<option value="" disabled>
						—
					</option>
				)}
				{THINKING_LEVELS.map(level => (
					<option key={level} value={level}>
						{level}
					</option>
				))}
			</select>
		</label>
	);
}
