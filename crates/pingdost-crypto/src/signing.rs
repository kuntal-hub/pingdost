//! The account identity key (ADR 0003): one Ed25519 key per account, created on the primary
//! phone and kept apart from every device's Olm account. It signs device certificates, so
//! linked devices are trusted without changing the safety number.

use vodozemac::Ed25519SecretKey;

use crate::error::CryptoError;

/// An Ed25519 signing key. Plumbing over vodozemac's `Ed25519SecretKey`.
#[derive(uniffi::Object)]
pub struct SigningKey {
    inner: Ed25519SecretKey,
}

impl Default for SigningKey {
    fn default() -> Self {
        Self::new()
    }
}

#[uniffi::export]
impl SigningKey {
    /// Creates a new key from the system CSPRNG.
    #[uniffi::constructor]
    pub fn new() -> Self {
        Self {
            inner: Ed25519SecretKey::new(),
        }
    }

    /// Restores a key from [`SigningKey::export_secret`] output.
    #[uniffi::constructor]
    pub fn from_secret(secret: String) -> Result<Self, CryptoError> {
        Ok(Self {
            inner: Ed25519SecretKey::from_base64(&secret)?,
        })
    }

    /// The public key, base64.
    pub fn public_key(&self) -> String {
        self.inner.public_key().to_base64()
    }

    /// Ed25519 signature over `message`, base64.
    pub fn sign(&self, message: Vec<u8>) -> String {
        self.inner.sign(&message).to_base64()
    }

    /// The secret key, base64. Secret: keep it only in device secure storage or the
    /// encrypted backup (ADR 0003); never log or upload it.
    pub fn export_secret(&self) -> String {
        self.inner.to_base64()
    }
}
