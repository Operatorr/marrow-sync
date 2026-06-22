// SPDX-License-Identifier: AGPL-3.0-only

//! Device-token storage in the OS secure store (SPEC §10).
//!
//! The raw device token is shown to the client exactly once and persisted *only*
//! here — Keychain on macOS, Credential Manager on Windows, libsecret on Linux —
//! never in a plaintext config file. The server stores only the token hash.
//!
//! The OS-facing logic (set / get / delete, including the `NoEntry` → `None` /
//! idempotent-delete mapping) is factored over the [`SecretStore`] trait so it can
//! be unit-tested against an in-memory store. The `keyring` mock builder hands every
//! `Entry::new` its *own* empty credential, so a real round-trip across separate
//! `Entry` instances is untestable through it — driving the trait directly with one
//! shared store is what actually exercises this module's behavior.

use keyring::Entry;

/// The keychain service name under which Marrow stores secrets.
const SERVICE: &str = "com.marrow.app";
/// The account/username key for the single device token.
const DEVICE_TOKEN_USER: &str = "device-token";

/// Errors from secure-store operations.
#[derive(Debug, thiserror::Error)]
pub enum KeychainError {
    #[error("keychain error: {0}")]
    Keyring(#[from] keyring::Error),
}

/// A minimal secret-store seam over the keyring `Entry` API, so the mapping logic
/// below is testable without touching the real OS store.
trait SecretStore {
    fn set(&self, secret: &str) -> Result<(), keyring::Error>;
    fn get(&self) -> Result<String, keyring::Error>;
    fn delete(&self) -> Result<(), keyring::Error>;
}

impl SecretStore for Entry {
    fn set(&self, secret: &str) -> Result<(), keyring::Error> {
        self.set_password(secret)
    }
    fn get(&self) -> Result<String, keyring::Error> {
        self.get_password()
    }
    fn delete(&self) -> Result<(), keyring::Error> {
        self.delete_credential()
    }
}

/// Persist the device token, overwriting any existing one.
fn store_in(store: &impl SecretStore, token: &str) -> Result<(), KeychainError> {
    store.set(token)?;
    Ok(())
}

/// Read the token, mapping a missing entry to `None`.
fn get_from(store: &impl SecretStore) -> Result<Option<String>, KeychainError> {
    match store.get() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Delete the token; a missing entry is treated as success (idempotent).
fn delete_from(store: &impl SecretStore) -> Result<(), KeychainError> {
    match store.delete() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

fn device_entry() -> Result<Entry, KeychainError> {
    Ok(Entry::new(SERVICE, DEVICE_TOKEN_USER)?)
}

/// Persist the device token in the OS secure store, overwriting any existing one.
pub fn store_device_token(token: &str) -> Result<(), KeychainError> {
    store_in(&device_entry()?, token)
}

/// Read the device token, or `None` if no token has been stored.
pub fn get_device_token() -> Result<Option<String>, KeychainError> {
    get_from(&device_entry()?)
}

/// Delete the stored device token (sign-out / revoke). Idempotent: a missing
/// entry is treated as success.
pub fn delete_device_token() -> Result<(), KeychainError> {
    delete_from(&device_entry()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// A deterministic in-memory store with shared state, unlike the keyring mock
    /// builder (which isolates state per `Entry`). Single-threaded by construction —
    /// each test owns its own instance.
    #[derive(Default)]
    struct MemStore {
        secret: RefCell<Option<String>>,
    }

    impl SecretStore for MemStore {
        fn set(&self, secret: &str) -> Result<(), keyring::Error> {
            *self.secret.borrow_mut() = Some(secret.to_string());
            Ok(())
        }
        fn get(&self) -> Result<String, keyring::Error> {
            match &*self.secret.borrow() {
                Some(s) => Ok(s.clone()),
                None => Err(keyring::Error::NoEntry),
            }
        }
        fn delete(&self) -> Result<(), keyring::Error> {
            match self.secret.borrow_mut().take() {
                Some(_) => Ok(()),
                None => Err(keyring::Error::NoEntry),
            }
        }
    }

    #[test]
    fn store_get_delete_roundtrip() {
        let store = MemStore::default();
        store_in(&store, "secret-token-123").unwrap();
        assert_eq!(
            get_from(&store).unwrap().as_deref(),
            Some("secret-token-123")
        );
        delete_from(&store).unwrap();
        assert!(get_from(&store).unwrap().is_none());
    }

    #[test]
    fn get_missing_is_none() {
        let store = MemStore::default();
        assert!(get_from(&store).unwrap().is_none());
    }

    #[test]
    fn delete_missing_is_ok() {
        let store = MemStore::default();
        // No prior store; idempotent delete must not error.
        delete_from(&store).unwrap();
        delete_from(&store).unwrap();
    }

    #[test]
    fn overwrite_replaces_token() {
        let store = MemStore::default();
        store_in(&store, "first").unwrap();
        store_in(&store, "second").unwrap();
        assert_eq!(get_from(&store).unwrap().as_deref(), Some("second"));
    }
}
