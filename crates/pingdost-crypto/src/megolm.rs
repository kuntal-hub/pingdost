//! Megolm for groups: one outbound session per sender, shared to members over Olm.

use std::sync::Mutex;

use vodozemac::megolm::{self as vz, ExportedSessionKey, MegolmMessage, SessionConfig, SessionKey};

use crate::error::{CryptoError, lock, parse_pickle_key};

/// Stable, Matrix-compatible Megolm v1.
const SESSION_CONFIG: SessionConfig = SessionConfig::version_1();

#[derive(Debug, Clone, uniffi::Record)]
pub struct GroupDecryptResult {
    pub plaintext: Vec<u8>,
    /// Ratchet position of the message. Megolm does not reject replays by itself:
    /// callers must reject a (session ID, message index) pair they have already seen.
    pub message_index: u32,
}

/// The sending side of a Megolm session.
#[derive(uniffi::Object)]
pub struct GroupSession {
    inner: Mutex<vz::GroupSession>,
}

impl Default for GroupSession {
    fn default() -> Self {
        Self::new()
    }
}

#[uniffi::export]
impl GroupSession {
    #[uniffi::constructor]
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(vz::GroupSession::new(SESSION_CONFIG)),
        }
    }

    #[uniffi::constructor]
    pub fn from_pickle(pickle: String, pickle_key: Vec<u8>) -> Result<Self, CryptoError> {
        let key = parse_pickle_key(&pickle_key)?;
        let pickle = vz::GroupSessionPickle::from_encrypted(&pickle, &key)?;
        Ok(Self {
            inner: Mutex::new(vz::GroupSession::from_pickle(pickle)),
        })
    }

    pub fn session_id(&self) -> Result<String, CryptoError> {
        Ok(lock(&self.inner)?.session_id())
    }

    /// The signed session key at the current index (base64). Secret: share it only
    /// over Olm with current members.
    pub fn session_key(&self) -> Result<String, CryptoError> {
        Ok(lock(&self.inner)?.session_key().to_base64())
    }

    /// The index the next encrypted message will use.
    pub fn message_index(&self) -> Result<u32, CryptoError> {
        Ok(lock(&self.inner)?.message_index())
    }

    pub fn encrypt(&self, plaintext: Vec<u8>) -> Result<Vec<u8>, CryptoError> {
        Ok(lock(&self.inner)?.encrypt(&plaintext).to_bytes())
    }

    pub fn pickle(&self, pickle_key: Vec<u8>) -> Result<String, CryptoError> {
        let key = parse_pickle_key(&pickle_key)?;
        Ok(lock(&self.inner)?.pickle().encrypt(&key))
    }
}

/// The receiving side of a Megolm session.
#[derive(uniffi::Object)]
pub struct InboundGroupSession {
    inner: Mutex<vz::InboundGroupSession>,
}

#[uniffi::export]
impl InboundGroupSession {
    /// Creates a session from a signed session key received over Olm.
    #[uniffi::constructor]
    pub fn new(session_key: String) -> Result<Self, CryptoError> {
        let key = SessionKey::from_base64(&session_key)?;
        Ok(Self {
            inner: Mutex::new(vz::InboundGroupSession::new(&key, SESSION_CONFIG)),
        })
    }

    /// Creates a session from an exported (unsigned) key, e.g. from `export_at`.
    #[uniffi::constructor]
    pub fn from_exported_key(exported_key: String) -> Result<Self, CryptoError> {
        let key = ExportedSessionKey::from_base64(&exported_key)?;
        Ok(Self {
            inner: Mutex::new(vz::InboundGroupSession::import(&key, SESSION_CONFIG)),
        })
    }

    #[uniffi::constructor]
    pub fn from_pickle(pickle: String, pickle_key: Vec<u8>) -> Result<Self, CryptoError> {
        let key = parse_pickle_key(&pickle_key)?;
        let pickle = vz::InboundGroupSessionPickle::from_encrypted(&pickle, &key)?;
        Ok(Self {
            inner: Mutex::new(vz::InboundGroupSession::from_pickle(pickle)),
        })
    }

    pub fn session_id(&self) -> Result<String, CryptoError> {
        Ok(lock(&self.inner)?.session_id())
    }

    /// The earliest message index this session can decrypt.
    pub fn first_known_index(&self) -> Result<u32, CryptoError> {
        Ok(lock(&self.inner)?.first_known_index())
    }

    pub fn decrypt(&self, message: Vec<u8>) -> Result<GroupDecryptResult, CryptoError> {
        let message = MegolmMessage::from_bytes(&message)
            .map_err(|_| CryptoError::InvalidMessage("malformed Megolm message"))?;
        let decrypted = lock(&self.inner)?.decrypt(&message)?;
        Ok(GroupDecryptResult {
            plaintext: decrypted.plaintext,
            message_index: decrypted.message_index,
        })
    }

    /// Exports the session from `index` onwards (base64), so a new member cannot read
    /// earlier messages. None if this session cannot reach `index`.
    pub fn export_at(&self, index: u32) -> Result<Option<String>, CryptoError> {
        Ok(lock(&self.inner)?
            .export_at(index)
            .map(|key| key.to_base64()))
    }

    pub fn export_at_first_known_index(&self) -> Result<String, CryptoError> {
        Ok(lock(&self.inner)?.export_at_first_known_index().to_base64())
    }

    pub fn pickle(&self, pickle_key: Vec<u8>) -> Result<String, CryptoError> {
        let key = parse_pickle_key(&pickle_key)?;
        Ok(lock(&self.inner)?.pickle().encrypt(&key))
    }
}
