# Crypto license & dependency matrix (Phase 2, REQ §7.2)

Checked 2026-10-18 against npm, crates.io, GitHub READMEs and project blogs (sources at the end). Project license: AGPL-3.0-or-later (ADR 0001).

## 1. E2EE protocol libraries

| Candidate | License | Maintained | Audited | Android (RN) | iOS (RN) | Web | Node | Async prekeys | Group membership change / rekey | Multi-device | Mesh / out-of-order tolerance | Backup / export | Build complexity | Mobile size (est.) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **vodozemac 0.11.1 via our uniffi wrapper (ubrn 0.31)** — *recommended* | Apache-2.0 (uniffi, ubrn: MPL-2.0) | Yes: Matrix.org, releases 2026-04 / 09 / 09-30 | Least Authority 2022 (v0.2); later versions not re-audited | Yes, Turbo Module via ubrn JSI (proven in Phase 3) | Yes, same (deferred) | Yes, ubrn `wasm2` (**proven**: 988 KB raw / 254 KB gzip) | Yes, same WASM (**proven**: 14/14 interop tests) | Olm one-time keys + fallback key | Megolm: new outbound session on every change, keys shared over Olm per device | Native: per-device Olm sessions, keys fan out to every device incl. own | Olm: skipped-message keys (bounded gap); Megolm: any order at index ≥ first known | Encrypted pickles of every object; Megolm `export_at` | Medium: Rust + MSVC + NDK; ubrn is pre-1.0 and says "not yet for production" | ~1–2 MB per ABI (measure in Phase 3) |
| vodozemac via matrix-sdk-crypto (`@matrix-org/matrix-sdk-crypto-wasm` 18.9.0, Kotlin/Swift FFI) | Apache-2.0 | Yes | vodozemac part only | Kotlin bindings, no RN package | Swift bindings, no RN package | Yes (npm) | Yes | Yes | Yes (Matrix rooms) | Yes (Matrix cross-signing) | Matrix-shaped | Matrix key backup | High: whole Matrix state machine and event formats; we would carry Matrix semantics everywhere | Large |
| libolm (`@matrix-org/olm` 3.2.15) | Apache-2.0 | **No: deprecated Aug 2024** | 2016 (NCC); 2024 disclosures of primitive weaknesses | Via emscripten JS only | same | Yes | Yes | Yes | Yes | Yes | Same as Olm/Megolm | Pickles | Low | Small |
| libsignal (`@signalapp/libsignal-client` 0.105.1; Rust core) | **AGPL-3.0-only** (compatible with us) | Yes, but "use outside of Signal is unsupported"; APIs "subject to change without notice" | Signal protocol widely analysed; library not independently audited for third-party use | **No RN binding** (Java for Android apps only) | No RN binding | **No WASM/browser** | Yes (native add-on) | X3DH/PQXDH prekeys | Sender keys; group state tied to Signal's server (zkgroup) | Signal's linked-device model | Good | Signal-specific | Very high: we would write and maintain RN + WASM bindings over an unsupported Rust API | Large |
| OpenMLS (Rust) | MIT | Yes | **No independent audit listed** | Builds for Android, not tested in CI | Builds for iOS, not tested | wasm32 builds, not tested | Yes | MLS KeyPackages | Excellent (MLS commits) | Yes (per-device leaves) | **Poor: MLS needs totally ordered commits via a delivery service; breaks with offline/mesh** | Exportable group state | Medium-high | Medium |
| ts-mls 1.6.4 (TypeScript) | MIT | Yes (single main author) | **"has not undergone a formal security audit"** | RN not mentioned | RN not mentioned | Yes | Yes (Node 20+) | MLS KeyPackages | Excellent | Yes | Poor (same MLS ordering issue) | Exportable | Low | Small |
| GPL TS Signal ports (`@privacyresearch/libsignal-protocol-typescript` 0.0.16, `libsignal-protocol` 1.3.15) | GPL-3.0-only (compatible) | **Low: last releases 2025-06 / 2024-02** | **No** | JS only (needs RN crypto polyfills) | same | Yes | Yes | X3DH | None built in | DIY | Good | DIY | Low | Small |
| libsodium (primitives only) | ISC | Yes | Yes (2017) | react-native-libsodium | same | libsodium.js | Yes | — | — | — | — | — | — | — |

**Why not libsodium alone:** REQ §7.2 forbids improvising a protocol from primitives. libsodium is considered below only for attachments.

## 2. Attachment AEAD (streaming)

| Option | License | Audited | Android/iOS | Web/Node | Notes |
|---|---|---|---|---|---|
| libsodium `crypto_secretstream_xchacha20poly1305` | ISC | libsodium yes | **No:** `react-native-libsodium` 1.7.0 exposes secretstream **only in its web build** (`src/lib.ts`); the native `lib.native.ts`/C++ path does not | Yes: `libsodium-wrappers-sumo` 0.8.4 | Would need a fork adding JSI bindings, or a second implementation |
| **RustCrypto XChaCha20-Poly1305 (`chacha20poly1305` 0.11.0) + STREAM (`aead-stream` 0.6.0)** inside `pingdost-crypto` — *recommended* | Apache-2.0 OR MIT | AEAD crate: NCC Group 2020, "no significant findings"; STREAM is the published construction (ePrint 2015/189), also used by the `age` format | Yes: same crate, native build | Yes: same crate, WASM build | One implementation for every platform, already in our Rust build; per-chunk authentication, truncation and reordering detected (last-chunk flag + counter) |
| Matrix attachment format (AES-256-CTR + SHA-256 of the whole file) | Apache-2.0 (matrix-sdk-crypto) | Part of Matrix SDK | Via full Matrix SDK | WebCrypto | Not an AEAD; integrity only after the whole file, unless chunk hashes are added |
| Per-platform AES-GCM with our own chunk-nonce scheme | — | — | — | — | **Rejected:** a custom construction (REQ §7.2) |

## 3. Toolchain used (Phase 2)

| Tool | Version | License |
|---|---|---|
| rustup / rustc | 1.29.1 / 1.99.1 (stable, `x86_64-pc-windows-msvc`), pinned in `rust-toolchain.toml` | Apache-2.0 / MIT |
| VS 2022 Build Tools (MSVC, Windows SDK) | 17.14 (C++ workload) | Microsoft; free for open-source development |
| uniffi / uniffi_core | 0.31.2 (must match ubrn 0.31) | MPL-2.0 |
| uniffi-bindgen-react-native, `@ubjs/core`, `@ubjs/wasm`, `uniffi-runtime-wasm` | 0.31.0-6 | MPL-2.0 |
| vodozemac | 0.11.1 (`wasm_js` feature on wasm32: randomness from Web Crypto `crypto.getRandomValues`) | Apache-2.0 |
| wasm-bindgen-cli | 0.2.129 (must match `wasm-bindgen` in `Cargo.lock`; `cargo install wasm-bindgen-cli --version 0.2.129 --locked`) | Apache-2.0 / MIT |

All licenses are compatible with AGPL-3.0-or-later. MPL-2.0 files stay under MPL; Apache-2.0 is GPLv3-compatible.

## Sources (checked 2026-10-18)
- vodozemac: crates.io API (0.11.1, 2026-09-30); CHANGELOG (0.10.0 / 0.11.0 breaking changes); audit: matrix.org/blog/2022/05/16/independent-public-audit-of-vodozemac-…
- libolm deprecation: matrix.org/blog/2024/08/libolm-deprecation/
- ubrn: jhugman.github.io/uniffi-bindgen-react-native (wasm2 overview and reference; "still in early development"); npm 0.31.0-6 (2026-09-25)
- libsignal: github.com/signalapp/libsignal README; npm `@signalapp/libsignal-client` 0.105.1 (AGPL-3.0-only)
- OpenMLS: github.com/openmls/openmls README; ts-mls: github.com/LukaJCB/ts-mls README ("has not undergone a formal security audit")
- react-native-libsodium 1.7.0: package source inspected (secretstream only in `src/lib.ts`)
- RustCrypto: github.com/RustCrypto/AEADs (chacha20poly1305 README, NCC audit 2020); crates.io `aead-stream` 0.6.0; libsodium secretstream docs (doc.libsodium.org)
