// SPDX-License-Identifier: AGPL-3.0-only

//! Filesystem watching (SPEC §7 — local activity triggers a sync).
//!
//! Wraps the `notify` crate's recommended watcher and forwards raw events onto a
//! channel. A simple time-window debounce coalesces bursts (editors write many
//! events per save) before a consumer re-scans the affected root.
//!
//! The orchestration that consumes debounced batches lives in [`crate::sync`];
//! this module is the producer plus the debounce primitive. `TODO(marrow)`: wire
//! the consumer to incremental scan + reconcile.

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
}

impl RootWatcher {
    /// Begin watching `path` recursively.
    pub fn watch(path: impl AsRef<Path>) -> notify::Result<Self> {
        let (tx, rx) = channel();
        let mut watcher = RecommendedWatcher::new(
            move |res| {
                // If the consumer has gone away, drop the event silently.
                let _ = tx.send(res);
            },
            Config::default(),
        )?;
        watcher.watch(path.as_ref(), RecursiveMode::Recursive)?;
        Ok(Self {
            _watcher: watcher,
            rx,
        })
    }

    /// Block until at least one event arrives, then drain everything that arrives
    /// within [`DEBOUNCE`], returning the de-duplicated set of changed paths.
    ///
    /// Returns `None` if the watcher channel has closed.
    pub fn next_batch(&self) -> Option<Vec<PathBuf>> {
        let first = self.rx.recv().ok()?;
        let mut paths = collect_paths(first);

        let deadline = Instant::now() + DEBOUNCE;
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

        paths.sort();
        paths.dedup();
        Some(paths)
    }
}

/// Extract the affected paths from a notify result, ignoring errors.
fn collect_paths(res: notify::Result<Event>) -> Vec<PathBuf> {
    match res {
        Ok(event) => event.paths,
        Err(_) => Vec::new(),
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
}
