// SPDX-License-Identifier: AGPL-3.0-only

//! In-memory application state shared across Tauri commands.
//!
//! Holds the registered device, configured sync roots, settings, and the current
//! sync status. Full sync orchestration (network reconcile) is out of MVP scope;
//! where behavior is a skeleton it is marked `TODO(marrow)`, but the shapes here
//! match the Tauri command contract exactly (camelCase across the boundary).

use std::collections::HashMap;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

/// OS family a device runs on. Mirrors `@marrow/shared` `Platform`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Macos,
    Windows,
    Linux,
}

/// The signed-in user (subset surfaced to the UI).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    pub id: String,
    pub name: String,
    pub email: String,
}

/// Sign-in status returned by `auth_status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub signed_in: bool,
    pub user: Option<UserInfo>,
}

/// A registered installation of the client (`register_device` / `current_device`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub platform: Platform,
}

/// Live status of one sync root (`list_roots`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RootStatus {
    Idle,
    Scanning,
    Syncing,
    Error,
}

/// A configured sync root surfaced to the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub paused: bool,
    pub file_count: u64,
    pub status: RootStatus,
}

/// Summary of a completed scan (`scan_root`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub root_id: String,
    pub scanned: u64,
    pub included: u64,
    pub ignored: u64,
    pub bytes: u64,
}

/// Overall sync engine state (`sync_status`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncState {
    Idle,
    Scanning,
    Uploading,
    Downloading,
    Error,
}

/// Per-root piece of the overall sync status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootSyncState {
    pub root_id: String,
    pub status: RootStatus,
    /// Local cursor: the last per-root `seq` fully applied (SPEC §7).
    pub cursor: u64,
}

/// Aggregate sync status (`sync_status`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub state: SyncState,
    pub roots: Vec<RootSyncState>,
    /// Epoch milliseconds of the last successful sync, or null.
    pub last_sync_at: Option<i64>,
}

/// User-facing settings (`get_settings` / `set_settings`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub server_url: String,
    pub auto_sync: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            server_url: "http://localhost:8787".to_string(),
            auto_sync: true,
        }
    }
}

/// The mutable inner state, guarded by a single `RwLock`.
#[derive(Default)]
pub struct Inner {
    pub user: Option<UserInfo>,
    pub device: Option<DeviceInfo>,
    pub roots: HashMap<String, RootInfo>,
    pub settings: Settings,
    pub last_sync_at: Option<i64>,
}

/// Tauri-managed application state.
#[derive(Default)]
pub struct AppState {
    inner: RwLock<Inner>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(Inner {
                settings: Settings::default(),
                ..Inner::default()
            }),
        }
    }

    /// Read access to the inner state.
    pub fn read(&self) -> std::sync::RwLockReadGuard<'_, Inner> {
        self.inner.read().expect("AppState lock poisoned")
    }

    /// Write access to the inner state.
    pub fn write(&self) -> std::sync::RwLockWriteGuard<'_, Inner> {
        self.inner.write().expect("AppState lock poisoned")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_default_is_local_autosync() {
        let s = Settings::default();
        assert!(s.auto_sync);
        assert!(s.server_url.starts_with("http"));
    }

    #[test]
    fn platform_serializes_lowercase() {
        let json = serde_json::to_string(&Platform::Macos).unwrap();
        assert_eq!(json, "\"macos\"");
    }

    #[test]
    fn root_info_camel_case_keys() {
        let r = RootInfo {
            id: "r1".into(),
            name: "code".into(),
            path: "/Users/x/code".into(),
            paused: false,
            file_count: 3,
            status: RootStatus::Idle,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert!(v.get("fileCount").is_some());
        assert_eq!(v["status"], "idle");
    }

    #[test]
    fn appstate_read_write() {
        let st = AppState::new();
        st.write().user = Some(UserInfo {
            id: "u".into(),
            name: "Alex".into(),
            email: "a@example.com".into(),
        });
        assert_eq!(st.read().user.as_ref().unwrap().name, "Alex");
    }
}
