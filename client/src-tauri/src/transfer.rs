// SPDX-License-Identifier: AGPL-3.0-only

//! Chunk transfer to/from R2 via presigned URLs (SPEC §7).
//!
//! The server never proxies chunk bytes; it only brokers presigned URLs. These
//! helpers are pure functions over a URL + bytes so they can be composed by
//! [`crate::sync`] without owning any client state beyond a shared [`reqwest::Client`].
//!
//! TODO(marrow): bounded retry/backoff on 5xx and timeouts, plus refreshing a
//! presigned URL after a 403 expiry, are not yet implemented here.

use std::time::Duration;

use crate::hasher;

/// Per-request timeout for a single chunk transfer.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Errors from chunk transfer.
#[derive(Debug, thiserror::Error)]
pub enum TransferError {
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("unexpected status {status} from {url}")]
    Status { status: u16, url: String },
    #[error("insecure transfer URL (https required): {0}")]
    InsecureUrl(String),
    #[error("chunk hash mismatch: expected {expected}, got {actual}")]
    HashMismatch { expected: String, actual: String },
}

/// Reject any non-`https` presigned URL. Chunk bytes (and the presigned
/// credentials in the query string) must never travel in clear text.
fn require_https(url: &str) -> Result<(), TransferError> {
    if url.starts_with("https://") {
        Ok(())
    } else {
        Err(TransferError::InsecureUrl(url.to_string()))
    }
}

/// Upload one chunk's bytes to its presigned PUT URL (SPEC §7 upload flow step 3).
pub async fn put_chunk(
    client: &reqwest::Client,
    upload_url: &str,
    bytes: Vec<u8>,
) -> Result<(), TransferError> {
    require_https(upload_url)?;
    let resp = client
        .put(upload_url)
        .header("content-type", "application/octet-stream")
        .timeout(REQUEST_TIMEOUT)
        .body(bytes)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(TransferError::Status {
            status: resp.status().as_u16(),
            url: upload_url.to_string(),
        });
    }
    Ok(())
}

/// Download one chunk's bytes from its presigned GET URL (SPEC §7 download flow)
/// and verify them against `expected_hash` (the chunk's content address) before
/// returning. A mismatch means corruption or a wrong object and is an error — we
/// never hand back unverified bytes for reassembly.
pub async fn get_chunk(
    client: &reqwest::Client,
    download_url: &str,
    expected_hash: &str,
) -> Result<Vec<u8>, TransferError> {
    require_https(download_url)?;
    let resp = client
        .get(download_url)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(TransferError::Status {
            status: resp.status().as_u16(),
            url: download_url.to_string(),
        });
    }
    let bytes = resp.bytes().await?.to_vec();
    let actual = hasher::hash_chunk(&bytes);
    if actual != expected_hash {
        return Err(TransferError::HashMismatch {
            expected: expected_hash.to_string(),
            actual,
        });
    }
    Ok(bytes)
}

/// Reassemble a file's bytes from its chunks in manifest order.
///
/// Per-chunk integrity is verified at the download boundary by [`get_chunk`]
/// (content-address check). If the caller knows the manifest's total size it
/// should also assert `reassemble(...).len() == manifest.size` after this returns.
pub fn reassemble(chunks: &[Vec<u8>]) -> Vec<u8> {
    let total: usize = chunks.iter().map(Vec::len).sum();
    let mut out = Vec::with_capacity(total);
    for c in chunks {
        out.extend_from_slice(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reassemble_concatenates_in_order() {
        let parts = vec![
            b"abc".to_vec(),
            b"def".to_vec(),
            b"".to_vec(),
            b"g".to_vec(),
        ];
        assert_eq!(reassemble(&parts), b"abcdefg".to_vec());
    }

    #[test]
    fn reassemble_empty() {
        assert_eq!(reassemble(&[]), Vec::<u8>::new());
    }

    #[test]
    fn require_https_rejects_insecure_schemes() {
        assert!(require_https("https://r2.example.com/abc").is_ok());
        assert!(matches!(
            require_https("http://r2.example.com/abc"),
            Err(TransferError::InsecureUrl(_))
        ));
        assert!(matches!(
            require_https("ftp://r2.example.com/abc"),
            Err(TransferError::InsecureUrl(_))
        ));
    }
}
