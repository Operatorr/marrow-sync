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
use crate::ignore::IgnoreEngine;
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
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ScanResult {
    pub manifests: Vec<VersionManifest>,
    pub scanned: u64,
    pub included: u64,
    pub ignored: u64,
    pub bytes: u64,
}

/// Walk a root, apply ignore rules, and build manifests for the included files,
/// using the local index to skip re-chunking unchanged files (by mtime/size).
///
/// This is the real, deterministic core of a scan. The network reconcile that
/// consumes these manifests (`chunks/check` → upload → `commit`) is `TODO(marrow)`.
pub fn scan_root(root: &Path, engine: &IgnoreEngine, index: &mut LocalIndex) -> ScanResult {
    let mut result = ScanResult::default();

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

        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => {
                result.ignored += 1;
                continue;
            }
        };
        let size = meta.len();

        if !engine.is_included(&rel, false, Some(size)) {
            result.ignored += 1;
            continue;
        }

        let mtime = mtime_ms(&meta);
        result.included += 1;
        result.bytes += size;

        // Incremental: only re-chunk when the file actually changed.
        if !index.is_changed(&rel, mtime, size as i64).unwrap_or(true) {
            if let Ok(Some(existing)) = index.get(&rel) {
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
            Err(_) => continue,
        };
        let manifest = manifest_for(&rel, &bytes, mtime, unix_mode(&meta));
        let _ = index.put(&IndexedFile {
            path: rel,
            mtime,
            size: size as i64,
            chunks: manifest.chunks.clone(),
        });
        result.manifests.push(manifest);
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

#[cfg(unix)]
fn unix_mode(meta: &std::fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::MetadataExt;
    Some(meta.mode())
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
}
