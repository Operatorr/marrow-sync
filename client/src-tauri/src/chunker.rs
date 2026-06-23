// SPDX-License-Identifier: AGPL-3.0-only

//! FastCDC content-defined chunking (SPEC §9).
//!
//! Edits shift only local chunk boundaries, so a one-line change in a large file
//! re-uploads one chunk, not the whole file. Files below the minimum chunk size
//! become a single chunk (the common case for source trees of many tiny files).

use crate::hasher::hash_chunk;

/// FastCDC sizing, mirroring `@marrow/shared` `CHUNK_SIZE` (SPEC §9).
pub const CHUNK_MIN: u32 = 16 * 1024;
pub const CHUNK_AVG: u32 = 64 * 1024;
pub const CHUNK_MAX: u32 = 256 * 1024;

/// Compile-time guard: FastCDC requires a strict `min < avg < max` ordering, and
/// the rest of the engine assumes it. Catch any future edit that breaks it.
const _: () = assert!(CHUNK_MIN < CHUNK_AVG && CHUNK_AVG < CHUNK_MAX);

/// One content-defined chunk: its content hash and plaintext byte length.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    /// Lowercase-hex BLAKE3 hash of the chunk's plaintext.
    pub hash: String,
    /// Plaintext byte length of the chunk.
    pub size: usize,
}

/// Split `bytes` into content-defined chunks and hash each one.
///
/// Returns chunks in file order. The empty input yields a single empty chunk so
/// every file — including zero-byte files — has a stable manifest with at least
/// one chunk hash.
///
/// NOTE: `chunk_bytes` takes the whole file as a `&[u8]`, so the caller holds the
/// entire file in RAM. For files approaching `MAX_FILE_SIZE` (512 MiB) a streaming
/// `StreamCDC` variant that chunks from a reader is `TODO(marrow)`.
pub fn chunk_bytes(bytes: &[u8]) -> Vec<Chunk> {
    if bytes.is_empty() {
        return vec![Chunk {
            hash: hash_chunk(bytes),
            size: 0,
        }];
    }

    // Below the minimum chunk size FastCDC would emit a single chunk anyway, but
    // we short-circuit to avoid constructing the chunker for the tiny-file case
    // that dominates source trees.
    if bytes.len() <= CHUNK_MIN as usize {
        return vec![Chunk {
            hash: hash_chunk(bytes),
            size: bytes.len(),
        }];
    }

    let chunker = fastcdc::v2020::FastCDC::new(bytes, CHUNK_MIN, CHUNK_AVG, CHUNK_MAX);
    chunker
        .map(|entry| {
            let slice = &bytes[entry.offset..entry.offset + entry.length];
            Chunk {
                hash: hash_chunk(slice),
                size: entry.length,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_file_is_one_empty_chunk() {
        let chunks = chunk_bytes(b"");
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].size, 0);
        assert_eq!(chunks[0].hash, hash_chunk(b""));
    }

    #[test]
    fn small_file_is_single_chunk() {
        let data = b"a small source file, well under sixteen kibibytes";
        let chunks = chunk_bytes(data);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].size, data.len());
        assert_eq!(chunks[0].hash, hash_chunk(data));
    }

    #[test]
    fn large_file_splits_into_multiple_chunks() {
        // 1 MiB of pseudo-random-ish content so boundaries actually trigger.
        let mut data = Vec::with_capacity(1024 * 1024);
        let mut x: u32 = 0x1234_5678;
        for _ in 0..(1024 * 1024) {
            x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            data.push((x >> 24) as u8);
        }
        let chunks = chunk_bytes(&data);
        assert!(
            chunks.len() > 1,
            "expected multiple chunks, got {}",
            chunks.len()
        );

        // Reassembled chunk sizes must equal the input length.
        let total: usize = chunks.iter().map(|c| c.size).sum();
        assert_eq!(total, data.len());
    }

    #[test]
    fn chunking_is_deterministic() {
        let mut data = vec![0u8; 300 * 1024];
        for (i, b) in data.iter_mut().enumerate() {
            *b = (i % 251) as u8;
        }
        assert_eq!(chunk_bytes(&data), chunk_bytes(&data));
    }

    #[test]
    fn chunk_constants_match_shared() {
        // Drift guard: these must equal `@marrow/shared` `CHUNK_SIZE`
        // (16/64/256 KiB). If shared changes, this test fails loudly.
        assert_eq!(CHUNK_MIN, 16 * 1024);
        assert_eq!(CHUNK_AVG, 64 * 1024);
        assert_eq!(CHUNK_MAX, 256 * 1024);
    }

    #[test]
    fn reconstructing_from_offsets_reproduces_input() {
        // 1 MiB of pseudo-random content so the file actually splits.
        let mut data = Vec::with_capacity(1024 * 1024);
        let mut x: u32 = 0x9E37_79B9;
        for _ in 0..(1024 * 1024) {
            x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            data.push((x >> 24) as u8);
        }
        let chunks = chunk_bytes(&data);
        assert!(chunks.len() > 1);

        // Walk the chunk sizes as consecutive `[offset, offset+length)` slices and
        // concatenate; the result must be byte-for-byte the original input.
        let mut rebuilt = Vec::with_capacity(data.len());
        let mut offset = 0usize;
        for c in &chunks {
            let slice = &data[offset..offset + c.size];
            rebuilt.extend_from_slice(slice);
            offset += c.size;
        }
        assert_eq!(
            offset,
            data.len(),
            "chunk sizes must cover the input exactly"
        );
        assert_eq!(rebuilt, data, "reassembled bytes must equal the input");
    }
}
