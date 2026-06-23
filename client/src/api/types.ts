// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TypeScript shapes for the Tauri command surface — the contract between the Rust
 * `commands.rs` layer and this UI. Structs on the Rust side serialize camelCase
 * (`serde rename_all = "camelCase"`); the status/platform enums serialize
 * lowercase (single-word variants, so the two coincide today). These line up
 * with the wire JSON with no manual mapping.
 *
 * Where a shape is already part of the shared client/server contract we reuse it
 * from `@marrow/shared` rather than redeclaring it (`IgnoreDecision`, `Platform`).
 */

import type { IgnoreDecision, Platform } from "@marrow/shared";

export type { IgnoreDecision, Platform };

/** The signed-in human's identity, as surfaced by the OAuth session. */
export interface UserInfo {
  id: string;
  name: string;
  email: string;
}

/** Result of `auth_status` — whether a session exists and who it belongs to. */
export interface AuthStatus {
  signedIn: boolean;
  user: UserInfo | null;
}

/** A registered installation of this client (`register_device`/`current_device`). */
export interface DeviceInfo {
  id: string;
  name: string;
  platform: Platform;
}

/** Lifecycle state of a single sync root. */
export type RootStatus = "idle" | "scanning" | "syncing" | "error";

/** A folder the user has marked for sync, with live counters. */
export interface RootInfo {
  id: string;
  name: string;
  path: string;
  paused: boolean;
  fileCount: number;
  status: RootStatus;
}

/** Summary returned after a scan reconciles a root against the ignore engine. */
export interface ScanSummary {
  rootId: string;
  scanned: number;
  included: number;
  ignored: number;
  bytes: number;
}

/** Top-level sync engine state. */
export type SyncState = "idle" | "scanning" | "uploading" | "downloading" | "error";

/** Per-root slice of the overall sync status. */
export interface RootSyncState {
  rootId: string;
  /** Lifecycle state of this root (matches the per-root `status` in `list_roots`). */
  status: RootStatus;
  /** Local cursor: the last per-root `seq` fully applied (SPEC §7). */
  cursor: number;
}

/** Result of `sync_status` — the aggregate plus a per-root breakdown. */
export interface SyncStatus {
  state: SyncState;
  roots: RootSyncState[];
  /** Epoch milliseconds of the last completed sync, or null if never. */
  lastSyncAt: number | null;
}

/** Persisted client settings (`get_settings`/`set_settings`). */
export interface Settings {
  serverUrl: string;
  autoSync: boolean;
}
