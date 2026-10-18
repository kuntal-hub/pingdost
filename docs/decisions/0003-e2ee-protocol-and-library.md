# 0003 — E2EE protocol & library: vodozemac (Olm + Megolm) via a uniffi wrapper

- **Status:** Accepted
- **Date:** 2026-10-18
- **Phase:** 02 (gate; Android half in Phase 03)
- **Approved by user:** yes, 2026-10-18 (Phase 2 gate)

## Context
- **REQ §7.1:** no chat code ships until an established, maintained, free/OSS E2EE protocol works on React Native Android/iOS, web and Node.
- **REQ §7.2:** no custom protocol, and a license matrix is required.
- **REQ §7.3:** lists the required properties.
- **Delivery model:** offline mailbox, Bluetooth mesh with out-of-order delivery (§11.3), and linked browsers as separate devices (§13.1).
- **Evidence:** the full comparison is in [crypto-license-matrix.md](crypto-license-matrix.md).

## Options considered
See the matrix. In short:

| Option | Why not chosen |
|---|---|
| libsignal | AGPL is fine for us, but there are no RN or WASM bindings, "use outside of Signal is unsupported", and the APIs change without notice. |
| MLS (OpenMLS, ts-mls) | Needs totally ordered commits through a delivery service, which breaks under offline/mesh delivery. Neither has an independent audit. |
| libolm | Deprecated in 2024. |
| TypeScript Signal ports | Unaudited and barely maintained. |
| matrix-sdk-crypto | Drags in the whole Matrix protocol. |

## Decision
1. **Library and bindings.**
   - Use **vodozemac 0.11.1** (Apache-2.0), wrapped by the Rust crate `crates/pingdost-crypto` with a narrow uniffi 0.31 API.
   - Bindings come from **uniffi-bindgen-react-native 0.31.0-6**: `wasm2` for web and Node (Phase 2), JSI Turbo Module for Android/iOS (Phase 3).
   - Consumers see only `CryptoProvider` (`packages/crypto/src/types.ts`).
2. **Protocols.**
   - **1:1, per device pair:** Olm v1 (3DH + Double Ratchet, `SessionConfig::version_1`).
   - **Groups:** Megolm v1.
   - These are the stable Matrix-compatible versions; v2 configs are still experimental upstream.
3. **Prekeys.**
   - Each device publishes signed one-time keys (up to `maxNumberOfOneTimeKeys()` = 50) and one fallback key.
   - The fallback key rotates at least weekly and after it is used.
   - Senders claim one key per recipient device. The server hands out the fallback key when one-time keys run out.
4. **Multi-device.**
   - Every device (phone, each linked browser) has its own Olm account.
   - Messages are encrypted per recipient device, including the sender's own other devices (A5).
5. **Groups.**
   - Each sender device has an outbound Megolm session.
   - It is **replaced on every membership change** (mandatory on removal) and periodically: after 100 messages or 7 days, whichever comes first.
   - Session keys go only over Olm, only to current member devices.
   - New members get `export_at(current index)`, so they cannot read earlier messages.
6. **Replay.**
   - Olm message keys are single-use (replays fail).
   - Megolm does not reject replays itself, so the message engine (Phase 9/13) must reject an already-accepted (session ID, message index) pair.
7. **Pre-key routing.** Repeated pre-key messages from a peer are routed to the existing session via `prekeyMessageSessionId()`; a new inbound session is created only when none matches.
8. **Pickles.**
   - All state is stored only as encrypted pickles under a 32-byte key.
   - On Android that key lives in the Keystore via `expo-secure-store`. On web it is a non-extractable AES-GCM key that wraps the pickle key (A5).

### How REQ §7.3 is met

| Property | How | Limits |
|---|---|---|
| Authenticated key agreement, identity binding | Olm 3DH with Curve25519 identity keys. Each device's keys are signed by its Ed25519 key, and devices are certified by the account identity key (below). | The server directory could substitute keys; users can detect this through safety numbers. |
| Async delivery to offline users | One-time keys plus the fallback key | Fallback-key reuse weakens forward secrecy of first messages until rotation. |
| Forward secrecy / post-compromise recovery | Olm Double Ratchet provides both | Megolm has forward secrecy only from the point a key is exported, and **no post-compromise security** within a session; mitigated by rotation (point 5). **No post-quantum protection** (no PQXDH); harvest-now-decrypt-later is an accepted risk. A later protocol version can migrate via versioned envelopes. |
| Integrity, authentication, replay | Olm MAC and single-use keys. Megolm Ed25519 signature on every message plus MAC. App-level index tracking (point 6). | Olm v1 truncates its MAC to 8 bytes (the Matrix standard). |
| Verification | Safety numbers / QR codes (below). Key changes show a "safety number changed" notice. | Users must actually compare them. |
| Multi-device | Per-device sessions and fan-out | More ciphertext per message with many devices |
| Group membership changes and rekeying | Megolm rotation on every change; membership lives in E2EE group-control messages, not on the server | — |
| Attachments | ADR 0004 | — |
| Versioned envelopes, migration | Phase 4 protobuf envelopes carry `protocol` (olm.v1 / megolm.v1) and the crypto implementation version. New versions are added side by side, and receivers keep old decryptors. | — |

**Lessons from the 2023 analysis of Matrix clients** (Albrecht et al., IEEE S&P 2023), adopted as design rules:
- group membership is authenticated by members' signed control messages, never by the server;
- there are no automatic key requests or forwarding from unverified devices;
- every cross-device trust statement is an Ed25519 signature checked by the client.

### Safety-number format (proposal; finalized in Phase 10)
- **Account identity key.** Each account has one Ed25519 *account identity key*, created on the primary phone.
  - It is kept separate from the per-device Olm accounts and is stored in the recovery backup.
  - It signs each device's Ed25519 key, which forms a device certificate.
  - Linked browsers and replacement phones are therefore trusted without changing the safety number.
- **Display.** Signal's numeric-fingerprint encoding: iterated SHA-512 (5,200 rounds) over `version ‖ identity key ‖ user ID`.
  - This gives 30 digits per party, concatenated in a canonical order: 60 digits shown as 12 groups of 5.
  - The QR code carries the version and both fingerprints.
  - This is a display encoding only, built from a standard hash.
- **Wrapper follow-up.** The wrapper needs an Ed25519 signing-key object (vodozemac `Ed25519Keypair`), added when Phase 6 needs it.

### Backup implications (REQ §6.3, Phase 19)
- **Export:** the account identity key, plus Megolm *inbound* sessions via `export_at_first_known_index`, so history stays readable.
- **Never restore Olm sessions, outbound Megolm sessions or a device Olm account from a backup.** Reusing an old ratchet state can reuse message keys. After a restore, the device creates a fresh Olm account (a new device certified by the restored identity key), new Olm sessions and new outbound group sessions.

### Mesh first contact (REQ §11.3)
- While online, clients cache contacts' device identity keys and fallback keys (signature-checked). Offline, they create Olm pre-key messages from the cached fallback key.
- The other option is a direct nearby handshake that exchanges one-time keys (Phase 22).
- Relays only see ciphertext.

## Consequences
- Phase 3 must prove the JSI Turbo Module build on Android: ubrn + cargo-ndk with NDK 27/28, which are already installed.
- Phase 4 finalizes `CryptoProvider` and the envelope `protocol` field.
- Phases 9 and 13 implement the replay index, rotation policy and pre-key routing.
- Phase 6 adds the account identity key and device certificates. Phase 10 finalizes safety numbers. Phase 19 follows the backup rules above.
- **Risks:**
  - ubrn is pre-1.0 and says it is not production-ready. Mitigation: pin versions; the generated TypeScript is committed and reviewable. Fallback: wasm-bindgen for web, with hand-written JSI or Kotlin JNI for Android.
  - vodozemac versions after 0.2 have not been re-audited.
- **Gradle/NDK:** native libraries must be built for arm64-v8a and x86_64 (emulator) at minimum.

## Evidence (2026-10-18, Windows 11 host)
- **ubrn `wasm2` build works on a Windows host**, so no wasm-pack fallback was needed. It uses wasm-bindgen 0.2.129 glue for getrandom's Web Crypto backend.
- **Module size:** 988 KB raw, 254 KB gzip, 203 KB Brotli (release, `opt-level = "z"`, LTO).
- **`pnpm --filter @pingdost/crypto test`:** 14/14 pass in Node through WASM. This covers all 9 Phase 2 scenarios:
  - the pre-key flow plus pre-key routing;
  - the fallback key used by two senders;
  - out-of-order delivery;
  - Olm replay and pre-key replay;
  - Olm and Megolm tampering;
  - Megolm rotation on removal plus message-index reporting;
  - a new member joining at the current index;
  - pickles for all four object types, plus wrong and short keys;
  - multi-device fan-out, including the sender's own other device;
  - plus strict Ed25519 verification.
- **`cargo test`:** 5/5 pass.
- **Rust checks:** `cargo clippy -D warnings` is clean on the host and on wasm32, and `cargo fmt --check` passes.
- [crypto-license-matrix.md](crypto-license-matrix.md), sources checked 2026-10-18.
