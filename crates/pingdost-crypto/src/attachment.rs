//! Attachment encryption (ADR 0004): XChaCha20-Poly1305 under the STREAM construction
//! (`StreamBE32`), so the 24-byte nonce is a 19-byte random prefix, a big-endian 32-bit chunk
//! counter and a last-chunk flag. Plaintext goes in 64 KiB chunks; a truncated stream fails
//! on the missing last flag, and any chunk decrypts on its own by index (resumable transfers,
//! mesh chunks in any order).
//!
//! The encryptor also hashes: SHA-256 over all ciphertext (ChaCha20-Poly1305 is not
//! key-committing, so the manifest binds exactly one ciphertext) and over the list of
//! per-chunk SHA-256s, which relays and the server can check without the key.

use std::sync::Mutex;

use aead_stream::{NewStream, Nonce, StreamBE32, StreamPrimitive};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305};
use sha2::{Digest, Sha256};

use crate::error::{CryptoError, lock};

/// Plaintext bytes per chunk; every chunk but the last is exactly this long.
pub const CHUNK_SIZE: usize = 65_536;
const KEY_LEN: usize = 32;

type Stream = StreamBE32<XChaCha20Poly1305>;

fn stream(key: &[u8], nonce_prefix: &[u8]) -> Result<Stream, CryptoError> {
    if key.len() != KEY_LEN {
        return Err(CryptoError::InvalidKey("an attachment key is 32 bytes"));
    }
    let nonce = Nonce::<XChaCha20Poly1305, Stream>::try_from(nonce_prefix)
        .map_err(|_| CryptoError::InvalidArgument("an attachment nonce prefix is 19 bytes"))?;
    let aead = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| CryptoError::InvalidKey("an attachment key is 32 bytes"))?;
    Ok(Stream::from_aead(aead, &nonce))
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct EncryptedChunk {
    pub ciphertext: Vec<u8>,
    /// SHA-256 of `ciphertext`.
    pub sha256: Vec<u8>,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct AttachmentDigests {
    pub chunk_count: u32,
    pub plaintext_size: u64,
    pub ciphertext_size: u64,
    /// SHA-256 over every ciphertext chunk in order.
    pub ciphertext_sha256: Vec<u8>,
    /// SHA-256 of the concatenated per-chunk SHA-256s.
    pub chunk_hash_list_sha256: Vec<u8>,
}

struct EncryptorState {
    stream: Stream,
    next: u32,
    plaintext_size: u64,
    ciphertext_size: u64,
    all: Sha256,
    list: Sha256,
    done: bool,
}

/// Encrypts one attachment chunk by chunk, in order, hashing as it goes.
#[derive(uniffi::Object)]
pub struct AttachmentEncryptor {
    inner: Mutex<EncryptorState>,
}

#[uniffi::export]
impl AttachmentEncryptor {
    /// `key`: 32 random bytes; `nonce_prefix`: 19 random bytes. Never reuse either.
    #[uniffi::constructor]
    pub fn new(key: Vec<u8>, nonce_prefix: Vec<u8>) -> Result<Self, CryptoError> {
        Ok(Self {
            inner: Mutex::new(EncryptorState {
                stream: stream(&key, &nonce_prefix)?,
                next: 0,
                plaintext_size: 0,
                ciphertext_size: 0,
                all: Sha256::new(),
                list: Sha256::new(),
                done: false,
            }),
        })
    }

    /// The next chunk: exactly 64 KiB unless `last` (then at most 64 KiB, possibly empty).
    pub fn encrypt_chunk(
        &self,
        plaintext: Vec<u8>,
        last: bool,
    ) -> Result<EncryptedChunk, CryptoError> {
        let mut state = lock(&self.inner)?;
        if state.done {
            return Err(CryptoError::InvalidArgument(
                "the last chunk was already encrypted",
            ));
        }
        if plaintext.len() > CHUNK_SIZE || (!last && plaintext.len() != CHUNK_SIZE) {
            return Err(CryptoError::InvalidArgument(
                "chunks are 64 KiB, except the last",
            ));
        }
        if state.next == u32::MAX {
            return Err(CryptoError::InvalidArgument("too many chunks"));
        }
        let mut buffer = plaintext;
        let plaintext_len = buffer.len() as u64;
        state
            .stream
            .encrypt_in_place(state.next, last, b"", &mut buffer)
            .map_err(|_| CryptoError::Encryption("attachment chunk"))?;
        let sha256 = Sha256::digest(&buffer).to_vec();
        state.all.update(&buffer);
        state.list.update(&sha256);
        state.next += 1;
        state.plaintext_size += plaintext_len;
        state.ciphertext_size += buffer.len() as u64;
        state.done = last;
        Ok(EncryptedChunk {
            ciphertext: buffer,
            sha256,
        })
    }

    /// The digests for the manifest, once the last chunk is encrypted.
    pub fn finish(&self) -> Result<AttachmentDigests, CryptoError> {
        let state = lock(&self.inner)?;
        if !state.done {
            return Err(CryptoError::InvalidArgument(
                "the last chunk is not encrypted yet",
            ));
        }
        Ok(AttachmentDigests {
            chunk_count: state.next,
            plaintext_size: state.plaintext_size,
            ciphertext_size: state.ciphertext_size,
            ciphertext_sha256: state.all.clone().finalize().to_vec(),
            chunk_hash_list_sha256: state.list.clone().finalize().to_vec(),
        })
    }
}

/// Decrypts chunk `index` on its own; `last` must be set exactly for the final chunk.
#[uniffi::export]
pub fn attachment_decrypt_chunk(
    key: Vec<u8>,
    nonce_prefix: Vec<u8>,
    index: u32,
    last: bool,
    ciphertext: Vec<u8>,
) -> Result<Vec<u8>, CryptoError> {
    let stream = stream(&key, &nonce_prefix)?;
    let mut buffer = ciphertext;
    stream
        .decrypt_in_place(index, last, b"", &mut buffer)
        .map_err(|_| CryptoError::Decryption("attachment chunk failed authentication"))?;
    Ok(buffer)
}

/// SHA-256 of `data`.
#[uniffi::export]
pub fn sha256(data: Vec<u8>) -> Vec<u8> {
    Sha256::digest(&data).to_vec()
}

/// Incremental SHA-256, e.g. to check a downloaded ciphertext without holding it.
#[derive(uniffi::Object)]
pub struct Sha256Hasher {
    inner: Mutex<Sha256>,
}

impl Default for Sha256Hasher {
    fn default() -> Self {
        Self::new()
    }
}

#[uniffi::export]
impl Sha256Hasher {
    #[uniffi::constructor]
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Sha256::new()),
        }
    }

    pub fn update(&self, data: Vec<u8>) -> Result<(), CryptoError> {
        lock(&self.inner)?.update(&data);
        Ok(())
    }

    /// The digest so far (the hasher keeps going).
    pub fn digest(&self) -> Result<Vec<u8>, CryptoError> {
        Ok(lock(&self.inner)?.clone().finalize().to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [3; 32];
    const PREFIX: [u8; 19] = [5; 19];

    fn encrypt(plaintext: &[u8]) -> (Vec<Vec<u8>>, AttachmentDigests) {
        let encryptor = AttachmentEncryptor::new(KEY.to_vec(), PREFIX.to_vec()).unwrap();
        let mut chunks: Vec<&[u8]> = plaintext.chunks(CHUNK_SIZE).collect();
        if chunks.is_empty() || plaintext.len().is_multiple_of(CHUNK_SIZE) {
            // A final chunk is always present; after an exact multiple it is empty.
            chunks.push(&[]);
        }
        let count = chunks.len();
        let out = chunks
            .iter()
            .enumerate()
            .map(|(i, chunk)| {
                encryptor
                    .encrypt_chunk(chunk.to_vec(), i + 1 == count)
                    .unwrap()
                    .ciphertext
            })
            .collect();
        (out, encryptor.finish().unwrap())
    }

    #[test]
    fn round_trips_by_index_in_any_order() {
        let plaintext: Vec<u8> = (0..CHUNK_SIZE * 2 + 100).map(|i| (i % 251) as u8).collect();
        let (chunks, digests) = encrypt(&plaintext);
        assert_eq!(digests.chunk_count, 3);
        assert_eq!(digests.plaintext_size, plaintext.len() as u64);
        assert_eq!(digests.ciphertext_size, plaintext.len() as u64 + 3 * 16);
        let mut out = vec![Vec::new(); 3];
        for index in [2usize, 0, 1] {
            out[index] = attachment_decrypt_chunk(
                KEY.to_vec(),
                PREFIX.to_vec(),
                index as u32,
                index == 2,
                chunks[index].clone(),
            )
            .unwrap();
        }
        assert_eq!(out.concat(), plaintext);
        let all: Vec<u8> = chunks.concat();
        assert_eq!(digests.ciphertext_sha256, sha256(all));
        let list: Vec<u8> = chunks.iter().flat_map(|c| sha256(c.clone())).collect();
        assert_eq!(digests.chunk_hash_list_sha256, sha256(list));
    }

    #[test]
    fn detects_truncation_reordering_and_tampering() {
        let plaintext = vec![7u8; CHUNK_SIZE * 2];
        let (chunks, _) = encrypt(&plaintext);
        assert_eq!(
            chunks.len(),
            3,
            "an exact multiple ends with an empty last chunk"
        );
        let decrypt = |index: u32, last: bool, data: &[u8]| {
            attachment_decrypt_chunk(KEY.to_vec(), PREFIX.to_vec(), index, last, data.to_vec())
        };
        // Dropping the final chunk: chunk 1 does not pass as the last one.
        assert!(decrypt(1, true, &chunks[1]).is_err());
        // A chunk at another position.
        assert!(decrypt(0, false, &chunks[1]).is_err());
        let mut tampered = chunks[0].clone();
        tampered[10] ^= 1;
        assert!(decrypt(0, false, &tampered).is_err());
        // Another key.
        assert!(
            attachment_decrypt_chunk(vec![4; 32], PREFIX.to_vec(), 0, false, chunks[0].clone())
                .is_err()
        );
    }

    #[test]
    fn empty_file_is_one_empty_final_chunk() {
        let (chunks, digests) = encrypt(&[]);
        assert_eq!(digests.chunk_count, 1);
        assert_eq!(chunks[0].len(), 16);
        assert!(
            attachment_decrypt_chunk(KEY.to_vec(), PREFIX.to_vec(), 0, true, chunks[0].clone())
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn rejects_bad_sizes_and_use_after_the_end() {
        assert!(AttachmentEncryptor::new(vec![1; 31], PREFIX.to_vec()).is_err());
        assert!(AttachmentEncryptor::new(KEY.to_vec(), vec![1; 24]).is_err());
        let encryptor = AttachmentEncryptor::new(KEY.to_vec(), PREFIX.to_vec()).unwrap();
        assert!(
            encryptor.encrypt_chunk(vec![0; 10], false).is_err(),
            "short non-final chunk"
        );
        assert!(
            encryptor
                .encrypt_chunk(vec![0; CHUNK_SIZE + 1], true)
                .is_err()
        );
        assert!(encryptor.finish().is_err());
        encryptor.encrypt_chunk(vec![0; 10], true).unwrap();
        assert!(encryptor.encrypt_chunk(vec![0; 10], true).is_err());
        assert_eq!(encryptor.finish().unwrap().chunk_count, 1);
    }

    #[test]
    fn hasher_matches_one_shot() {
        let hasher = Sha256Hasher::new();
        hasher.update(b"abc".to_vec()).unwrap();
        hasher.update(b"def".to_vec()).unwrap();
        assert_eq!(hasher.digest().unwrap(), sha256(b"abcdef".to_vec()));
    }
}
