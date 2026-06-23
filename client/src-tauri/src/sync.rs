// SPDX-License-Identifier: AGPL-3.0-only

//! Reconcile local ⇄ remote (SPEC §7).
//!
//! The real, tested pieces (ignore/chunker/hasher/index) compose here into a
//! version manifest for a file. Network orchestration — `chunks/check`, the
//! presigned uploads, `commit`, `changes`, downloads — is a typed skeleton marked
//! `TODO(marrow)`; the shapes mirror the `@marrow/shared` protocol so wiring the
//! real HTTP calls later is purely additive.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::chunker::chunk_bytes;
use crate::ignore::{IgnoreEngine, MAX_FILE_SIZE};
use crate::index::{IndexedFile, LocalIndex};

/// A file's "recipe": ordered chunk hashes + metadata. Mirrors the
/// `@marrow/shared` `VersionManifest` shape (camelCase on the wire).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionManifest {
    /// POSIX path relative to the sync root.
    pub path: String,
    pub size: u64,
    /// Source mtime in epoch milliseconds.
    pub mtime: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
    /// Ordered chunk hashes that reassemble the file.
    pub chunks: Vec<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub deleted: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// Build a version manifest for a single file's bytes, chunking + hashing it.
pub fn manifest_for(path: &str, bytes: &[u8], mtime: i64, mode: Option<u32>) -> VersionManifest {
    let chunks = chunk_bytes(bytes);
    VersionManifest {
        path: path.to_string(),
        size: bytes.len() as u64,
        mtime,
        mode,
        chunks: chunks.into_iter().map(|c| c.hash).collect(),
        deleted: false,
    }
}

/// A tombstone manifest for a deleted path.
pub fn tombstone(path: &str, mtime: i64) -> VersionManifest {
    VersionManifest {
        path: path.to_string(),
        size: 0,
        mtime,
        mode: None,
        chunks: Vec::new(),
        deleted: true,
    }
}

/// Result of scanning one root: included file manifests + counters.
///
/// `manifests` holds both live-file manifests and tombstones (for paths that were
/// indexed previously but are now gone). `errors` counts files we could not read
/// or stat — these are *not* folded into `ignored`, which means "excluded by an
/// ignore rule".
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ScanResult {
    pub manifests: Vec<VersionManifest>,
    pub scanned: u64,
    pub included: u64,
    pub ignored: u64,
    /// Files skipped because reading metadata or bytes failed.
    pub errors: u64,
    /// Paths emitted as tombstones (present in the index, absent on disk).
    pub deleted: u64,
    pub bytes: u64,
}

/// Walk a root, apply ignore rules, and build manifests for the included files,
/// using the local index to skip re-chunking unchanged files (by mtime/size).
///
/// This is the real, deterministic core of a scan. The network reconcile that
/// consumes these manifests (`chunks/check` → upload → `commit`) is `TODO(marrow)`.
pub fn scan_root(root: &Path, engine: &IgnoreEngine, index: &mut LocalIndex) -> ScanResult {
    let mut result = ScanResult::default();
    // Every path we observed on disk this pass (whether included or not), so we can
    // diff against the index afterwards and tombstone what disappeared.
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for entry in walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else {
            continue;
        };
        let rel = to_posix(rel);
        result.scanned += 1;
        seen.insert(rel.clone());

        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(e) => {
                // A metadata failure is an error, not an ignore decision — keep the
                // counters honest so the two never get conflated.
                eprintln!("marrow: skipping {rel} (metadata error: {e})");
                result.errors += 1;
                continue;
            }
        };
        let size = meta.len();

        if !engine.is_included(&rel, false, Some(size)) {
            result.ignored += 1;
            continue;
        }

        // Guard the read path: never pull a file larger than the cap into RAM. The
        // ignore engine already excludes oversize files unless a `.marrowignore`
        // negation re-includes them, so re-check here before `fs::read`.
        if size > MAX_FILE_SIZE {
            eprintln!("marrow: skipping {rel} ({size} bytes exceeds MAX_FILE_SIZE)");
            result.errors += 1;
            continue;
        }

        let mtime = mtime_ms(&meta);

        // Incremental: only re-chunk when the file actually changed.
        if !index.is_changed(&rel, mtime, size as i64).unwrap_or(true) {
            if let Ok(Some(existing)) = index.get(&rel) {
                result.included += 1;
                result.bytes += size;
                result.manifests.push(VersionManifest {
                    path: rel,
                    size,
                    mtime,
                    mode: unix_mode(&meta),
                    chunks: existing.chunks,
                    deleted: false,
                });
                continue;
            }
        }

        let bytes = match std::fs::read(entry.path()) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("marrow: skipping {rel} (read error: {e})");
                result.errors += 1;
                continue;
            }
        };
        let manifest = manifest_for(&rel, &bytes, mtime, unix_mode(&meta));
        if let Err(e) = index.put(&IndexedFile {
            path: rel.clone(),
            mtime,
            size: size as i64,
            chunks: manifest.chunks.clone(),
        }) {
            // Could not record the file in the index: count it as an error and do
            // NOT emit a manifest for it, keeping counters consistent with what was
            // actually persisted/emitted.
            eprintln!("marrow: index put failed for {rel}: {e}");
            result.errors += 1;
            continue;
        }
        result.included += 1;
        result.bytes += size;
        result.manifests.push(manifest);
    }

    // Deletion detection: any path the index knows about but we did NOT see on disk
    // this pass has been deleted — emit a tombstone and drop it from the index so
    // the deletion propagates (SPEC §7). Without this, deletions never sync.
    if let Ok(known) = index.paths() {
        let now = now_ms();
        for path in known {
            if !seen.contains(&path) {
                result.manifests.push(tombstone(&path, now));
                if let Err(e) = index.remove(&path) {
                    eprintln!("marrow: index remove failed for {path}: {e}");
                }
                result.deleted += 1;
            }
        }
    }

    result
}

fn to_posix(p: &Path) -> String {
    p.components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Current wall-clock time in epoch milliseconds (for tombstone mtimes).
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(unix)]
fn unix_mode(meta: &std::fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::MetadataExt;
    // Mask to the permission bits only (`& 0o7777`): drop the file-type bits from
    // `st_mode` so the manifest carries "Unix permission bits" per the protocol,
    // and so the type bits never reach `set_permissions` on the (TODO) write path.
    Some(meta.mode() & 0o7777)
}

#[cfg(not(unix))]
fn unix_mode(_meta: &std::fs::Metadata) -> Option<u32> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn manifest_has_at_least_one_chunk() {
        let m = manifest_for("a.txt", b"hello", 1, None);
        assert_eq!(m.size, 5);
        assert_eq!(m.chunks.len(), 1);
        assert!(!m.deleted);
    }

    #[test]
    fn tombstone_is_empty_and_deleted() {
        let m = tombstone("gone.txt", 9);
        assert!(m.deleted);
        assert!(m.chunks.is_empty());
        assert_eq!(m.size, 0);
    }

    #[test]
    fn manifest_serializes_camelcase_and_omits_defaults() {
        let m = manifest_for("a.txt", b"hi", 1, None);
        let v = serde_json::to_value(&m).unwrap();
        assert!(v.get("deleted").is_none(), "deleted=false omitted");
        assert!(v.get("mode").is_none(), "None mode omitted");
        assert_eq!(v["path"], "a.txt");
    }

    #[test]
    fn scan_root_respects_ignore_and_indexes() {
        let td = TempDir::new().unwrap();
        let root = td.path();
        fs::write(root.join(".gitignore"), "ignored.txt\n").unwrap();
        fs::write(root.join("kept.txt"), "keep me").unwrap();
        fs::write(root.join("ignored.txt"), "skip me").unwrap();

        let engine = IgnoreEngine::new(root).unwrap();
        let mut index = LocalIndex::in_memory().unwrap();
        let res = scan_root(root, &engine, &mut index);

        // kept.txt + .gitignore are included; ignored.txt is not.
        let paths: Vec<_> = res.manifests.iter().map(|m| m.path.as_str()).collect();
        assert!(paths.contains(&"kept.txt"));
        assert!(!paths.contains(&"ignored.txt"));
        assert_eq!(res.ignored, 1);
        assert!(index.get("kept.txt").unwrap().is_some());
    }

    #[test]
    fn scan_root_is_incremental_second_pass() {
        let td = TempDir::new().unwrap();
        let root = td.path();
        fs::write(root.join("a.txt"), "content").unwrap();

        let engine = IgnoreEngine::new(root).unwrap();
        let mut index = LocalIndex::in_memory().unwrap();

        let first = scan_root(root, &engine, &mut index);
        let second = scan_root(root, &engine, &mut index);
        // Same manifests both passes (the second pulls chunks from the index).
        assert_eq!(first.manifests, second.manifests);
    }

    #[test]
    fn scan_root_emits_tombstone_for_deleted_file() {
        let td = TempDir::new().unwrap();
        let root = td.path();
        fs::write(root.join("a.txt"), "alpha").unwrap();
        fs::write(root.join("b.txt"), "bravo").unwrap();

        let engine = IgnoreEngine::new(root).unwrap();
        let mut index = LocalIndex::in_memory().unwrap();

        // First pass indexes both files, no tombstones.
        let first = scan_root(root, &engine, &mut index);
        assert_eq!(first.deleted, 0);
        assert_eq!(first.included, 2);

        // Delete one file, then re-scan.
        fs::remove_file(root.join("a.txt")).unwrap();
        let second = scan_root(root, &engine, &mut index);

        assert_eq!(second.deleted, 1, "one file disappeared");
        let tombstones: Vec<_> = second
            .manifests
            .iter()
            .filter(|m| m.deleted)
            .map(|m| m.path.as_str())
            .collect();
        assert_eq!(tombstones, vec!["a.txt"]);
        // The deleted path is dropped from the index, so a third pass is quiet.
        assert!(index.get("a.txt").unwrap().is_none());
        let third = scan_root(root, &engine, &mut index);
        assert_eq!(third.deleted, 0);
    }

    #[cfg(unix)]
    #[test]
    fn manifest_mode_is_masked_to_permission_bits() {
        let td = TempDir::new().unwrap();
        let root = td.path();
        fs::write(root.join("x.sh"), "echo hi").unwrap();

        let engine = IgnoreEngine::new(root).unwrap();
        let mut index = LocalIndex::in_memory().unwrap();
        let res = scan_root(root, &engine, &mut index);

        let m = res
            .manifests
            .iter()
            .find(|m| m.path == "x.sh")
            .expect("x.sh manifest");
        let mode = m.mode.expect("unix mode present");
        // No file-type bits (e.g. S_IFREG 0o100000) should survive the mask.
        assert_eq!(mode, mode & 0o7777);
    }
}
