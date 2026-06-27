import type { ReactNode } from 'react';
import type { UpdateInfo, UpdateChannel } from '../types/launcher';

interface Props {
  updateInfo: UpdateInfo | null;
  updateChecking: boolean;
  updating: boolean;
  onCheckUpdate(): void;
  onApplyUpdate(channel: UpdateChannel): void;
  onRepair(): void;
  onResetCache(): void;
}

export function UpdateMaintenanceCard({
  updateInfo,
  updateChecking,
  updating,
  onCheckUpdate,
  onApplyUpdate,
  onRepair,
  onResetCache,
}: Props): ReactNode {
  return (
    <div className="lnc-card">
      <div className="lnc-card-title">Update &amp; Maintenance</div>

      {/* Update banner */}
      {updateInfo?.available && (
        <div className="lnc-update-banner">
          <div className="lnc-update-text">
            Update available:{' '}
            <span className="lnc-update-version">{updateInfo.latestVersion}</span>
            {' '}(current: {updateInfo.currentVersion})
          </div>
          <button
            className="lnc-btn lnc-btn-primary"
            onClick={() => onApplyUpdate(updateInfo.channel)}
            disabled={updating}
          >
            {updating ? <><span className="lnc-spinner" /> Updating…</> : '↑ Update'}
          </button>
        </div>
      )}

      {/* No update available */}
      {updateInfo && !updateInfo.available && (
        <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
          Up to date — <span style={{ fontFamily: 'var(--font-mono)' }}>{updateInfo.currentVersion}</span>
          <span style={{ color: 'var(--fg-faint)', marginLeft: 6 }}>
            ({updateInfo.channel})
          </span>
        </div>
      )}

      {/* Maintenance actions */}
      <div className="lnc-maintenance-grid">
        <button
          className="lnc-btn"
          onClick={onCheckUpdate}
          disabled={updateChecking || updating}
        >
          {updateChecking ? <><span className="lnc-spinner" /> Checking…</> : '⟳ Check Update'}
        </button>

        <button className="lnc-btn" onClick={onRepair} disabled={updating}>
          🔧 Repair Install
        </button>

        <button className="lnc-btn" onClick={onResetCache} disabled={updating}>
          🗑 Reset Cache
        </button>
      </div>
    </div>
  );
}
