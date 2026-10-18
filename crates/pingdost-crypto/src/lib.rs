//! Narrow uniffi wrapper over vodozemac: Olm for per-device 1:1 sessions, Megolm for
//! groups (ARCHITECTURE A5).
//!
//! Plumbing only, no protocol design or business logic (REQ §7.2). Errors never carry
//! key material, plaintext or ciphertext, and every fallible call returns an error
//! instead of panicking across the FFI.

#[cfg(target_arch = "wasm32")]
extern crate uniffi_runtime_wasm as _;

mod error;
mod megolm;
mod olm;

pub use error::CryptoError;
pub use megolm::{GroupDecryptResult, GroupSession, InboundGroupSession};
pub use olm::{
    Account, IdentityKeys, InboundSessionResult, OlmCiphertext, OlmMessageType, OneTimeKey,
    Session, prekey_message_session_id,
};

uniffi::setup_scaffolding!();

/// Verifies an Ed25519 signature (strict verification). Key and signature are base64.
#[uniffi::export]
pub fn ed25519_verify(
    public_key: String,
    message: Vec<u8>,
    signature: String,
) -> Result<(), CryptoError> {
    let public_key = vodozemac::Ed25519PublicKey::from_base64(&public_key)?;
    let signature = vodozemac::Ed25519Signature::from_base64(&signature)?;
    Ok(public_key.verify(&message, &signature)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PICKLE_KEY: [u8; 32] = [7; 32];

    fn claim_one_time_key(account: &Account) -> String {
        account.generate_one_time_keys(1).unwrap();
        let key = account.one_time_keys().unwrap().remove(0).public_key;
        account.mark_keys_as_published().unwrap();
        key
    }

    #[test]
    fn olm_prekey_flow_and_reply() {
        let alice = Account::new();
        let bob = Account::new();
        let bob_otk = claim_one_time_key(&bob);
        let bob_curve = bob.identity_keys().unwrap().curve25519;
        let alice_curve = alice.identity_keys().unwrap().curve25519;

        let alice_session = alice.create_outbound_session(bob_curve, bob_otk).unwrap();
        let first = alice_session.encrypt(b"hello bob".to_vec()).unwrap();
        assert_eq!(first.message_type, OlmMessageType::PreKey);
        assert_eq!(
            prekey_message_session_id(first.clone()).unwrap(),
            alice_session.session_id().unwrap()
        );

        let inbound = bob
            .create_inbound_session(alice_curve.clone(), first.clone())
            .unwrap();
        assert_eq!(inbound.plaintext, b"hello bob");

        // The one-time key is consumed: the same pre-key message cannot open a new session.
        assert!(bob.create_inbound_session(alice_curve, first).is_err());

        let reply = inbound.session.encrypt(b"hi alice".to_vec()).unwrap();
        assert_eq!(alice_session.decrypt(reply).unwrap(), b"hi alice");
        assert!(alice_session.has_received_message().unwrap());
        assert_eq!(
            alice_session.encrypt(b"x".to_vec()).unwrap().message_type,
            OlmMessageType::Normal
        );
    }

    #[test]
    fn olm_rejects_replay_and_tampering() {
        let alice = Account::new();
        let bob = Account::new();
        let bob_otk = claim_one_time_key(&bob);
        let session = alice
            .create_outbound_session(bob.identity_keys().unwrap().curve25519, bob_otk)
            .unwrap();
        let first = session.encrypt(b"one".to_vec()).unwrap();
        let inbound = bob
            .create_inbound_session(alice.identity_keys().unwrap().curve25519, first)
            .unwrap();
        let second = session.encrypt(b"two".to_vec()).unwrap();

        let mut tampered = second.clone();
        let last = tampered.body.len() - 1;
        tampered.body[last] ^= 0x01;
        assert!(inbound.session.decrypt(tampered).is_err());

        assert_eq!(inbound.session.decrypt(second.clone()).unwrap(), b"two");
        assert!(inbound.session.decrypt(second).is_err(), "replay must fail");
    }

    #[test]
    fn megolm_round_trip_and_export() {
        let outbound = GroupSession::new();
        let inbound = InboundGroupSession::new(outbound.session_key().unwrap()).unwrap();
        let first = outbound.encrypt(b"zero".to_vec()).unwrap();
        let second = outbound.encrypt(b"one".to_vec()).unwrap();

        let decrypted = inbound.decrypt(second.clone()).unwrap();
        assert_eq!(
            (decrypted.plaintext.as_slice(), decrypted.message_index),
            (&b"one"[..], 1)
        );

        let late =
            InboundGroupSession::from_exported_key(inbound.export_at(1).unwrap().unwrap()).unwrap();
        assert!(
            late.decrypt(first).is_err(),
            "export_at(1) must not reveal index 0"
        );
        assert_eq!(late.decrypt(second).unwrap().plaintext, b"one");
    }

    #[test]
    fn pickles_round_trip_and_reject_wrong_key() {
        let account = Account::new();
        let pickle = account.pickle(PICKLE_KEY.to_vec()).unwrap();
        let restored = Account::from_pickle(pickle.clone(), PICKLE_KEY.to_vec()).unwrap();
        assert_eq!(
            restored.identity_keys().unwrap().ed25519,
            account.identity_keys().unwrap().ed25519
        );
        assert!(Account::from_pickle(pickle, vec![8; 32]).is_err());
        assert!(
            account.pickle(vec![1; 16]).is_err(),
            "pickle key must be 32 bytes"
        );
    }

    #[test]
    fn signatures_verify_strictly() {
        let account = Account::new();
        let key = account.identity_keys().unwrap().ed25519;
        let signature = account.sign(b"device list".to_vec()).unwrap();
        assert!(ed25519_verify(key.clone(), b"device list".to_vec(), signature.clone()).is_ok());
        assert!(ed25519_verify(key, b"device lisT".to_vec(), signature).is_err());
    }
}
