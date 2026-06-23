// SPDX-License-Identifier: AGPL-3.0-only

//! Filesystem watching (SPEC §7 — local activity triggers a sync).
//!
//! Wraps the `notify` crate's recommended watcher and forwards raw events onto a
//! channel. A simple time-window debounce coalesces bursts (editors write many
//! events per save) before a consumer re-scans the affected root.
//!
//! This module is the producer plus the debounce primitive. It is **not yet wired
//! into reconcile**: nothing in [`crate::sync`] consumes these batches today.
//! `TODO(marrow)`: connect the consumer to incremental scan + reconcile, and on an
//! inotify queue overflow force a full rescan of the root.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};

/// Default debounce window: coalesce events that arrive within this span.
pub const DEBOUNCE: Duration = Duration::from_millis(300);

/// A live watcher over one directory tree. Dropping it stops watching.
pub struct RootWatcher {
    _watcher: RecommendedWatcher,
    rx: Receiver<notify::Result<Event>>,
    debounce: Duration,
}

impl RootWatcher {
    /// Begin watching `path` recursively with the default [`DEBOUNCE`] window.
    pub fn watch(path: impl AsRef<Path>) -> notify::Result<Self> {
        Self::watch_with_debounce(path, DEBOUNCE)
    }

    /// Begin watching `path` recursively, coalescing bursts within `debounce`.
    pub fn watch_with_debounce(path: impl AsRef<Path>, debounce: Duration) -> notify::Result<Self> {
        let (tx, rx) = channel();
        let mut watcher = RecommendedWatcher::new(
            move |res| {
                // If the consumer has gone away the channel is disconnected — log it
                // rather than dropping events silently (they signal a real problem,
                // e.g. the watch loop crashed). TODO(marrow): on an inotify queue
                // overflow event, signal a forced full rescan upstream.
                if let Err(e) = tx.send(res) {
                    eprintln!("marrow: watcher channel disconnected, dropping event: {e}");
                }
            },
            Config::default(),
        )?;
        watcher.watch(path.as_ref(), RecursiveMode::Recursive)?;
        Ok(Self {
            _watcher: watcher,
            rx,
            debounce,
        })
    }

    /// Block until at least one event arrives, then drain everything that arrives
    /// within the debounce window, returning the de-duplicated set of changed paths
    /// (with `.git`/`.marrow` paths filtered out).
    ///
    /// Returns `None` if the watcher channel has closed.
    pub fn next_batch(&self) -> Option<Vec<PathBuf>> {
        let first = self.rx.recv().ok()?;
        let mut paths = collect_paths(first);

        let deadline = Instant::now() + self.debounce;
        loop {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            match self.rx.recv_timeout(deadline - now) {
                Ok(ev) => paths.extend(collect_paths(ev)),
                Err(_) => break,
            }
        }

        // Drop engine-internal paths so our own `.marrow` writes (and `.git` churn)
        // can never feed back into the watcher and trigger a self-perpetuating loop.
        paths.retain(|p| !is_internal_path(p));
        paths.sort();
        paths.dedup();
        Some(paths)
    }
}

/// Whether a path contains a `.git` or `.marrow` component — engine-internal churn
/// that must never round-trip back into a scan.
fn is_internal_path(p: &Path) -> bool {
    p.components()
        .any(|c| matches!(c.as_os_str().to_str(), Some(".git") | Some(".marrow")))
}

/// Extract the affected paths from a notify result, logging (not swallowing) errors.
fn collect_paths(res: notify::Result<Event>) -> Vec<PathBuf> {
    match res {
        Ok(event) => event.paths,
        Err(e) => {
            eprintln!("marrow: watcher error event: {e}");
            Vec::new()
        }
    }
}

/// Pure debounce helper: given a stream of (instant, path) events, coalesce those
/// within `window` of the first into a single de-duplicated batch. Factored out so
/// the debounce logic is testable without a real filesystem.
pub fn debounce_paths(events: &[(Instant, PathBuf)], window: Duration) -> Vec<PathBuf> {
    let Some((start, _)) = events.first() else {
        return Vec::new();
    };
    let cutoff = *start + window;
    let mut out: Vec<PathBuf> = events
        .iter()
        .take_while(|(t, _)| *t <= cutoff)
        .map(|(_, p)| p.clone())
        .collect();
    out.sort();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debounce_coalesces_within_window() {
        let t0 = Instant::now();
        let events = vec![
            (t0, PathBuf::from("a.rs")),
            (t0 + Duration::from_millis(50), PathBuf::from("a.rs")),
            (t0 + Duration::from_millis(100), PathBuf::from("b.rs")),
            // Outside the 300ms window — excluded from this batch.
            (t0 + Duration::from_millis(500), PathBuf::from("c.rs")),
        ];
        let batch = debounce_paths(&events, DEBOUNCE);
        assert_eq!(batch, vec![PathBuf::from("a.rs"), PathBuf::from("b.rs")]);
    }

    #[test]
    fn debounce_empty() {
        assert!(debounce_paths(&[], DEBOUNCE).is_empty());
    }

    #[test]
    fn collect_paths_drops_errors() {
        let err: notify::Result<Event> = Err(notify::Error::generic("boom"));
        assert!(collect_paths(err).is_empty());
    }

    #[test]
    fn internal_paths_are_filtered() {
        assert!(is_internal_path(Path::new("repo/.git/HEAD")));
        assert!(is_internal_path(Path::new(".marrow/index.sqlite")));
        assert!(is_internal_path(Path::new("a/b/.marrow/c")));
        // User content that merely mentions the names is not filtered.
        assert!(!is_internal_path(Path::new("src/main.rs")));
        assert!(!is_internal_path(Path::new("docs/gitignore-notes.md")));
        assert!(!is_internal_path(Path::new("marrow.txt")));
    }
}
