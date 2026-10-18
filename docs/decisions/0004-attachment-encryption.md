# 0004 — Attachment encryption: XChaCha20-Poly1305 STREAM in the Rust crypto crate

- **Status:** Accepted
- **Date:** 2026-10-18
- **Phase:** 02 (implemented in Phase 14; mesh chunking in Phase 24)
- **Approved by user:** yes, 2026-10-18 (Phase 2 gate)

## Context
REQ §7.4 and §10 cover attachments:
- files up to 100 MB, encrypted on the sender device before any upload or relay;
- a fresh random key per file, delivered through the E2EE protocol;
- authenticated content, with unique keys and nonces (§7.3).

Mesh transfer (§11, Phase 24) moves chunks out of order through untrusted relays.

ARCHITECTURE A5 preferred libsodium `crypto_secretstream_xchacha20poly1305`. Phase 2 found that **react-native-libsodium 1.7.0 provides secretstream only in its web build**; its Android/iOS native path does not (see [crypto-license-matrix.md](crypto-license-matrix.md) §2).

## Options considered
| Option | Pros | Cons |
|---|---|---|
| libsodium secretstream (libsodium.js on web; fork react-native-libsodium for mobile) | Well-known construction; audited library | Mobile would need a fork with new JSI bindings to maintain; two implementations to keep in step |
| **RustCrypto XChaCha20-Poly1305 + STREAM, inside `pingdost-crypto`** | One implementation on every platform via the same WASM/native build as Olm. AEAD crate audited by NCC Group (2020). STREAM is a published construction (Hoang–Reyhanitabar–Rogaway–Vizár, ePrint 2015/189), also used by `age`. Random-access chunk decryption suits mesh. | The `aead-stream` crate itself has no separate audit (it is a thin nonce-sequencing layer) |
| Matrix format (AES-256-CTR + SHA-256 of the whole file) | Proven in Matrix | Not an AEAD; integrity only after the whole file |
| Per-platform AES-GCM with our own chunk nonces | Fast native primitives | A custom construction (REQ §7.2): rejected |

## Decision
Encrypt attachments in `crates/pingdost-crypto` with **XChaCha20-Poly1305** (`chacha20poly1305` 0.11.0) under the **STREAM** construction (`aead-stream` 0.6.0, `StreamBE32`).

- **Per-file secrets:**
  - a fresh random 32-byte key per attachment, from the OS CSPRNG (Web Crypto on web);
  - a random 19-byte nonce prefix, so the 24-byte nonce is prefix ‖ 32-bit big-endian chunk counter ‖ last-chunk flag.
  - Keys and prefixes are never reused across files; a forwarded file is re-encrypted with a new key.
- **Chunks:**
  - 64 KiB (65,536 bytes) of plaintext per chunk, giving 65,552 bytes of ciphertext. A 100 MiB file is 1,600 chunks with 0.024% overhead.
  - The last chunk carries the STREAM "last" flag, so truncation is detected; an empty file is one empty final chunk.
  - Any chunk can be decrypted by index, so mesh chunks may arrive in any order and transfers can resume.
- **Manifest** (inside E2EE message `Content`; Phase 4 defines the protobuf):
  - `scheme` = `xchacha20poly1305-stream-be32-64k/1`, plus `key` and `noncePrefix`;
  - `plaintextSize`, `chunkSize` and `chunkCount`;
  - `mimeType` and an optional `fileName`;
  - `ciphertextSha256`: SHA-256 over all ciphertext chunks. ChaCha20-Poly1305 is not key-committing, so this binds the content to exactly one ciphertext;
  - `chunkHashListSha256`: SHA-256 of the list of per-chunk ciphertext SHA-256 hashes.
    - The list itself (32 bytes × chunks, about 50 KB for 100 MiB) travels with the ciphertext, not in the envelope (`ENVELOPE_MAX_BYTES` = 64 KiB).
    - Relays and receivers can check each chunk against it without the key.
- **Thumbnails / previews:** encrypted as their own small attachments with their own keys.
- **Where it runs:** the same Rust crate on Android/iOS (native) and web/Node (WASM). Large files are streamed chunk by chunk from JS (file-system reads / `Blob.slice`), so the whole file is never held in memory.

## Consequences
- Phase 14 adds `chacha20poly1305`/`aead-stream` to the wrapper, with an `AttachmentEncryptor`/`decryptChunk` API and test vectors (in `@pingdost/test-fixtures`), then regenerates bindings.
- Phase 24 uses the chunk index and the hash list for mesh transfer.
- The format is not libsodium-compatible; that does not matter because every client uses this crate.
- **ARCHITECTURE A5 changes** (attachments bullet) once this ADR is accepted.

## Evidence
- [crypto-license-matrix.md](crypto-license-matrix.md) §2: react-native-libsodium source inspected (secretstream only in `src/lib.ts`); RustCrypto audit statement; crates.io versions (checked 2026-10-18).
