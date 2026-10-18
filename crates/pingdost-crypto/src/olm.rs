//! Olm (Double Ratchet + 3DH) for per-device 1:1 sessions.

use std::sync::{Arc, Mutex};

use vodozemac::Curve25519PublicKey;
use vodozemac::olm::{self as vz, SessionConfig};

use crate::error::{CryptoError, lock, parse_pickle_key};

/// Stable, Matrix-compatible Olm v1. (v2 is still behind an experimental flag upstream.)
const SESSION_CONFIG: SessionConfig = SessionConfig::version_1();

/// Upper bound per call, so a bad argument cannot stall the device generating keys.
const MAX_ONE_TIME_KEYS_PER_CALL: u32 = 100;

/// The two public identity keys of a device, base64-encoded.
#[derive(Debug, Clone, uniffi::Record)]
pub struct IdentityKeys {
    pub curve25519: String,
    pub ed25519: String,
}

/// A public one-time or fallback key (Curve25519, base64) with its key ID.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct OneTimeKey {
    pub key_id: String,
    pub public_key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum OlmMessageType {
    /// Carries the key-agreement data that lets the recipient create the session.
    PreKey,
    Normal,
}

/// An encrypted Olm message as it travels inside an envelope.
#[derive(Debug, Clone, uniffi::Record)]
pub struct OlmCiphertext {
    pub message_type: OlmMessageType,
    pub body: Vec<u8>,
}

#[derive(uniffi::Record)]
pub struct InboundSessionResult {
    pub session: Arc<Session>,
    pub plaintext: Vec<u8>,
}

impl From<vz::OlmMessage> for OlmCiphertext {
    fn from(message: vz::OlmMessage) -> Self {
        let (message_type, body) = message.to_parts();
        let message_type = match message_type {
            0 => OlmMessageType::PreKey,
            _ => OlmMessageType::Normal,
        };
        Self { message_type, body }
    }
}

impl TryFrom<&OlmCiphertext> for vz::OlmMessage {
    type Error = CryptoError;

    fn try_from(message: &OlmCiphertext) -> Result<Self, Self::Error> {
        let message_type = match message.message_type {
            OlmMessageType::PreKey => 0,
            OlmMessageType::Normal => 1,
        };
        vz::OlmMessage::from_parts(message_type, &message.body)
            .map_err(|_| CryptoError::InvalidMessage("malformed Olm message"))
    }
}

fn to_one_time_key(key_id: vodozemac::KeyId, key: Curve25519PublicKey) -> OneTimeKey {
    OneTimeKey {
        key_id: key_id.to_base64(),
        public_key: key.to_base64(),
    }
}

/// A device's long-term identity plus its one-time and fallback keys.
#[derive(uniffi::Object)]
pub struct Account {
    inner: Mutex<vz::Account>,
}

impl Default for Account {
    fn default() -> Self {
        Self::new()
    }
}

#[uniffi::export]
impl Account {
    /// Creates a new account with fresh random identity keys.
    #[uniffi::constructor]
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(vz::Account::new()),
        }
    }

    /// Restores an account from `pickle` (see [`Account::pickle`]).
    #[uniffi::constructor]
    pub fn from_pickle(pickle: String, pickle_key: Vec<u8>) -> Result<Self, CryptoError> {
        let key = parse_pickle_key(&pickle_key)?;
        let pickle = vz::AccountPickle::from_encrypted(&pickle, &key)?;
        Ok(Self {
            inner: Mutex::new(vz::Account::from_pickle(pickle)),
        })
    }

    pub fn identity_keys(&self) -> Result<IdentityKeys, CryptoError> {
        let keys = lock(&self.inner)?.identity_keys();
        Ok(IdentityKeys {
            curve25519: keys.curve25519.to_base64(),
            ed25519: keys.ed25519.to_base64(),
        })
    }

    /// Signs `message` with the Ed25519 identity key; returns a base64 signature.
    pub fn sign(&self, message: Vec<u8>) -> Result<String, CryptoError> {
        Ok(lock(&self.inner)?.sign(&message).to_base64())
    }

    /// How many unpublished one-time keys the device should keep on the server.
    pub fn max_number_of_one_time_keys(&self) -> Result<u32, CryptoError> {
        let max = lock(&self.inner)?.max_number_of_one_time_keys();
        Ok(u32::try_from(max).unwrap_or(u32::MAX))
    }

    pub fn generate_one_time_keys(&self, count: u32) -> Result<(), CryptoError> {
        if count > MAX_ONE_TIME_KEYS_PER_CALL {
            return Err(CryptoError::InvalidArgument(
                "too many one-time keys requested",
            ));
        }
        lock(&self.inner)?.generate_one_time_keys(count as usize);
        Ok(())
    }

    /// The unpublished one-time keys, sorted by key ID.
    pub fn one_time_keys(&self) -> Result<Vec<OneTimeKey>, CryptoError> {
        let mut keys: Vec<OneTimeKey> = lock(&self.inner)?
            .one_time_keys()
            .into_iter()
            .map(|(key_id, key)| to_one_time_key(key_id, key))
            .collect();
        keys.sort_by(|a, b| a.key_id.cmp(&b.key_id));
        Ok(keys)
    }

    /// Call after uploading the current one-time and fallback keys.
    pub fn mark_keys_as_published(&self) -> Result<(), CryptoError> {
        lock(&self.inner)?.mark_keys_as_published();
        Ok(())
    }

    /// Rotates the fallback key (the previous one stays usable until the next rotation).
    pub fn generate_fallback_key(&self) -> Result<(), CryptoError> {
        lock(&self.inner)?.generate_fallback_key();
        Ok(())
    }

    /// The unpublished fallback key, if any.
    pub fn fallback_key(&self) -> Result<Option<OneTimeKey>, CryptoError> {
        Ok(lock(&self.inner)?
            .fallback_key()
            .into_iter()
            .next()
            .map(|(key_id, key)| to_one_time_key(key_id, key)))
    }

    /// Starts a session to another device using its Curve25519 identity key and a
    /// claimed one-time (or fallback) key, both base64.
    pub fn create_outbound_session(
        &self,
        their_identity_key: String,
        their_one_time_key: String,
    ) -> Result<Arc<Session>, CryptoError> {
        let identity_key = Curve25519PublicKey::from_base64(&their_identity_key)?;
        let one_time_key = Curve25519PublicKey::from_base64(&their_one_time_key)?;
        let session = lock(&self.inner)?.create_outbound_session(
            SESSION_CONFIG,
            identity_key,
            one_time_key,
        )?;
        Ok(Arc::new(Session::wrap(session)))
    }

    /// Creates a session from a received pre-key message and returns its plaintext.
    /// Consumes the one-time key it used, so the same pre-key message cannot create a
    /// second session.
    pub fn create_inbound_session(
        &self,
        their_identity_key: String,
        message: OlmCiphertext,
    ) -> Result<InboundSessionResult, CryptoError> {
        let identity_key = Curve25519PublicKey::from_base64(&their_identity_key)?;
        let vz::OlmMessage::PreKey(pre_key_message) = vz::OlmMessage::try_from(&message)? else {
            return Err(CryptoError::InvalidMessage("expected a pre-key message"));
        };
        let result = lock(&self.inner)?.create_inbound_session(
            SESSION_CONFIG,
            identity_key,
            &pre_key_message,
        )?;
        Ok(InboundSessionResult {
            session: Arc::new(Session::wrap(result.session)),
            plaintext: result.plaintext,
        })
    }

    /// Serializes the account, encrypted with a 32-byte `pickle_key`.
    pub fn pickle(&self, pickle_key: Vec<u8>) -> Result<String, CryptoError> {
        let key = parse_pickle_key(&pickle_key)?;
        Ok(lock(&self.inner)?.pickle().encrypt(&key))
    }
}

/// One Olm session (Double Ratchet) with one remote device.
#[derive(uniffi::Object)]
pub struct Session {
    inner: Mutex<vz::Session>,
}

impl Session {
    fn wrap(session: vz::Session) -> Self {
        Self {
            inner: Mutex::new(session),
        }
    }
}

#[uniffi::export]
impl Session {
    #[uniffi::constructor]
    pub fn from_pickle(pickle: String, pickle_key: Vec<u8>) -> Result<Self, CryptoError> {
        let key = parse_pickle_key(&pickle_key)?;
        let pickle = vz::SessionPickle::from_encrypted(&pickle, &key)?;
        Ok(Self::wrap(vz::Session::from_pickle(pickle)))
    }

    pub fn session_id(&self) -> Result<String, CryptoError> {
        Ok(lock(&self.inner)?.session_id())
    }

    /// False until the other side has replied; until then `encrypt` keeps producing
    /// pre-key messages.
    pub fn has_received_message(&self) -> Result<bool, CryptoError> {
        Ok(lock(&self.inner)?.has_received_message())
    }

    pub fn encrypt(&self, plaintext: Vec<u8>) -> Result<OlmCiphertext, CryptoError> {
        Ok(lock(&self.inner)?.encrypt(&plaintext)?.into())
    }

    /// Decrypts a message. Each message key is single-use, so a replayed message fails.
    pub fn decrypt(&self, message: OlmCiphertext) -> Result<Vec<u8>, CryptoError> {
        let message = vz::OlmMessage::try_from(&message)?;
        Ok(lock(&self.inner)?.decrypt(&message)?)
    }

    pub fn pickle(&self, pickle_key: Vec<u8>) -> Result<String, CryptoError> {
        let key = parse_pickle_key(&pickle_key)?;
        Ok(lock(&self.inner)?.pickle().encrypt(&key))
    }
}

/// The ID of the session a pre-key message belongs to, so later pre-key messages from
/// the same sender can be routed to the existing session instead of creating a new one.
#[uniffi::export]
pub fn prekey_message_session_id(message: OlmCiphertext) -> Result<String, CryptoError> {
    match vz::OlmMessage::try_from(&message)? {
        vz::OlmMessage::PreKey(pre_key_message) => Ok(pre_key_message.session_id()),
        vz::OlmMessage::Normal(_) => Err(CryptoError::InvalidMessage("expected a pre-key message")),
    }
}
