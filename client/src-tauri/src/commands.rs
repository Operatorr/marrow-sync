// SPDX-License-Identifier: AGPL-3.0-only

//! The `#[tauri::command]` surface called from the React UI.
//!
//! Every command in the contract is implemented here, wiring into the real
//! engine modules (ignore/chunker/hasher/index) and the in-memory [`AppState`].
//! Commands whose full behavior needs the network are correct, typed skeletons
//! marked `TODO(marrow)`.
//!
//! All structs serialize camelCase (see [`crate::state`]), so the TS wrappers map
//! 1:1 with no manual field translation.

use std::path::PathBuf;

use tauri::State;
use uuid::Uuid;

use crate::ignore::{IgnoreDecision, IgnoreEngine};
use crate::state::{
    AppState, AuthStatus, DeviceInfo, Platform, RootInfo, RootStatus, RootSyncState, ScanSummary,
    Settings, SyncState, SyncStatus,
};
use crate::{keychain, sync};

/// Uniform command error returned to the UI as a string (JS rejects the promise).
#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    #[error("no such root: {0}")]
    NoSuchRoot(String),
    #[error("path does not exist or is not a directory: {0}")]
    BadPath(String),
    #[error("keychain: {0}")]
    Keychain(#[from] keychain::KeychainError),
    #[error("{0}")]
    Other(String),
}

impl serde::Serialize for CommandError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

type CmdResult<T> = Result<T, CommandError>;

/// Open (creating if needed) the persistent local index for a sync root.
///
/// The index lives at `<root>/.marrow/index.sqlite`. `.marrow` is on the
/// always-ignored list (SPEC §8.4), so the index never syncs itself. Keeping the
/// db at a stable per-root location is what makes the §9 incremental re-scan
/// guarantee hold end-to-end: the second scan reads recorded `(mtime, size)` and
/// only re-chunks the files that actually changed.
fn open_root_index(root: &std::path::Path) -> anyhow::Result<crate::index::LocalIndex> {
    let dir = root.join(".marrow");
    std::fs::create_dir_all(&dir)?;
    Ok(crate::index::LocalIndex::open(dir.join("index.sqlite"))?)
}

// ---------------------------------------------------------------------------
// Auth (SPEC §10)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn auth_status(state: State<'_, AppState>) -> AuthStatus {
    let inner = state.read();
    AuthStatus {
        signed_in: inner.user.is_some(),
        user: inner.user.clone(),
    }
}

/// Open the system browser to the server OAuth URL (SPEC §10 desktop flow).
///
/// TODO(marrow): exchange the loopback/deep-link callback code for a session and
/// populate `AppState.user`. For now this only launches the browser.
#[tauri::command]
pub fn sign_in_with_github(app: tauri::AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let base = state.read().settings.server_url.clone();
    let url = format!("{base}/api/auth/sign-in/github");
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_url(url, None::<String>)
        .map_err(|e| CommandError::Other(e.to_string()))
}

/// Sign out: clear the in-memory session and delete the device token from the
/// OS secure store.
#[tauri::command]
pub fn sign_out(state: State<'_, AppState>) -> CmdResult<()> {
    keychain::delete_device_token()?;
    let mut inner = state.write();
    inner.user = None;
    inner.device = None;
    Ok(())
}

// ---------------------------------------------------------------------------
// Devices (SPEC §10)
// ---------------------------------------------------------------------------

/// Register this installation and persist its device token in the OS secure store.
///
/// TODO(marrow): call `POST /api/devices` to obtain the real id + raw token; here
/// we mint a local id and store a placeholder token so the keychain path is live.
#[tauri::command]
pub fn register_device(
    name: String,
    platform: Platform,
    state: State<'_, AppState>,
) -> CmdResult<DeviceInfo> {
    let device = DeviceInfo {
        id: Uuid::new_v4().to_string(),
        name,
        platform,
    };
    // TODO(marrow): replace with the server-issued, shown-once token.
    keychain::store_device_token(&format!("local-dev-token-{}", device.id))?;
    state.write().device = Some(device.clone());
    Ok(device)
}

#[tauri::command]
pub fn current_device(state: State<'_, AppState>) -> Option<DeviceInfo> {
    state.read().device.clone()
}

// ---------------------------------------------------------------------------
// Sync roots (SPEC §3, §8)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_roots(state: State<'_, AppState>) -> Vec<RootInfo> {
    let mut roots: Vec<RootInfo> = state.read().roots.values().cloned().collect();
    roots.sort_by(|a, b| a.name.cmp(&b.name));
    roots
}

#[tauri::command]
pub fn add_root(path: String, name: String, state: State<'_, AppState>) -> CmdResult<RootInfo> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(CommandError::BadPath(path));
    }
    let root = RootInfo {
        id: Uuid::new_v4().to_string(),
        name,
        path,
        paused: false,
        file_count: 0,
        status: RootStatus::Idle,
    };
    state.write().roots.insert(root.id.clone(), root.clone());
    Ok(root)
}

#[tauri::command]
pub fn remove_root(id: String, state: State<'_, AppState>) -> CmdResult<()> {
    if state.write().roots.remove(&id).is_none() {
        return Err(CommandError::NoSuchRoot(id));
    }
    Ok(())
}

#[tauri::command]
pub fn set_root_paused(
    id: String,
    paused: bool,
    state: State<'_, AppState>,
) -> CmdResult<RootInfo> {
    let mut inner = state.write();
    let root = inner
        .roots
        .get_mut(&id)
        .ok_or_else(|| CommandError::NoSuchRoot(id.clone()))?;
    root.paused = paused;
    Ok(root.clone())
}

/// Scan a root: walk it, apply real ignore rules, chunk + hash + index included
/// files, and return a summary. This is the real, deterministic engine core.
#[tauri::command]
pub fn scan_root(id: String, state: State<'_, AppState>) -> CmdResult<ScanSummary> {
    let path = {
        let inner = state.read();
        let root = inner
            .roots
            .get(&id)
            .ok_or_else(|| CommandError::NoSuchRoot(id.clone()))?;
        PathBuf::from(&root.path)
    };

    let engine = IgnoreEngine::new(&path).map_err(|e| CommandError::Other(e.to_string()))?;
    // Persist the index under the root's `.marrow` dir (always-ignored, so it never
    // syncs itself) so re-scans are incremental per SPEC §9: only mtime/size-changed
    // files get re-chunked. Missing dir/db is created on first scan.
    let mut index = open_root_index(&path).map_err(|e| CommandError::Other(e.to_string()))?;
    let res = sync::scan_root(&path, &engine, &mut index);

    // Reflect the included file count back onto the root.
    if let Some(root) = state.write().roots.get_mut(&id) {
        root.file_count = res.included;
        root.status = RootStatus::Idle;
    }

    Ok(ScanSummary {
        root_id: id,
        scanned: res.scanned,
        included: res.included,
        ignored: res.ignored,
        bytes: res.bytes,
    })
}

/// Explain why a path is or isn't synced — the trust feature (SPEC §8 UI surfacing).
/// Returns the exact `@marrow/shared` `IgnoreDecision` shape.
#[tauri::command]
pub fn explain_ignore(
    root_id: String,
    rel_path: String,
    state: State<'_, AppState>,
) -> CmdResult<IgnoreDecision> {
    let path = {
        let inner = state.read();
        let root = inner
            .roots
            .get(&root_id)
            .ok_or_else(|| CommandError::NoSuchRoot(root_id.clone()))?;
        PathBuf::from(&root.path)
    };
    let engine = IgnoreEngine::new(&path).map_err(|e| CommandError::Other(e.to_string()))?;

    let abs = path.join(&rel_path);
    let (is_dir, size) = match std::fs::metadata(&abs) {
        Ok(m) => (m.is_dir(), Some(m.len())),
        Err(_) => (false, None),
    };
    Ok(engine.decide(&rel_path, is_dir, size))
}

// ---------------------------------------------------------------------------
// Sync status + control (SPEC §7)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn sync_status(state: State<'_, AppState>) -> SyncStatus {
    let inner = state.read();
    let roots = inner
        .roots
        .values()
        .map(|r| RootSyncState {
            root_id: r.id.clone(),
            status: r.status,
            cursor: 0,
        })
        .collect();
    SyncStatus {
        state: SyncState::Idle,
        roots,
        last_sync_at: inner.last_sync_at,
    }
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.read().settings.clone()
}

#[tauri::command]
pub fn set_settings(settings: Settings, state: State<'_, AppState>) -> Settings {
    state.write().settings = settings.clone();
    settings
}

/// Trigger a sync of one root (or all when `root_id` is null).
///
/// TODO(marrow): kick the reconcile pipeline — scan → `chunks/check` → upload →
/// `commit` → pull `changes` → download → write. The skeleton validates the
/// target and returns; the real orchestration lands in [`crate::sync`].
#[tauri::command]
pub fn trigger_sync(root_id: Option<String>, state: State<'_, AppState>) -> CmdResult<()> {
    if let Some(id) = &root_id {
        if !state.read().roots.contains_key(id) {
            return Err(CommandError::NoSuchRoot(id.clone()));
        }
    }
    // TODO(marrow): spawn the async reconcile task per targeted root.
    Ok(())
}
