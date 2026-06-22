// SPDX-License-Identifier: AGPL-3.0-only

//! Chunk transfer to/from R2 via presigned URLs (SPEC §7).
//!
//! The server never proxies chunk bytes; it only brokers presigned URLs. These
//! helpers are pure functions over a URL + bytes so they can be composed by
//! [`crate::sync`] without owning any client state beyond a shared [`reqwest::Client`].

/// Errors from chunk transfer.
#[derive(Debug, thiserror::Error)]
pub enum TransferError {
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("unexpected status {status} from {url}")]
    Status { status: u16, url: String },
}

/// Upload one chunk's bytes to its presigned PUT URL (SPEC §7 upload flow step 3).
pub async fn put_chunk(
    client: &reqwest::Client,
    upload_url: &str,
    bytes: Vec<u8>,
) -> Result<(), TransferError> {
    let resp = client
        .put(upload_url)
        .header("content-type", "application/octet-stream")
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

/// Download one chunk's bytes from its presigned GET URL (SPEC §7 download flow).
pub async fn get_chunk(
    client: &reqwest::Client,
    download_url: &str,
) -> Result<Vec<u8>, TransferError> {
    let resp = client.get(download_url).send().await?;
    if !resp.status().is_success() {
        return Err(TransferError::Status {
            status: resp.status().as_u16(),
            url: download_url.to_string(),
        });
    }
    Ok(resp.bytes().await?.to_vec())
}

/// Reassemble a file's bytes from its chunks in manifest order.
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
}
