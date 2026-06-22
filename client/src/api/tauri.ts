// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Typed wrappers around the Tauri command surface. Every `#[tauri::command]` in
 * `commands.rs` has exactly one wrapper here, named after the snake_case command
 * and returning the matching contract type from `./types`.
 *
 * The UI must run in a plain browser (jsdom under vitest, or `vite preview`)
 * where the Tauri IPC bridge is absent. We therefore detect Tauri at runtime and
 * surface a typed {@link TauriUnavailableError} instead of letting `invoke`
 * explode — callers can catch it and show an "open the desktop app" affordance.
 * Tests mock `@tauri-apps/api/core` to exercise the wrappers directly.
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  AuthStatus,
  DeviceInfo,
  IgnoreDecision,
  Platform,
  RootInfo,
  ScanSummary,
  Settings,
  SyncStatus,
} from "./types";

/** Thrown when a command is called outside a Tauri webview (no IPC bridge). */
export class TauriUnavailableError extends Error {
  constructor(command: string) {
    super(`Tauri command "${command}" is unavailable outside the desktop app`);
    this.name = "TauriUnavailableError";
  }
}

/**
 * Whether the Tauri IPC bridge is present. Tauri injects `__TAURI_INTERNALS__`
 * onto `window`; we feature-detect it rather than sniffing a user agent.
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Invoke a command, mapping the missing-bridge case to a typed error. */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new TauriUnavailableError(command);
  return invoke<T>(command, args);
}

// --- Auth (SPEC §10) ---------------------------------------------------------

export function authStatus(): Promise<AuthStatus> {
  return call<AuthStatus>("auth_status");
}

export function signInWithGithub(): Promise<void> {
  return call<void>("sign_in_with_github");
}

export function signOut(): Promise<void> {
  return call<void>("sign_out");
}

// --- Devices -----------------------------------------------------------------

export function registerDevice(name: string, platform: Platform): Promise<DeviceInfo> {
  return call<DeviceInfo>("register_device", { name, platform });
}

export function currentDevice(): Promise<DeviceInfo | null> {
  return call<DeviceInfo | null>("current_device");
}

// --- Roots -------------------------------------------------------------------

export function listRoots(): Promise<RootInfo[]> {
  return call<RootInfo[]>("list_roots");
}

export function addRoot(path: string, name: string): Promise<RootInfo> {
  return call<RootInfo>("add_root", { path, name });
}

export function removeRoot(id: string): Promise<void> {
  return call<void>("remove_root", { id });
}

export function setRootPaused(id: string, paused: boolean): Promise<RootInfo> {
  return call<RootInfo>("set_root_paused", { id, paused });
}

export function scanRoot(id: string): Promise<ScanSummary> {
  return call<ScanSummary>("scan_root", { id });
}

// --- Ignore (SPEC §8) --------------------------------------------------------

export function explainIgnore(rootId: string, relPath: string): Promise<IgnoreDecision> {
  return call<IgnoreDecision>("explain_ignore", { rootId, relPath });
}

// --- Sync (SPEC §7) ----------------------------------------------------------

export function syncStatus(): Promise<SyncStatus> {
  return call<SyncStatus>("sync_status");
}

export function triggerSync(rootId: string | null): Promise<void> {
  return call<void>("trigger_sync", { rootId });
}

// --- Settings ----------------------------------------------------------------

export function getSettings(): Promise<Settings> {
  return call<Settings>("get_settings");
}

export function setSettings(settings: Settings): Promise<Settings> {
  return call<Settings>("set_settings", { settings });
}
