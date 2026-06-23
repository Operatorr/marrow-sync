// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Small status pill used across the Roots and Status views. Maps a sync/root
 * lifecycle state to a labelled, colour-coded badge.
 */

import type { RootStatus, SyncState } from "../api/types";

/** The synthetic `"paused"` state is supplied by the Roots view (not a wire enum). */
export type BadgeState = RootStatus | SyncState | "paused";

const LABELS: Record<BadgeState, string> = {
  idle: "Idle",
  scanning: "Scanning",
  syncing: "Syncing",
  uploading: "Uploading",
  downloading: "Downloading",
  error: "Error",
  paused: "Paused",
};

/** Known states get a `badge-<state>` modifier; anything else stays neutral. */
const KNOWN = new Set<string>(Object.keys(LABELS));

export function StatusBadge({ state }: { state: BadgeState | (string & {}) }) {
  // The state crosses the Rust IPC boundary, so guard against an out-of-contract
  // value: fall back to the raw string for the label and skip the unknown
  // modifier class (which would have no styling anyway).
  const label = LABELS[state as BadgeState] ?? state;
  const className = KNOWN.has(state) ? `badge badge-${state}` : "badge";
  return (
    <span className={className}>
      <span className="dot" />
      {label}
    </span>
  );
}
