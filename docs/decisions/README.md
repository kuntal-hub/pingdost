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
| [0006](0006-wire-protocol-encoding.md) | Wire protocol encoding: versions, IDs, limits, padding, flags, error codes | 04 | Accepted |
| [0007](0007-auth-sessions-otp-throttling.md) | Auth sessions, OTPs and abuse throttles | 05 | Accepted |
| [0008](0008-devices-identity-keys-directory.md) | Devices, account identity key, key directory and Google linking | 06 | Accepted |
| [0009](0009-mobile-session-and-device-setup.md) | Mobile session, device setup and device resume | 07 | Accepted |
| [0010](0010-gateway-mailbox-redis-budget.md) | Realtime gateway, delivery mailbox and the Redis budget | 08 | Accepted (provider: 0013) |
| [0011](0011-message-engine.md) | Message engine: store contract, outbox, sessions, repair and receipts | 09 | Accepted |
| [0012](0012-android-chat-safety-numbers-presence.md) | Android 1:1 chat: safety numbers, presence, profiles and the local store | 10 | Accepted |
| [0013](0013-hosting-single-vps-valkey.md) | Hosting: one Hostinger KVM VPS, self-hosted Valkey, no Upstash | change (before 20) | Accepted (user-approved) |

Supporting document: [crypto-license-matrix.md](crypto-license-matrix.md) (REQ §7.2 license/dependency matrix).

## Expected ADRs (numbers assigned when written)
| Topic | Written in | Needs user approval? |
|---|---|---|
| E2EE protocol & library (+ license/dependency matrix, REQ §7.2) | 02 | **Yes (gate)** (done: 0003) |
| Attachment encryption (streaming AEAD choice) | 02 | Yes (done: 0004) |
| Native crypto binding & mobile build (ubrn, APK size, SQLCipher) | 03 | No (done: 0005) |
| Safety-number / fingerprint format | 10 (proposal in 0003) | No (done: 0012) |
| Redis command budget & mailbox provider (Upstash vs Valkey) | 08 | No (input to 20) (done: 0010) |
| Attachment staging store (fs vs s3/R2), 100 MB proof | 14 | No |
| Web pairing protocol | 16 | No |
| History sync protocol | 18 | No |
| Backup format & recovery flows | 19 | No |
| Hosting choice & production topology | change 2026-10-19 (20 verifies) | **Yes** (done: 0013) |
| Nearby transport (BLE / Nearby Connections / Wi-Fi Direct) | 21 | No |
| Mesh routing, relay policy & routing tokens | 23 | No |
| Incoming-call UX on Android | 26 | No |
| Project license | 01 | **Yes** (done: 0001) |
