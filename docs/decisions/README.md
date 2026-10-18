# Architecture Decision Records

Copy `0000-template.md` to `NNNN-short-title.md`, using the next free number. Status moves Proposed → Accepted (or Rejected / Superseded by NNNN).

## Index
| # | Title | Phase | Status |
|---|---|---|---|
| [0001](0001-project-license.md) | Project license: AGPL-3.0-or-later | 01 | Accepted |
| [0002](0002-configuration-conventions.md) | Configuration conventions (`@pingdost/config`) | 01 | Accepted |
| [0003](0003-e2ee-protocol-and-library.md) | E2EE: vodozemac (Olm + Megolm) via a uniffi wrapper | 02 | Accepted (user-approved gate) |
| [0004](0004-attachment-encryption.md) | Attachment encryption: XChaCha20-Poly1305 STREAM in the Rust crate | 02 | Accepted (user-approved) |
| [0005](0005-native-crypto-binding-and-mobile-build.md) | Native crypto binding & Android build: ubrn `jsi2`, SQLCipher, 64-bit ABIs | 03 | Accepted |

Supporting document: [crypto-license-matrix.md](crypto-license-matrix.md) (REQ §7.2 license/dependency matrix).

## Expected ADRs (numbers assigned when written)
| Topic | Written in | Needs user approval? |
|---|---|---|
| E2EE protocol & library (+ license/dependency matrix, REQ §7.2) | 02 | **Yes (gate)** (done: 0003) |
| Attachment encryption (streaming AEAD choice) | 02 | Yes (done: 0004) |
| Native crypto binding & mobile build (ubrn, APK size, SQLCipher) | 03 | No (done: 0005) |
| Safety-number / fingerprint format | 10 (proposal in 0003) | No |
| Redis command budget & mailbox provider (Upstash vs Valkey) | 08 | No (input to 20) |
| Attachment staging store (fs vs s3/R2), 100 MB proof | 14 | No |
| Web pairing protocol | 16 | No |
| History sync protocol | 18 | No |
| Backup format & recovery flows | 19 | No |
| Hosting choice & production topology | 20 | **Yes** |
| Nearby transport (BLE / Nearby Connections / Wi-Fi Direct) | 21 | No |
| Mesh routing, relay policy & routing tokens | 23 | No |
| Incoming-call UX on Android | 26 | No |
| Project license | 01 | **Yes** (done: 0001) |
