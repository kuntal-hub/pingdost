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
| [0014](0014-chat-features-sync-blocks-reports.md) | Chat features: edit/delete/reaction sync, receipts, search, blocks and reports | 11 | Accepted |
| [0015](0015-push-wakes.md) | Push notifications: content-free wakes, local notifications | 12 | Accepted |
| [0016](0016-groups-megolm.md) | Groups: server routing membership, E2EE controls, Megolm sessions | 13 | Accepted |
| [0017](0017-attachment-staging-store.md) | Attachment staging: `fs` on the VPS disk, `s3` optional; SeaweedFS for local S3 tests | 14 | Accepted |
| [0018](0018-attachments-android-ux.md) | Attachments on Android: local vault, compression, held sends, transfers | 15 | Accepted |
| [0019](0019-web-pairing.md) | Web foundation and QR pairing | 16 | Accepted |
| [0020](0020-web-chat.md) | Web chat: Dexie engine store, tab leadership, Web Push, PWA | 17 | Accepted |
| [0021](0021-history-sync-web-attachments.md) | History sync (phone → web) and attachments on the web | 18 | Accepted |
| [0022](0022-backup-recovery-primary-replacement.md) | Backup format, recovery phrase and replacing the primary phone | 19 | Accepted |
| [0023](0023-nearby-transport.md) | Nearby transport: BLE GATT on platform APIs, rotating tokens, a connectedDevice foreground service | 21 | Accepted (device matrix pending) |
| [0024](0024-direct-nearby-messaging.md) | Direct nearby messaging: signed two-step Hello by device key, per-device routing, `waiting_for_nearby_route`, delivery path | 22 | Accepted (device checks pending) |
| [0025](0025-mesh-relay.md) | Mesh store-and-forward relay: routing tokens, spray-and-wait, signed packets | 23 | Accepted (device checks pending) |
| [0026](0026-nearby-recognition.md) | Nearby recognition stays key-based (no contact-only tags) | 23 | Accepted |
| [0027](0027-mesh-file-transfer.md) | Files over the mesh: signed chunks, resume bitmaps, receipt after verification | 24 | Accepted (device checks pending) |
| [0028](0028-calls-signaling-turn-web.md) | Calls: E2EE ephemeral signaling, call pushes, TURN credentials, coturn, web calls | 25 | Accepted (staging and cross-network checks pending) |
| [0029](0029-android-calls-incoming-ux.md) | Android calls: react-native-webrtc, a local calls module, full-screen-intent incoming calls | 26 | Accepted (device matrix pending) |
| [0030](0030-release-hardening.md) | Release hardening: audit gates, mailbox budgets, batched migration, 64-bit only, no crash SDK, versioning | 27 | Accepted |

Supporting document: [crypto-license-matrix.md](crypto-license-matrix.md) (REQ §7.2 license/dependency matrix).

## Expected ADRs (numbers assigned when written)
| Topic | Written in | Needs user approval? |
|---|---|---|
| E2EE protocol & library (+ license/dependency matrix, REQ §7.2) | 02 | **Yes (gate)** (done: 0003) |
| Attachment encryption (streaming AEAD choice) | 02 | Yes (done: 0004) |
| Native crypto binding & mobile build (ubrn, APK size, SQLCipher) | 03 | No (done: 0005) |
| Safety-number / fingerprint format | 10 (proposal in 0003) | No (done: 0012) |
| Redis command budget & mailbox provider (Upstash vs Valkey) | 08 | No (input to 20) (done: 0010) |
| Attachment staging store (fs vs s3/R2), 100 MB proof | 14 | No (done: 0017) |
| Web pairing protocol | 16 | No (done: 0019) |
| History sync protocol | 18 | No (done: 0021) |
| Backup format & recovery flows | 19 | No (done: 0022) |
| Hosting choice & production topology | change 2026-10-19 (20 verifies) | **Yes** (done: 0013) |
| Nearby transport (BLE / Nearby Connections / Wi-Fi Direct) | 21 | No (done: 0023) |
| Nearby handshake & transport routing | 22 | No (done: 0024) |
| Mesh routing, relay policy & routing tokens | 23 | No (done: 0025) |
| Nearby recognition (contact-only tags or not) | 23 | No (done: 0026) |
| Mesh file transfer & Wi-Fi bulk path | 24 | No (done: 0027) |
| Incoming-call UX on Android | 26 | No (done: 0029) |
| Project license | 01 | **Yes** (done: 0001) |
