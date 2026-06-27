import type { ReactNode } from 'react';
import type { RuntimeConfig } from '../types/chat';

interface Props {
  config: RuntimeConfig | null;
  availableModels: string[];
  loading: boolean;
  onUpdate(patch: Partial<RuntimeConfig>): void;
}

export function UserControlsPanel({ config, availableModels, loading, onUpdate }: Props): ReactNode {
  if (!config) {
    return (
      <div style={{ color: 'var(--fg-faint)', fontSize: 12 }}>
        {loading ? 'Loading config…' : 'No config available.'}
      </div>
    );
  }

  return (
    <div>
      <div className="mc-section-title">Runtime Controls</div>

      {/* Model selector */}
      <div className="mc-control-row">
        <label className="mc-control-label" htmlFor="mc-model-select">Model</label>
        <select
          id="mc-model-select"
          className="mc-select"
          value={config.model}
          disabled={loading}
          onChange={e => onUpdate({ model: e.target.value })}
        >
          {availableModels.length === 0
            ? <option value={config.model}>{config.model}</option>
            : availableModels.map(m => (
                <option key={m} value={m}>{m}</option>
              ))
          }
        </select>
      </div>

      {/* Mode selector */}
      <div className="mc-control-row">
        <label className="mc-control-label" htmlFor="mc-mode-select">Mode</label>
        <select
          id="mc-mode-select"
          className="mc-select"
          value={config.mode}
          disabled={loading}
          onChange={e => onUpdate({ mode: e.target.value as RuntimeConfig['mode'] })}
        >
          <option value="normal">Normal</option>
          <option value="safe">Safe</option>
          <option value="debug">Debug</option>
        </select>
      </div>

      {/* Thinking toggle */}
      <div className="mc-toggle-row">
        <span className="mc-toggle-label">Extended Thinking</span>
        <label className="mc-toggle">
          <input
            type="checkbox"
            checked={config.thinkingEnabled}
            disabled={loading}
            onChange={e => onUpdate({ thinkingEnabled: e.target.checked })}
          />
          <span className="mc-toggle-track" />
          <span className="mc-toggle-thumb" />
        </label>
      </div>
    </div>
  );
}
