//! Backup key derivation (ADR 0022): Argon2id (RFC 9106, RustCrypto `argon2`) over the
//! recovery phrase's entropy and a per-backup random salt. The derived 32-byte key then
//! encrypts the backup body with the attachment STREAM (ADR 0004), so this is the only
//! primitive backups add.
//!
//! The parameters come from the backup file's header, so a crafted file could ask for a
//! huge amount of memory or time: every parameter is bounded here.

use argon2::{Algorithm, Argon2, Params, Version};

use crate::error::CryptoError;

/// Bytes of derived key.
pub const BACKUP_KEY_LEN: usize = 32;
const MIN_SECRET_LEN: usize = 16;
const MIN_SALT_LEN: usize = 16;
const MAX_SALT_LEN: usize = 64;
/// 1 GiB: far above what a backup asks for (64 MiB), below what a file could abuse.
const MAX_MEMORY_KIB: u32 = 1 << 20;
const MAX_ITERATIONS: u32 = 16;
const MAX_PARALLELISM: u32 = 8;

/// Argon2id (version 0x13) of `secret` with `salt`; 32 bytes out.
#[uniffi::export]
pub fn backup_derive_key(
    secret: Vec<u8>,
    salt: Vec<u8>,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
) -> Result<Vec<u8>, CryptoError> {
    if secret.len() < MIN_SECRET_LEN {
        return Err(CryptoError::InvalidArgument(
            "a backup secret is at least 16 bytes",
        ));
    }
    if !(MIN_SALT_LEN..=MAX_SALT_LEN).contains(&salt.len()) {
        return Err(CryptoError::InvalidArgument(
            "a backup salt is 16 to 64 bytes",
        ));
    }
    if !(1..=MAX_ITERATIONS).contains(&iterations)
        || !(1..=MAX_PARALLELISM).contains(&parallelism)
        || memory_kib > MAX_MEMORY_KIB
        || memory_kib < 8 * parallelism
    {
        return Err(CryptoError::InvalidArgument(
            "backup KDF parameters out of range",
        ));
    }
    let params = Params::new(memory_kib, iterations, parallelism, Some(BACKUP_KEY_LEN))
        .map_err(|_| CryptoError::InvalidArgument("backup KDF parameters out of range"))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = vec![0u8; BACKUP_KEY_LEN];
    argon2
        .hash_password_into(&secret, &salt, &mut key)
        .map_err(|_| CryptoError::Internal("backup key derivation failed"))?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: [u8; 32] = [1; 32];
    const SALT: [u8; 16] = [2; 16];

    #[test]
    fn deterministic_and_salted() {
        let a = backup_derive_key(SECRET.to_vec(), SALT.to_vec(), 256, 2, 1).unwrap();
        let b = backup_derive_key(SECRET.to_vec(), SALT.to_vec(), 256, 2, 1).unwrap();
        assert_eq!(a.len(), BACKUP_KEY_LEN);
        assert_eq!(a, b);
        let other_salt = backup_derive_key(SECRET.to_vec(), vec![3; 16], 256, 2, 1).unwrap();
        assert_ne!(a, other_salt);
        let other_secret = backup_derive_key(vec![9; 32], SALT.to_vec(), 256, 2, 1).unwrap();
        assert_ne!(a, other_secret);
        let other_cost = backup_derive_key(SECRET.to_vec(), SALT.to_vec(), 256, 3, 1).unwrap();
        assert_ne!(a, other_cost);
    }

    #[test]
    fn rejects_out_of_range_parameters() {
        let derive = |secret: usize, salt: usize, m: u32, t: u32, p: u32| {
            backup_derive_key(vec![1; secret], vec![2; salt], m, t, p)
        };
        assert!(derive(15, 16, 256, 2, 1).is_err(), "short secret");
        assert!(derive(32, 15, 256, 2, 1).is_err(), "short salt");
        assert!(derive(32, 65, 256, 2, 1).is_err(), "long salt");
        assert!(
            derive(32, 16, MAX_MEMORY_KIB + 1, 2, 1).is_err(),
            "memory cap"
        );
        assert!(
            derive(32, 16, 7, 2, 1).is_err(),
            "memory below 8 KiB per lane"
        );
        assert!(derive(32, 16, 256, 0, 1).is_err(), "no iterations");
        assert!(
            derive(32, 16, 256, MAX_ITERATIONS + 1, 1).is_err(),
            "too many iterations"
        );
        assert!(derive(32, 16, 256, 2, 0).is_err(), "no lanes");
        assert!(
            derive(32, 16, 256, 2, MAX_PARALLELISM + 1).is_err(),
            "too many lanes"
        );
    }
}
