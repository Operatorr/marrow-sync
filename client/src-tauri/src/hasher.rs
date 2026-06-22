// SPDX-License-Identifier: AGPL-3.0-only

//! BLAKE3 content hashing (SPEC §9).
//!
//! The hash of a plaintext chunk is both its dedup key and its R2 object key.
//! All hashes are rendered as lowercase hex.

/// Hash a chunk of bytes, returning its lowercase-hex BLAKE3 digest.
pub fn hash_chunk(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_vector_empty() {
        // BLAKE3 of the empty input is a fixed, well-known digest.
        assert_eq!(
            hash_chunk(b""),
            "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"
        );
    }

    #[test]
    fn lowercase_hex_64_chars() {
        let h = hash_chunk(b"marrow");
        assert_eq!(h.len(), 64);
        assert!(h
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn deterministic_and_distinct() {
        assert_eq!(hash_chunk(b"hello world"), hash_chunk(b"hello world"));
        assert_ne!(hash_chunk(b"hello world"), hash_chunk(b"hello worle"));
    }
}
