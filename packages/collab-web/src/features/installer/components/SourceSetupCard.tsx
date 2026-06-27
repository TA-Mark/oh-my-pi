import type { ReactNode } from 'react';
import type { InstallerPhase } from '../types/installer';

interface Props {
  repoUrl: string;
  branch: string;
  installPath: string;
  phase: InstallerPhase;
  onChange(repoUrl: string, branch: string, installPath: string): void;
}

const locked: InstallerPhase[] = ['checking', 'installing', 'success'];

export function SourceSetupCard({ repoUrl, branch, installPath, phase, onChange }: Props): ReactNode {
  const disabled = locked.includes(phase);

  return (
    <div className="ins-card">
      <div className="ins-card-title">Source</div>

      <div className="ins-field">
        <label className="ins-field-label" htmlFor="ins-repo-url">Repository URL</label>
        <input
          id="ins-repo-url"
          className="ins-input ins-input-mono"
          type="text"
          value={repoUrl}
          disabled={disabled}
          placeholder="https://github.com/myorg/oh-my-pi.git"
          onChange={e => onChange(e.target.value, branch, installPath)}
        />
      </div>

      <div className="ins-fields-row">
        <div className="ins-field">
          <label className="ins-field-label" htmlFor="ins-branch">Branch</label>
          <input
            id="ins-branch"
            className="ins-input ins-input-mono"
            type="text"
            value={branch}
            disabled={disabled}
            placeholder="main"
            onChange={e => onChange(repoUrl, e.target.value, installPath)}
          />
        </div>

        <div className="ins-field" style={{ flex: 2 }}>
          <label className="ins-field-label" htmlFor="ins-path">Install Path (Windows)</label>
          <input
            id="ins-path"
            className="ins-input ins-input-mono"
            type="text"
            value={installPath}
            disabled={disabled}
            placeholder="C:\oh-my-pi"
            onChange={e => onChange(repoUrl, branch, e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}
