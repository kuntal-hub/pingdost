use std::sync::{Mutex, MutexGuard};

use vodozemac::megolm::SessionKeyDecodeError;
use vodozemac::olm::{DecryptionError, EncryptionError, SessionCreationError};
use vodozemac::{KeyError, PickleError, SignatureError, megolm};

/// Errors returned across the FFI. Messages are fixed strings: they never contain key
/// material, plaintext or ciphertext (ARCHITECTURE A10).
#[derive(Debug, thiserror::Error, uniffi::Error)]
#[uniffi(flat_error)]
pub enum CryptoError {
    #[error("invalid key: {0}")]
    InvalidKey(&'static str),
    #[error("invalid message: {0}")]
    InvalidMessage(&'static str),
    #[error("invalid signature")]
    InvalidSignature,
    #[error("session creation failed: {0}")]
    SessionCreation(&'static str),
    #[error("encryption failed: {0}")]
    Encryption(&'static str),
    #[error("decryption failed: {0}")]
    Decryption(&'static str),
    #[error("pickle failed: {0}")]
    Pickle(&'static str),
    #[error("invalid argument: {0}")]
    InvalidArgument(&'static str),
    #[error("internal error: {0}")]
    Internal(&'static str),
}

impl From<KeyError> for CryptoError {
    fn from(_: KeyError) -> Self {
        Self::InvalidKey("malformed key")
    }
}

impl From<SignatureError> for CryptoError {
    fn from(_: SignatureError) -> Self {
        Self::InvalidSignature
    }
}

impl From<PickleError> for CryptoError {
    fn from(_: PickleError) -> Self {
        Self::Pickle("wrong pickle key or corrupted pickle")
    }
}

impl From<SessionKeyDecodeError> for CryptoError {
    fn from(_: SessionKeyDecodeError) -> Self {
        Self::InvalidKey("malformed or unsigned group session key")
    }
}

impl From<EncryptionError> for CryptoError {
    fn from(error: EncryptionError) -> Self {
        match error {
            EncryptionError::NonContributoryKey => {
                Self::Encryption("non-contributory key exchange")
            }
        }
    }
}

impl From<DecryptionError> for CryptoError {
    fn from(error: DecryptionError) -> Self {
        Self::Decryption(match error {
            DecryptionError::InvalidMAC(_) => "authentication failed",
            DecryptionError::InvalidMACLength(..) => "invalid MAC length",
            DecryptionError::InvalidPadding(_) => "invalid padding",
            DecryptionError::NonContributoryKey => "non-contributory key exchange",
            DecryptionError::MissingMessageKey(_) => {
                "message key unavailable (replayed or too old)"
            }
            DecryptionError::TooBigMessageGap(..) => "too many skipped messages",
        })
    }
}

impl From<SessionCreationError> for CryptoError {
    fn from(error: SessionCreationError) -> Self {
        match error {
            SessionCreationError::MissingOneTimeKey(_) => {
                Self::SessionCreation("unknown or already used one-time key")
            }
            SessionCreationError::MismatchedIdentityKey(..) => {
                Self::SessionCreation("identity key does not match the pre-key message")
            }
            SessionCreationError::MismatchedSessionConfig { .. } => {
                Self::SessionCreation("unsupported session version")
            }
            SessionCreationError::Decryption(error) => error.into(),
            SessionCreationError::NonContributoryKey => {
                Self::SessionCreation("non-contributory key exchange")
            }
        }
    }
}

impl From<megolm::DecryptionError> for CryptoError {
    fn from(error: megolm::DecryptionError) -> Self {
        Self::Decryption(match error {
            megolm::DecryptionError::Signature(_) => "invalid sender signature",
            megolm::DecryptionError::InvalidMAC(_) => "authentication failed",
            megolm::DecryptionError::InvalidMACLength(..) => "invalid MAC length",
            megolm::DecryptionError::InvalidPadding(_) => "invalid padding",
            megolm::DecryptionError::UnknownMessageIndex(..) => {
                "message index is before this session's first known index"
            }
        })
    }
}

/// Locks wrapped vodozemac state. A poisoned lock means an earlier call panicked
/// mid-update, so the state is not trusted again.
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, CryptoError> {
    mutex
        .lock()
        .map_err(|_| CryptoError::Internal("state lock poisoned"))
}

pub(crate) fn parse_pickle_key(key: &[u8]) -> Result<[u8; 32], CryptoError> {
    key.try_into()
        .map_err(|_| CryptoError::InvalidArgument("pickle key must be 32 bytes"))
}
