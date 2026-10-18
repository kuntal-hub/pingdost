# Phase 02 — Crypto spike A: Rust core, WASM/Node bindings, license matrix (GATE)

**Depends on:** 01 · **Platforms:** Rust, Node, web (WASM)

## Goal
Prove a maintained, established, free/OSS E2EE protocol works from TypeScript in Node and the browser. Produce the license/dependency matrix and an ADR, then **get explicit user approval**. This is REQ §7.1's mandatory gate (the Android half is Phase 3).

## Read first
- REQ §7 (all), §6.3 (backup of session keys), §11.3, §13.1 (multi-device), §21 (first two rows)
- ARCHITECTURE A5, A10

## Tasks
- [x] **Toolchain** (Windows). Check, and install with the user's OK:
  - `rustup` (`winget install Rustlang.Rustup`);
  - **MSVC C++ Build Tools** (`winget install Microsoft.VisualStudio.2022.BuildTools` with the C++ workload). This is large; tell the user first, and they may need to run it themselves;
  - target `wasm32-unknown-unknown`;
  - `uniffi-bindgen-react-native` (ubrn): check its current version and docs for the `wasm2` target, and record the version.
- [x] **Research (web search, record dates checked):**
  - vodozemac: latest version, audit status, maintenance;
  - ubrn wasm and Android support status;
  - libsignal: license, RN/web options, "unsupported outside Signal" stance;
  - OpenMLS and ts-mls: license, audit, maturity;
  - GPL TypeScript Signal ports;
  - libsodium availability: `libsodium-wrappers-sumo` (web/Node) and `react-native-libsodium`. **Check whether `crypto_secretstream_*` is supported.**
- [x] **License/dependency matrix** `docs/decisions/crypto-license-matrix.md`. Rows are the candidates.
  - Columns: license, maintained, audited, Android RN, iOS RN, web, Node, async prekeys, group membership changes and rekey, multi-device, mesh/out-of-order tolerance, backup/export story, build complexity, APK size estimate.
- [x] **Cargo workspace** (`Cargo.toml` at root) + `crates/pingdost-crypto` wrapping vodozemac with a **narrow** uniffi API. Plumbing only, no business logic:
  - **Account:** `new`, `identity_keys()` (curve25519, ed25519), `sign(msg)`, `generate_one_time_keys(n)`, `one_time_keys()`, `mark_keys_as_published()`, `generate_fallback_key()`, `fallback_key()`, `create_outbound_session(their_identity_curve, their_otk)`, `create_inbound_session(their_identity_curve, prekey_msg)` → (session, plaintext), `pickle(key)` / `from_pickle(key)`.
  - **Session:** `encrypt(plaintext)` → (type, ciphertext); `decrypt(type, ciphertext)`; `session_id()`; `pickle` / `from_pickle`.
  - **Megolm:** `GroupSession` (outbound: `new`, `session_id`, `session_key`, `message_index`, `encrypt`, pickle) and `InboundGroupSession` (`new(session_key)`, `decrypt` → (plaintext, index), `export_at(index)`, `import`, pickle).
  - **Utility:** `ed25519_verify(pubkey, msg, sig)`.
  - **Errors:** typed error enum; no panics across the FFI.
- [x] **Bindings:** generate the WASM build with ubrn `wasm2` into `packages/crypto/` (e.g. `packages/crypto/wasm/` + a TS wrapper). If ubrn wasm fails, fall back to wasm-bindgen + wasm-pack and **record why**.
  - Expose `createWasmCryptoProvider()` implementing a draft `CryptoProvider` interface in `packages/crypto/src/types.ts`; Phase 4 finalizes it.
- [x] **Node interop tests** (Vitest, `packages/crypto`):
  1. Alice ↔ Bob prekey flow via a claimed one-time key, then a normal ratchet exchange.
  2. The same flow via the fallback key when OTKs are exhausted.
  3. Out-of-order delivery within a chain decrypts.
  4. **Replay:** decrypting an already-decrypted message fails.
  5. **Tamper:** flipping a ciphertext byte fails authentication (REQ §11.3 / §19.1).
  6. **Megolm:** Alice shares a session key with Bob and Carol over Olm, and both decrypt. After Carol is removed, Alice rotates and shares only with Bob, and **Carol cannot decrypt** new messages (REQ §19.1).
  7. **New member:** a member added with `export_at(current index)` cannot decrypt earlier messages.
  8. **Pickles:** round-trip of every object; a wrong pickle key fails.
  9. Multi-device fan-out: Alice has a phone and a web device; Bob encrypts to both.
- [x] `cargo test` for the Rust wrapper (basic) and `cargo clippy`.
- [x] **ADR (E2EE protocol & library)**, status Proposed:
  - the recommendation and why;
  - how each REQ §7.3 property is met, or what its limits are. For example, Megolm's weaker post-compromise security, which is mitigated by rotation;
  - multi-device model;
  - backup implications (which pickles can be exported; 1:1 sessions are re-established after restore);
  - safety-number format proposal (encoding of both Ed25519 keys; display only);
  - mesh first-contact via cached fallback keys.
- [x] **ADR (attachment AEAD):** the secretstream choice and where it runs on each platform (web/Node lib vs RN lib vs Rust crate), chunk size, and manifest fields.
- [x] **Ask the user to approve** both ADRs (AskUserQuestion with a short summary: Approve / Request changes). Set Accepted when approved, and update the ADR index.

## Key files
`Cargo.toml`, `crates/pingdost-crypto/{Cargo.toml,src/lib.rs,uniffi.toml}`, `packages/crypto/{src/types.ts,src/wasm.ts,test/*.test.ts}`, `docs/decisions/*`

## Out of scope
The Android build (Phase 3), protobuf content formats (Phase 4), any UI.

## Done when
- `cargo test` and `pnpm --filter @pingdost/crypto test` pass, with all 9 interop scenarios green.
- The matrix and both ADRs are written, and the **user has approved** them (recorded in the ADRs).
- PROGRESS lists the exact toolchain versions and install steps used, so Phase 3 can repeat them.

## Handoff notes
- If the approved protocol is **not** vodozemac, update ARCHITECTURE A5 and the Phase 3, 4, 9 and 13 files before closing.
