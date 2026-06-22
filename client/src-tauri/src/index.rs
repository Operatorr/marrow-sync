// SPDX-License-Identifier: AGPL-3.0-only

//! The local SQLite index (SPEC §9).
//!
//! Maps each synced `path` to its `(mtime, size, version manifest of chunk
//! hashes)` so re-scans are incremental: a file is only re-chunked when its
//! `mtime` or `size` differs from what the index recorded.

use rusqlite::{params, Connection, OptionalExtension};

/// A file's recorded state in the local index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexedFile {
    /// POSIX path relative to the sync root.
    pub path: String,
    /// Source mtime in epoch milliseconds.
    pub mtime: i64,
    /// File size in bytes.
    pub size: i64,
    /// Ordered chunk hashes that reassemble the file (the version manifest).
    pub chunks: Vec<String>,
}

/// The local index, backed by SQLite (bundled). Use [`LocalIndex::open`] for a
/// persistent on-disk index or [`LocalIndex::in_memory`] for tests.
pub struct LocalIndex {
    conn: Connection,
}

impl LocalIndex {
    /// Open (creating if needed) a persistent index at `path`.
    pub fn open(path: impl AsRef<std::path::Path>) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        Self::from_conn(conn)
    }

    /// Open an ephemeral in-memory index (used by tests).
    pub fn in_memory() -> rusqlite::Result<Self> {
        Self::from_conn(Connection::open_in_memory()?)
    }

    fn from_conn(conn: Connection) -> rusqlite::Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS file (
                 path   TEXT PRIMARY KEY,
                 mtime  INTEGER NOT NULL,
                 size   INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS file_chunk (
                 path  TEXT NOT NULL REFERENCES file(path) ON DELETE CASCADE,
                 idx   INTEGER NOT NULL,
                 hash  TEXT NOT NULL,
                 PRIMARY KEY (path, idx)
             );",
        )?;
        Ok(Self { conn })
    }

    /// Insert or replace a file's recorded state and its ordered chunk manifest.
    pub fn put(&mut self, file: &IndexedFile) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO file (path, mtime, size) VALUES (?1, ?2, ?3)
             ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size",
            params![file.path, file.mtime, file.size],
        )?;
        tx.execute("DELETE FROM file_chunk WHERE path = ?1", params![file.path])?;
        {
            let mut stmt =
                tx.prepare("INSERT INTO file_chunk (path, idx, hash) VALUES (?1, ?2, ?3)")?;
            for (i, hash) in file.chunks.iter().enumerate() {
                stmt.execute(params![file.path, i as i64, hash])?;
            }
        }
        tx.commit()
    }

    /// Fetch a file's recorded state, or `None` if not indexed.
    pub fn get(&self, path: &str) -> rusqlite::Result<Option<IndexedFile>> {
        let row = self
            .conn
            .query_row(
                "SELECT mtime, size FROM file WHERE path = ?1",
                params![path],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
            )
            .optional()?;
        let Some((mtime, size)) = row else {
            return Ok(None);
        };

        let mut stmt = self
            .conn
            .prepare("SELECT hash FROM file_chunk WHERE path = ?1 ORDER BY idx")?;
        let chunks = stmt
            .query_map(params![path], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        Ok(Some(IndexedFile {
            path: path.to_string(),
            mtime,
            size,
            chunks,
        }))
    }

    /// Remove a file from the index (e.g. on deletion). Idempotent.
    pub fn remove(&mut self, path: &str) -> rusqlite::Result<()> {
        self.conn
            .execute("DELETE FROM file WHERE path = ?1", params![path])?;
        Ok(())
    }

    /// All indexed paths, sorted. Useful for detecting deletions during a re-scan.
    pub fn paths(&self) -> rusqlite::Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT path FROM file ORDER BY path")?;
        let paths = stmt.query_map([], |r| r.get::<_, String>(0))?.collect();
        paths
    }

    /// Incremental-scan predicate: does the on-disk `(mtime, size)` differ from the
    /// indexed state? `true` means the file must be re-chunked. An unknown path is
    /// always considered changed.
    pub fn is_changed(&self, path: &str, mtime: i64, size: i64) -> rusqlite::Result<bool> {
        match self.get(path)? {
            Some(existing) => Ok(existing.mtime != mtime || existing.size != size),
            None => Ok(true),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> IndexedFile {
        IndexedFile {
            path: "src/main.rs".into(),
            mtime: 1_700_000_000_000,
            size: 42,
            chunks: vec!["aaaa".into(), "bbbb".into()],
        }
    }

    #[test]
    fn put_then_get_roundtrips_manifest_order() {
        let mut idx = LocalIndex::in_memory().unwrap();
        let f = sample();
        idx.put(&f).unwrap();
        let got = idx.get("src/main.rs").unwrap().unwrap();
        assert_eq!(got, f);
        assert_eq!(got.chunks, vec!["aaaa".to_string(), "bbbb".to_string()]);
    }

    #[test]
    fn get_missing_is_none() {
        let idx = LocalIndex::in_memory().unwrap();
        assert!(idx.get("nope").unwrap().is_none());
    }

    #[test]
    fn put_replaces_chunks_not_appends() {
        let mut idx = LocalIndex::in_memory().unwrap();
        idx.put(&sample()).unwrap();
        let updated = IndexedFile {
            path: "src/main.rs".into(),
            mtime: 1_700_000_001_000,
            size: 10,
            chunks: vec!["cccc".into()],
        };
        idx.put(&updated).unwrap();
        let got = idx.get("src/main.rs").unwrap().unwrap();
        assert_eq!(got.chunks, vec!["cccc".to_string()]);
        assert_eq!(got.size, 10);
    }

    #[test]
    fn is_changed_detects_mtime_and_size() {
        let mut idx = LocalIndex::in_memory().unwrap();
        idx.put(&sample()).unwrap();
        assert!(!idx
            .is_changed("src/main.rs", 1_700_000_000_000, 42)
            .unwrap());
        assert!(idx
            .is_changed("src/main.rs", 1_700_000_000_001, 42)
            .unwrap());
        assert!(idx
            .is_changed("src/main.rs", 1_700_000_000_000, 43)
            .unwrap());
        assert!(idx.is_changed("unknown", 0, 0).unwrap());
    }

    #[test]
    fn remove_and_paths() {
        let mut idx = LocalIndex::in_memory().unwrap();
        idx.put(&sample()).unwrap();
        idx.put(&IndexedFile {
            path: "README.md".into(),
            mtime: 1,
            size: 2,
            chunks: vec!["dddd".into()],
        })
        .unwrap();
        assert_eq!(
            idx.paths().unwrap(),
            vec!["README.md".to_string(), "src/main.rs".to_string()]
        );
        idx.remove("src/main.rs").unwrap();
        assert_eq!(idx.paths().unwrap(), vec!["README.md".to_string()]);
        // Cascade removed the chunk rows.
        assert!(idx.get("src/main.rs").unwrap().is_none());
    }

    #[test]
    fn remove_is_idempotent() {
        let mut idx = LocalIndex::in_memory().unwrap();
        idx.remove("ghost").unwrap();
        idx.remove("ghost").unwrap();
    }
}
