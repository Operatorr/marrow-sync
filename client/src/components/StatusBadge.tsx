// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Small status pill used across the Roots and Status views. Maps a sync/root
 * lifecycle state to a labelled, colour-coded badge.
 */

import type { RootStatus, SyncState } from "../api/types";

const LABELS: Record<RootStatus | SyncState | "paused", string> = {
  idle: "Idle",
  scanning: "Scanning",
  syncing: "Syncing",
  uploading: "Uploading",
  downloading: "Downloading",
  error: "Error",
  paused: "Paused",
};

export function StatusBadge({ state }: { state: RootStatus | SyncState | "paused" }) {
  return (
    <span className={`badge badge-${state}`}>
      <span className="dot" />
      {LABELS[state]}
    </span>
  );
}
