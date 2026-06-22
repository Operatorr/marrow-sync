// SPDX-License-Identifier: AGPL-3.0-only

//! Marrow desktop client — Rust core (SPEC §3).
//!
//! `run()` is the single entry point shared by the desktop binary (`main.rs`) and
//! any future mobile entry point. It wires the opener plugin, manages the in-memory
//! [`state::AppState`], and registers the full Tauri command surface.

pub mod chunker;
pub mod commands;
pub mod hasher;
pub mod ignore;
pub mod index;
pub mod keychain;
pub mod state;
pub mod sync;
pub mod transfer;
pub mod watcher;

use state::AppState;

/// Build and run the Tauri application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::auth_status,
            commands::sign_in_with_github,
            commands::sign_out,
            commands::register_device,
            commands::current_device,
            commands::list_roots,
            commands::add_root,
            commands::remove_root,
            commands::set_root_paused,
            commands::scan_root,
            commands::explain_ignore,
            commands::sync_status,
            commands::get_settings,
            commands::set_settings,
            commands::trigger_sync,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Marrow");
}
