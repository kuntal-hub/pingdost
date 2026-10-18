# Privacy-First Messaging App(pingdost.com) — Product & Technical Requirements

**Document type:** Product requirements + technical architecture baseline  
**Status:** Draft for implementation planning  
**Last updated:** 10 October 2026  
**Product scope:** Android, iOS, and web; private messaging, group chat, one-to-one audio/video calls, offline nearby messaging, and multi-hop store-and-forward mesh.

---

## 1. Executive summary

Build a privacy-first communication application where users own their conversation history. The mobile app is the primary device and source of chat history. A Vite/React web client can be linked to the mobile app by QR code and receives a configurable recent-history sync directly through an authenticated encrypted device-to-device session.

The system must support:

- One-to-one and group text messaging.
- End-to-end encrypted (E2EE) messages and attachments.
- Local-first message history stored on the user's devices.
- Time-limited encrypted server delivery queues for recipients who are offline.
- Nearby offline messaging via Bluetooth and suitable peer-to-peer networking.
- Opt-in, multi-hop, store-and-forward mesh relaying, including encrypted file chunks.
- One-to-one audio and video calls using WebRTC, with STUN and TURN support.
- QR pairing of one primary mobile device with multiple web browsers.
- A low-cost deployment using open-source software and free/low-cost provider tiers where practical.

The backend is a **Node.js + TypeScript modular monolith in a pnpm/Turborepo monorepo**. MongoDB holds account/device metadata and time-limited encrypted delivery records. Upstash Redis is the hot temporary mailbox and transient-state store. Attachments are primarily device-local; encrypted server-side staging is allowed only for temporary delivery and must be deleted after acknowledgement or expiration.

### Core privacy promise

> Conversation history is stored on users' devices, not maintained as a permanent server-side archive. End-to-end encrypted message envelopes and encrypted attachments may be held temporarily on servers to deliver them to offline recipients, but must expire and be deleted under defined retention policies. Account and device metadata may be stored in the database.

This wording is intentional: temporarily queued ciphertext is server-side data, but it is not a permanent chat-history archive. The product must not claim that no communication data ever touches or is stored on a server.

---

## 2. Goals and non-goals

### 2.1 Goals

1. Keep message contents unreadable to the backend, database operator, temporary object-storage provider, and intermediate mesh relays.
2. Keep durable chat history on the user's devices.
3. Make ordinary Internet message delivery reliable without storing permanent chat history.
4. Allow messages and files to move between nearby devices when no device has Internet access, including best-effort background store-and-forward relaying.
5. Support secure groups, while keeping all audio/video calls strictly one-to-one.
6. Pair web browsers securely through a mobile-scanned QR code and sync recent history from the primary mobile device.
7. Keep initial running costs low, avoid paid encryption APIs, and avoid unnecessary microservices.
8. Provide explicit controls and honest status indicators for Internet delivery, nearby delivery, mesh relaying, storage, and retention.

### 2.2 Non-goals for the first release

- Group audio/video calling.
- Server-side permanent chat history or server-based chat-history search.
- Server-readable message/attachment content.
- Guaranteed Bluetooth mesh operation after an app is force-quit, killed by the OS, or prevented from running by device settings.
- Cloud media libraries or permanent server-side attachment hosting.
- Message recall that guarantees deletion of copies already received or exported by another user.
- An assumption that the app can deliver a message across the mesh without devices physically encountering an available route.

---

## 3. Confirmed product decisions

| Area                             | Requirement                                                                                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platforms                        | Android, iOS, and web at launch                                                                                                                            |
| Primary mobile device            | One primary mobile device per account initially                                                                                                            |
| Web devices                      | Multiple linked browsers permitted                                                                                                                         |
| Sign-up                          | Username + email/password with email verification OTP; Google and Facebook social login                                                                    |
| Backend                          | Node.js + TypeScript, modular monolith                                                                                                                     |
| Monorepo                         | pnpm + Turborepo recommended                                                                                                                               |
| Database                         | MongoDB for account/device metadata and time-limited encrypted delivery envelopes                                                                          |
| Redis                            | Upstash Redis for temporary mailboxes and transient state                                                                                                  |
| Job queue                        | BullMQ is an option, subject to an integration/price proof of concept; not a hard requirement                                                              |
| Chat storage                     | Durable history is local to user devices only                                                                                                              |
| E2EE                             | Mandatory, based on a maintained, established protocol and free/open-source software; no paid encryption SaaS/API                                          |
| Redis staging period             | Default 14 hours; configurable with an environment variable                                                                                                |
| Maximum server message retention | 14 days from original send time; configurable; then delete undelivered ciphertext                                                                          |
| Attachments                      | Local by default; temporary encrypted server staging permitted for Internet delivery to offline users                                                      |
| Maximum individual attachment    | 100 MB after any chosen/required image or video compression                                                                                                |
| Compression                      | Image/video compression enabled by default, with a user-visible option to send the original where permitted; only images and videos are compressible in V1 |
| Offline messaging                | Required on mobile; direct nearby plus multi-hop store-and-forward mesh                                                                                    |
| Mesh relay consent               | Explicit opt-in; a user can disable relaying at any time                                                                                                   |
| Background mesh                  | Best-effort; platform restrictions must be clearly documented                                                                                              |
| Calls                            | One-to-one audio and video only; WebRTC with STUN and TURN fallback                                                                                        |
| Web pairing                      | Mobile scans short-lived QR code; web becomes an authorized device                                                                                         |
| Web history                      | Recent-history sync first; older history can be requested from the mobile device                                                                           |
| Recovery                         | User-controlled encrypted export/backup and recovery through an already-authorized device where available; no server-side history backup                   |
| Cost                             | Prefer free/low-cost services; do not compromise cryptographic design for cost                                                                             |

---

## 4. Technical stack and repository layout

### 4.1 Recommended stack

- **Runtime/server:** Node.js LTS + TypeScript. Prefer Node.js over Bun for the first production version because the application depends on many native integrations, WebSockets, queue workers, and cryptographic bindings. Bun can be reassessed later after compatibility tests.
- **API:** Fastify or Express. Select one at repository initialization and apply one validation/error-handling pattern consistently.
- **Realtime messaging/signaling:** WebSocket transport; Socket.IO is acceptable if its reconnect/presence behavior is useful, but all message-delivery semantics must be implemented at the application-protocol layer rather than relying on socket delivery alone.
- **Mobile:** React Native with Expo development builds/prebuild and custom native modules when required. Do not assume Expo Go supports WebRTC, production E2EE bindings, or full Bluetooth/background mesh.
- **Web:** Vite + React + TypeScript.
- **Local mobile database:** SQLite, preferably SQLCipher when build size and native compatibility are validated. Store attachments in the local filesystem, not as blobs in the relational database.
- **Local web store:** IndexedDB, with sensitive content encrypted at rest in the browser where feasible and keys protected through the web platform's available mechanisms.
- **Permanent metadata database:** MongoDB, starting with Atlas free tier if its limits and availability suit early development.
- **Hot mailbox/state:** Upstash Redis using native Redis protocol where needed.
- **Background processing:** A worker process from the same backend codebase. BullMQ may be used only after validating required commands, worker connection behavior, and cost under Upstash's plan.
- **Call media:** WebRTC; no SFU/media server for the one-to-one call product. Use a signaling service and STUN/TURN infrastructure. coturn is a self-hostable open-source option, but bandwidth and the VM may cost money.
- **Temporary attachment staging:** Prefer an object-storage provider with private objects, signed upload/download URLs, lifecycle expiration, and no-egress or low-egress costs. Cloudflare R2 is a candidate; provider choice is not final until tested against 100 MB encrypted objects and retention/deletion needs.
- **Email:** An adapter interface for transactional email providers, so a low-cost/free-tier provider can be replaced without rewriting authentication.
- **Push:** FCM/APNs may wake/notify a device, but payloads must contain no message text, file content, session secret, or decryption key.

### 4.2 Monorepo structure

```text
apps/
  mobile/              # React Native / Expo
  web/                 # Vite + React
  server/              # Node.js API + realtime gateway
  worker/              # Optional separate process using same server packages

packages/
  shared-types/        # DTOs, event names, validation schemas
  protocol/            # Versioned message, delivery, mesh, call, pairing schemas
  crypto/              # Narrow cross-platform E2EE interface and selected implementation
  message-engine/      # Outbox, delivery state, idempotency, acknowledgements
  transport/           # Transport interfaces and routing selection
  mesh-protocol/       # Hop limits, packet TTL, chunking, dedupe, relay policy
  auth/                # Auth/session contracts and reusable validation
  config/              # Typed env parsing and shared non-secret constants
  test-fixtures/       # Shared protocol vectors and test payloads
```

Keep a **modular monolith**. These directories are code modules/packages, not independent microservices. Split deployment units only where a real operational reason emerges.

### 4.3 Engineering rule

Define a versioned transport-neutral message protocol. The chat engine should produce and consume encrypted protocol packets without depending on whether transport is Internet WebSocket, Bluetooth, peer-to-peer Wi-Fi, or a mesh relay.

---

## 5. Privacy and data-retention policy

### 5.1 Data that may persist in MongoDB

- User account identifier, username, verified email, password hash when password auth is used, account status, preferences, and timestamps.
- Social identity provider IDs necessary to link Google/Facebook logins.
- Device registry: device ID, device type, status, public identity keys/prekeys needed for session setup, pairing/revocation state, and public-key versioning.
- Minimal anti-abuse/security data: rate-limit counters, login attempt metadata, abuse reports where applicable, and security audit events with an explicitly documented retention period.
- Encrypted pending-message envelopes only as a temporary delivery spool, with an absolute expiry no later than the configured maximum retention.

### 5.2 Data that must not be a permanent server record

- Plaintext messages or decrypted group messages.
- A permanent message history, conversation transcript, or server-side chat-search index.
- Plaintext image/video/audio/document attachments.
- Permanent attachment URLs or permanent media library entries.
- Permanent typing indicators, read receipts, delivery receipts, call records, or presence history.
- Call recordings.

### 5.3 Temporarily stored delivery data

The following are permitted only for delivery and must be removed after successful delivery/acknowledgement or expiration:

- E2EE ciphertext envelopes in Redis during the hot staging window.
- E2EE ciphertext envelopes migrated to MongoDB until the original 14-day retention deadline.
- Encrypted attachment blobs in private object storage while awaiting recipient delivery.
- Minimal associated routing information needed to deliver and delete those payloads.

Routing metadata may reveal sender/recipient identifiers, device IDs, approximate timing, size, and routing activity. The product should minimize it, but this version does not require zero server metadata.

### 5.4 Deletion wording

The product can promise that no **permanent server-side chat history** is maintained. It must not say that no message data ever reaches a server. On delivery, delete the server copy after a verified recipient acknowledgement, not merely after sending bytes to the recipient. Explain that deletion cannot erase screenshots, exports, notifications already displayed, or copies retained by recipient-controlled devices.

---

## 6. Authentication, account, and devices

### 6.1 Registration and sign-in

- Username + email + password registration.
- Email ownership verification by one-time code. OTP must have a short configurable expiry, one-time use, attempt limits, resend cooldown, and rate limits.
- Normal login through email/username + password after verification.
- Google OAuth/OIDC login options.
- Passwords must use a modern password-hashing algorithm such as Argon2id (or a well-maintained compatible alternative), unique salts, and parameters appropriate to the deployment.
- Apply throttling to registration, password verification, OTP requests, OTP guesses, OAuth callbacks, password reset, and device linking.

### 6.2 Device model

- One active primary mobile device per account in V1.
- Multiple authorized web-browser devices per account.
- Each device receives an independent cryptographic device identity.
- Web pairing, new-primary activation, revocation, and recovery must be authenticated, auditable, and replay-resistant.
- The account database stores public keys and device status only; private keys remain on devices or inside a user-controlled encrypted backup.
- User can view and revoke linked browsers and the current primary mobile device.

### 6.3 Recovery

- Recovery is opt-in and explained in plain language.
- Provide an encrypted local export/backup protected by a high-entropy recovery key or phrase, with versioned format and integrity verification.
- The server must not upload or keep the backup by default.
- An already-authorized device may approve/link a replacement where available.
- If the user loses all devices and has no valid export/recovery material, chat history is irrecoverable. Do not imply otherwise.
- Recovery format must include the cryptographic material and local data required by the selected protocol, subject to that protocol's design. Session keys cannot be assumed portable until the crypto proof of concept establishes how to back them up safely.
- Recovery key must never be sent to the server, included in analytics, or logged.

---

## 7. End-to-end encryption requirements

### 7.1 Mandatory implementation gate

No production chat implementation may ship until a crypto proof of concept demonstrates a free/open-source, maintained, established E2EE protocol that works across:

- React Native Android.
- React Native iOS.
- Vite/React web.
- Node.js server-side public-key bundle/pre-key handling, if needed by the chosen protocol.

The server must not possess decryption keys. The same user-facing message format must be transport-independent.

### 7.2 No custom cryptographic protocol

- Do not invent a new key exchange, ratchet, group protocol, or “AES wrapper” and call it E2EE.
- Use a documented, reviewed protocol implementation for asynchronous one-to-one messaging and a secure group-messaging protocol compatible with membership changes.
- `libsodium` is permissively licensed (ISC) and provides cryptographic primitives across platforms, but primitives alone do not implement a complete asynchronous messaging protocol. A protocol design cannot be improvised from those primitives.
- `libsignal` is a candidate for evaluation, not an automatic choice: its current repository is AGPLv3, says use outside Signal is unsupported, and its API/build integration is subject to change. Check license/distribution obligations and React Native/web integration before adopting it.
- Produce a written dependency/license matrix and receive an explicit engineering decision before freezing the crypto implementation.

### 7.3 Required security properties

The selected protocol and implementation must provide, as applicable:

- Authenticated key agreement and identity-key binding.
- Asynchronous message delivery to offline users through public pre-key material or the protocol's equivalent.
- Forward secrecy and post-compromise recovery/key rotation where supported by the protocol.
- Message integrity/authentication and replay resistance.
- Identity and safety-number/key-fingerprint verification or equivalent user-verifiable device verification.
- Multi-device model support for linked browsers.
- Secure group membership changes and rekeying.
- Attachment encryption with unique keys/nonces and authenticated content.
- Versioned ciphertext envelopes and migration strategy for protocol upgrades.

### 7.4 Attachment encryption

Encrypt files on the sender device before any upload or relay. Use a fresh random file key and authenticated encryption; deliver the file key to intended recipients through the E2EE message protocol. The object-store provider receives ciphertext, never a plaintext image/video/document.

### 7.5 Local encryption

- Keep private identity keys and recovery keys in the OS secure key storage where practical.
- Use an encrypted local SQLite database (SQLCipher subject to build-size/native compatibility tests) on mobile.
- Store keys for local database encryption in OS secure storage.
- Encrypt web-local data where practical and use browser-origin-scoped keys; document that browser-side protection is weaker than a native secure enclave/keystore.
- Exclude message content, keys, OTPs, and attachment plaintext from logs, crash reports, analytics, clipboard history, and push payloads where controllable.

---

## 8. Messaging features

### 8.1 Direct messages

- Start, resume, and delete one-to-one conversations.
- Text, emoji, reactions, reply/quote, edit/delete (with clearly defined sync semantics), local search, and message timestamps.
- Delivery and read receipts are optional user settings and never stored permanently server-side.
- Typing and online indicators are transient and expire quickly.
- Message sending uses a local outbox and a durable local message ID before network delivery begins.
- Delivery must be idempotent; retransmissions must not create duplicate visible messages.
- Handle reconnects, duplicate/late acknowledgements, network changes, and recipient device replacement.

### 8.2 Group chats

- Create groups, edit group name/avatar, add/remove members, leave group, and manage roles/permissions.
- Configurable group size limit; start with a conservative default and make it configurable until load/performance testing supports larger groups.
- Every message is encrypted for authorized group members by the selected group E2EE protocol.
- Membership changes must change/revoke cryptographic group access according to the protocol; removed members must not obtain future messages.
- Server can store group/account membership metadata required for routing, but not plaintext group history.
- A group message that cannot be delivered immediately may be queued separately for each recipient/device, subject to the same 14-day server retention cap.
- Group audio/video calls are out of scope; no “call group” action should exist.

### 8.3 Message states

Use explicit, non-ambiguous states such as:

- `local_queued`
- `sending`
- `sent_to_server`
- `waiting_for_nearby_route`
- `relayed`
- `delivered_to_recipient_device`
- `read` (if enabled)
- `expired_undelivered`
- `failed`

The app must not show “delivered” merely because a relay device or server accepted a packet. A final delivery state requires recipient-device acknowledgement. “Relayed” means only that a mesh relay accepted the encrypted packet.

---

## 9. Internet delivery mailbox and retention

### 9.1 Environment-controlled policies

Suggested initial variables:

```env
MESSAGE_REDIS_STAGE_SECONDS=50400
MESSAGE_MAX_RETENTION_SECONDS=1209600
MESSAGE_MIGRATION_GRACE_SECONDS=900
ATTACHMENT_MAX_BYTES=104857600
ATTACHMENT_MAX_RETENTION_SECONDS=1209600
MESH_PACKET_MAX_HOPS=8
MESH_PACKET_TTL_SECONDS=1209600
```

`50400` seconds is 14 hours; `1209600` seconds is 14 days; `104857600` bytes is 100 MiB. Decide whether UI labels use MB or MiB and be consistent. All TTL values must be validated as positive bounded integers at startup.

### 9.2 Lifecycle

1. Sender encrypts and stores the message locally.
2. If online, the client sends the encrypted envelope to the Node.js gateway.
3. If recipient is online, route the envelope to the recipient connection and await recipient acknowledgement.
4. If recipient is offline, place the envelope in Redis's hot mailbox.
5. Redis hot-staging target is 14 hours. A migration worker must claim due entries before their Redis safety expiry, write them idempotently to MongoDB, verify the durable write, and only then delete the Redis copy.
6. MongoDB entries are temporary delivery records, not chat-history records. Keep the original absolute `expiresAt = createdAt + MESSAGE_MAX_RETENTION_SECONDS`.
7. If the recipient reconnects before expiry, deliver ciphertext, wait for recipient acknowledgement, then delete the server envelope from whichever store owns it.
8. If the absolute 14-day deadline passes without recipient acknowledgement, delete the envelope and mark it expired for sender-side UI when that information can be returned.
9. The sender's local conversation history remains locally available unless the sender deletes it; server expiry does not delete local history.

### 9.3 Reliability requirements

- Do not rely solely on Redis key-expiration notifications to migrate records. TTL expiry deletes data; it is not a durable migration queue.
- Use a migration index/schedule and a safety TTL that gives the worker time to migrate the record. The application-configured 14-hour stage transition and the physical Redis cleanup TTL are distinct.
- Migration must be idempotent, retryable, observable, and safe against races with recipient delivery and acknowledgement.
- Use a unique message/envelope ID and deterministic delivery identity. MongoDB write must be idempotent.
- On server restart, worker restart, Redis connection failure, or MongoDB outage, the worker must resume safely without knowingly deleting the only server-side copy before a replacement is durable.
- A periodic reaper must remove expired envelopes and attachment metadata even if TTL indexes/events or workers were delayed.
- Never log ciphertext or file keys unnecessarily; message IDs and minimal operational status are sufficient for most metrics.

### 9.4 Required environment and monitoring

Monitor counts/ages of Redis-stage items, migration backlog, oldest pending mailbox item, Mongo temporary mailbox count, expired-message deletes, migration retry/failure count, attachment object age, deletion failures, and storage/command usage. Alerts must fire before backlog or provider limits cause data loss.

---

## 10. Attachments and file handling

### 10.1 File types and size

- Support image, video, voice/audio, and document/file attachments.
- Maximum single attachment size is 100 MB after optional compression.
- In V1, only images and videos are eligible for media compression. Do not silently zip/compress general documents.
- Default the image/video compression option to enabled; the user can disable it for an uncompressed original when it meets limits.
- Before sending, display the original size and estimated compressed size/quality where possible.
- If an image/video exceeds 100 MB, offer compression and allow sending only if the resulting file meets the configured limit. If it still exceeds the limit, explain why it cannot be sent.
- If a non-compressible document is over the limit, reject it with a clear error.
- Validate size and MIME/signature on the sending client and again at the server/object-storage gateway. Do not trust file extensions alone.

### 10.2 Storage and delivery

- Keep the canonical user attachment in the sender's local file system.
- If recipient is online, prefer direct encrypted transfer where feasible; otherwise use encrypted temporary object staging when the sender has Internet access.
- If sender and recipient both lack Internet, use chunked encrypted store-and-forward through nearby devices.
- Server-side staging is never a permanent media library.
- Use private objects and short-lived signed URLs. Encrypt before upload; the storage provider must not receive decryption keys.
- Link staged object expiry to the earlier of recipient acknowledgement, attachment expiry, or the associated message's maximum retention deadline.
- Delete staged objects after recipient-device acknowledgement; a scheduled janitor must delete objects after expiry, including orphaned uploads and partial multipart uploads.
- Treat an upload as incomplete until its integrity/hash check succeeds. Use resumable/chunked transfer for large attachments.
- Do not use cloud-provider transformations on encrypted blobs. Compression, thumbnail generation, and preview generation happen locally before encryption.
- Do not promise physical media erasure from provider backups beyond the provider's documented deletion guarantees; the product policy is to remove live objects and avoid any permanent application-managed object copies.

### 10.3 Temporary provider recommendation

Evaluate Cloudflare R2 or an equivalent private object-storage provider. R2 currently advertises a free allowance of 10 GB-month of Standard storage, 1 million Class A operations, 10 million Class B operations per month, and free Internet egress, with charges beyond allowances. Pricing can change and must be rechecked before launch. Cloudinary is not the default recommendation because the app needs encrypted temporary blob storage, not server-side media transformations.

---

## 11. Offline nearby messaging and multi-hop mesh

### 11.1 Required modes

1. **Direct Nearby Mode:** two devices discover and exchange packets without Internet access.
2. **Store-and-forward relay:** an opted-in intermediate device temporarily stores an encrypted packet and forwards it when it encounters the next reachable device.
3. **Mixed route:** use Internet delivery when available; fall back to nearby delivery when the Internet is unavailable. Transport selection must not change the E2EE content format.

### 11.2 Transport layer

Create a native transport abstraction, for example:

```ts
interface NearbyTransport {
  startDiscovery(): Promise<void>;
  stopDiscovery(): Promise<void>;
  connect(peer: PeerDescriptor): Promise<PeerConnection>;
  send(peer: PeerDescriptor, packet: Uint8Array): Promise<void>;
  onPacket(handler: (packet: Uint8Array) => void): Unsubscribe;
}
```

The implementation may use Bluetooth LE and platform-appropriate peer-to-peer Wi-Fi options. Do not hard-code the design to an API that is deprecated on one platform. Choose concrete native libraries/APIs only after a proof of concept across current Android and iOS devices.

### 11.3 Encryption and relay behavior

- End-to-end encrypt packet contents for the intended user/device or authorized group using the selected messaging protocol.
- Sign/authenticate origin and packet integrity as supported by the selected protocol.
- Intermediate nodes can forward ciphertext but must not have decryption keys for messages not intended for them.
- Relay-visible data is minimized but may include a destination routing token, packet ID, expiry, hop budget, approximate size, and origin/routing identifiers. Do not promise metadata secrecy from relays.
- Relay acceptance is not recipient delivery; final acknowledgement comes from the destination device.
- A relay must not be able to alter the payload without detection.

### 11.4 Loop, abuse, and storage limits

- Every packet has a unique ID, creation time, absolute expiry, destination routing identifier/token, hop budget, packet type, ciphertext or encrypted chunk, and integrity/signature metadata.
- Set a configurable default maximum of 8 hops as an initial value for testing, not a permanent protocol constant.
- Maintain a bounded seen-packet cache to avoid duplicates and routing loops.
- Decrement hop budget at each forwarding hop; reject expired, malformed, oversized, or over-budget packets.
- Start with a configurable local relay-storage cap (proposed default 250 MB) and per-sender quotas/rate limits; allow the user to clear relay cache.
- Set battery/network policies. Do not automatically relay when the user has disabled participation, is in low-storage mode, or has selected a restricted battery/data mode.
- Use chunked file delivery for large files, with integrity verification per chunk and for the full file. Mesh relays must support resuming after devices go out of range.
- Rate-limit packet creation, relay frequency, per-origin quota, and discovery attempts to reduce spam/denial-of-service risks.
- Provide an explicit “Allow this device to relay messages” opt-in and an easy off switch. Explain that relays can see some routing metadata and temporarily consume battery/storage.

### 11.5 Background behavior and product promise

Background mesh is a must-have design requirement, but operation is best-effort. The application should support native background modes, state restoration, and OS-approved scheduling where possible. It must communicate that the operating system, battery settings, force-quit state, manufacturer restrictions, and radio availability can pause or stop relaying. Apple documents that background Bluetooth scanning/advertising behaves differently from foreground operation and that the OS can terminate the app; therefore do not promise continuous background mesh on iOS. Equivalent Android permission/foreground-service constraints must also be tested.

### 11.6 Offline UX

Show clear states such as:

- “Queued on this device — waiting for a nearby route.”
- “Forwarded by 2 devices — not yet delivered.”
- “Delivered to recipient.”
- “Expired before delivery.”

Do not display a misleading sent/delivered indicator when a message has only reached an intermediate device. Explain that mesh delivery is opportunistic and cannot guarantee delivery until a valid path appears.

---

## 12. One-to-one audio/video calls

### 12.1 Scope

- One-to-one audio calls and video calls only.
- No group calls, SFU, or media server.
- Use WebRTC peer connections for media; media should flow directly between peers when possible. TURN relays media when direct connectivity fails.
- Node.js is used only for authenticated call signaling and transient call state.
- STUN/TURN configuration must be replaceable via environment variables. Use authenticated, short-lived TURN credentials; never embed a permanent TURN secret in a client app.

### 12.2 Call features

- Incoming/outgoing call, accept/reject, busy, no-answer/timeout, hang-up, reconnecting, failed, and completed states.
- Audio mute/unmute, video enable/disable, camera switch, speaker/earpiece selection, permission handling, and network-state handling.
- Calls work over Internet only. Nearby offline calling is explicitly out of scope.
- Signaling messages must be authenticated and bound to caller/callee device identities. Expire call offers and ICE/signaling state quickly.
- No server-side call recording. Push notifications must not contain media, message content, or secrets.
- Test direct P2P and TURN-relayed calls across mobile networks, Wi-Fi, restrictive NAT, network switches, browser-to-mobile, and mobile-to-mobile.

---

## 13. Web client and QR pairing

### 13.1 Pairing flow

1. Web page creates a short-lived pairing request and displays a QR code.
2. QR contains a one-time pairing ID/challenge and server endpoint/reference—not a password or private key.
3. Mobile scans the QR, displays browser/device details for user approval, and authenticates the request.
4. Both devices complete an authenticated key-establishment/pairing protocol. The web browser gets its own device identity and is registered as authorized.
5. QR/pairing request expires quickly, is single-use, and cannot be replayed. Web can be revoked by the mobile device.

### 13.2 Recent history synchronization

- Mobile is the authoritative source for its local history.
- Sync the recent-history window first; make its duration/count configurable. Allow the user to request older messages or sync a specific conversation when the mobile is available.
- Sync in bounded batches with progress, pause/resume, duplicate detection, and integrity checks.
- Transfer directly between mobile and browser through an authenticated encrypted channel where feasible. If a server relay is needed, it may hold only encrypted sync chunks temporarily, with strict short expiry and immediate deletion after acknowledgement.
- Sync text/message metadata first; transfer attachment ciphertext or thumbnails as needed. Full attachment download should be on demand to avoid copying huge local media libraries by default.
- Browser history is stored locally in IndexedDB. Clearing site data may remove it; the user can re-pair and resync from mobile.
- When mobile is offline/unavailable and the browser does not already have the relevant local history, the server cannot reconstruct it.
- Web features may be reduced where browser/native APIs do not support the same Bluetooth/background capabilities as mobile.

---

## 14. Local storage, device size, and attachment cache

### 14.1 Mobile storage

Use SQLite for conversation/message records, indexes, local delivery state, and attachment references. Store binary media in the filesystem as separate encrypted files. The database engine itself is not the main source of storage growth; attachment bytes and thumbnails will dominate it.

Suggested local entities:

- `conversations`
- `messages`
- `group_memberships`
- `attachments`
- `outbox`
- `delivery_state`
- `seen_mesh_packets` (bounded and expiring)
- `device_sync_state`
- `local_settings`

Store the database encryption key in OS secure storage. Test SQLCipher native build size and performance on low-end supported devices before making it unconditional. Local cache policy should expose storage usage, attachment cache size, clear-cache controls, and per-chat media management.

### 14.2 Browser storage

Use IndexedDB, not localStorage, for conversation history and attachment metadata. Large media should be downloaded only as required and subject to a configurable cache policy. Browser storage can be evicted by the browser/OS, so the UI must not imply it is an immutable backup.

### 14.3 Storage controls

- User can delete a local conversation and its locally stored attachments.
- “Delete for me” removes local copies; “request deletion from everyone” is best-effort and cannot guarantee destruction of recipient-controlled copies.
- Clear-cache must not accidentally delete message history unless the UI explicitly states so.
- Mesh relay cache and user chat history must be separate, so clearing one does not silently erase the other.

---

## 15. Backend modules and responsibilities

Keep these in the same modular monolith initially:

- **Auth module:** password, email OTP, OAuth callbacks, refresh/session management, abuse throttles.
- **Account module:** username, profile fields, privacy settings, account lifecycle.
- **Device module:** primary-mobile status, device keys/public bundles, linked web clients, revocation.
- **Crypto directory module:** stores/serves public keys and protocol-specific public pre-key bundles; never receives private keys.
- **Realtime gateway:** authenticated WebSocket connections and routing.
- **Delivery module:** Redis hot mailbox, MongoDB delayed mailbox, acknowledgements, expiry, idempotency.
- **Attachment staging module:** signed upload/download URLs, object metadata, expiry, deletion worker, size/content validation.
- **Group module:** membership/roles and routing metadata; no plaintext group history.
- **Call signaling module:** ephemeral offers/answers/ICE and call-state expiry.
- **Web pairing/sync module:** one-time pairing challenges and encrypted history sync coordination.
- **Mesh support module:** protocol version exchange, optional rendezvous/routing-token support, minimal observability; nearby forwarding itself runs on devices.
- **Background worker:** Redis-to-Mongo migration, expirations, attachment orphan cleanup, OTP expiration, inactive pairing cleanup, and other retryable jobs.
- **Security/abuse module:** rate limits, blocks, reporting inputs, account/device revocation, suspicious traffic controls.

Avoid microservice deployment unless scale/operational requirements justify it.

---

## 16. Indicative database and event models

These are logical examples, not a locked schema. Sensitive fields and retention indexes must be refined during implementation.

### 16.1 MongoDB `users`

```json
{
  "_id": "user_id",
  "username": "unique_username",
  "email": "verified_email",
  "passwordHash": "optional_hash_for_password_auth",
  "authProviders": ["password", "google"],
  "status": "active",
  "createdAt": "timestamp",
  "updatedAt": "timestamp"
}
```

Never store plaintext passwords, recovery keys, private identity keys, or local chat history in this collection.

### 16.2 MongoDB `devices`

Contains `deviceId`, `userId`, platform/type, public identity key, protocol public bundle/prekeys, key version, primary/linked status, created/revoked timestamps, and minimal sync/pairing metadata. Private keys are never uploaded.

### 16.3 Temporary MongoDB `pending_envelopes`

```json
{
  "_id": "unique_envelope_id",
  "senderDeviceId": "device_id",
  "recipientDeviceId": "device_id",
  "ciphertext": "opaque_e2ee_payload",
  "createdAt": "timestamp",
  "stageChangedAt": "timestamp",
  "expiresAt": "original_creation_plus_max_retention",
  "deliveryState": "pending"
}
```

Collection requirements:

- Unique envelope ID for idempotency.
- TTL index on `expiresAt` as a cleanup backstop, plus a worker/reaper that checks expirations explicitly.
- No plaintext message body, plaintext title/preview, decrypted sender text, or permanent conversation history.
- `expiresAt` always represents the absolute retention limit from original creation. Migration must not reset the 14-day retention clock.

### 16.4 Attachment metadata

Store only the object identifier, ciphertext byte size, encrypted content key delivery reference (not the key itself), creation/expiry timestamps, checksum, pending recipient/ack state, and cleanup status. Use private object storage. Do not store permanent public URLs or plaintext thumbnails.

---

## 17. Environment configuration baseline

All secrets must be provided from environment/secret management and must not be committed to the repository.

```env
NODE_ENV=development
PORT=3000
PUBLIC_API_URL=
PUBLIC_WS_URL=

MONGODB_URI=
UPSTASH_REDIS_URL=
UPSTASH_REDIS_TOKEN=

MESSAGE_REDIS_STAGE_SECONDS=50400
MESSAGE_MAX_RETENTION_SECONDS=1209600
MESSAGE_MIGRATION_GRACE_SECONDS=900
MESSAGE_REAPER_INTERVAL_SECONDS=60

ATTACHMENT_MAX_BYTES=104857600
ATTACHMENT_MAX_RETENTION_SECONDS=1209600
ATTACHMENT_OBJECT_STORE_ENDPOINT=
ATTACHMENT_OBJECT_STORE_BUCKET=
ATTACHMENT_OBJECT_STORE_ACCESS_KEY=
ATTACHMENT_OBJECT_STORE_SECRET_KEY=
ATTACHMENT_PRESIGNED_URL_TTL_SECONDS=300

EMAIL_PROVIDER=
EMAIL_API_KEY=
EMAIL_FROM=
EMAIL_OTP_TTL_SECONDS=600
EMAIL_OTP_RESEND_COOLDOWN_SECONDS=30

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
FACEBOOK_APP_ID=
FACEBOOK_APP_SECRET=

WEB_PAIRING_TTL_SECONDS=120
MESH_PACKET_MAX_HOPS=8
MESH_PACKET_TTL_SECONDS=1209600
MESH_RELAY_STORAGE_LIMIT_BYTES=262144000

STUN_URLS=
TURN_URLS=
TURN_SHARED_SECRET=
TURN_CREDENTIAL_TTL_SECONDS=3600

ACCESS_TOKEN_TTL_SECONDS=
REFRESH_TOKEN_TTL_SECONDS=
```

Implementation must use a typed configuration schema, fail fast on missing production secrets, and never bundle server secrets into mobile or web builds. Do not expose TURN shared secrets, object-store secret keys, database URLs, or social-provider client secrets to clients. Public OAuth client IDs and TURN credentials generated with short expirations may be exposed as required, but server secrets may not.

---

## 18. Reliability, performance, and operational requirements

- All delivery and migration handlers must be idempotent.
- Every network request and job must have timeouts, bounded retries with backoff, and structured failure handling.
- Use message IDs, recipient-device IDs, and protocol versioning to prevent duplicates and support upgrades.
- Do not rely on an in-memory queue for the only copy of an undelivered message.
- Store undelivered server messages only as ciphertext and preserve the absolute expiry during migration.
- Use indexes on user ID, device ID, recipient ID, expiry, and delivery state as required by access patterns.
- Rate-limit authentication, OTPs, delivery attempts, attachment uploads, WebSocket events, call invitations, pairing, and mesh rendezvous.
- Avoid logging message content, attachment keys, recovery keys, access/refresh tokens, OTPs, SDP content longer than needed, or raw authentication payloads.
- Add redacted operational metrics: message queue age/count, migration backlog, call setup failure, TURN usage, attachment staging storage, delivery acknowledgements, duplicate rate, mesh relay counts, and cleanup failures.
- Establish cost alerts before free-tier limits are exceeded. Protect against abuse that intentionally uploads many large encrypted files or creates never-delivered message queues.
- Backups of the account metadata database must not contain conversation history or permanent attachment payloads. If temporary ciphertext appears in infrastructure backups, retention/deletion wording must reflect that; configure backups and retention so they do not accidentally preserve temporary chat payloads beyond policy.

---

## 19. Acceptance criteria

### 19.1 E2EE and server privacy

- A network capture of a message sent through the backend contains only the selected protocol's encrypted envelope, not plaintext message text.
- MongoDB/Redis inspectors cannot recover plaintext chat content or attachment keys from stored envelope records.
- Intermediate mesh device B can forward an A-to-C message but cannot decrypt or alter it undetectably.
- Group membership removal prevents a removed member from decrypting future group messages, according to the selected protocol.
- Private keys/recovery keys never appear in server logs, analytics, crash reports, or environment values sent to clients.

### 19.2 Mailbox and deletion

- An offline recipient's encrypted message is queued in Redis.
- At the configured 14-hour staging boundary, the worker migrates it to MongoDB, verifies the durable write, and then deletes the Redis copy.
- If MongoDB is unavailable during migration, the Redis copy remains available and migration retries without data loss.
- If recipient delivery races with migration, exactly one logical delivery occurs; duplicate copies are cleaned safely.
- On recipient acknowledgement, the envelope is removed from Redis/MongoDB and is no longer fetchable by the client.
- An undelivered envelope expires no later than 14 days after original creation under default configuration, not 14 days after migration.
- A sender's local history remains intact after server-side expiration until the user deletes it.

### 19.3 Attachments

- Images/videos are compressed by default; users can opt out when file size permits.
- A file larger than 100 MB is blocked unless eligible image/video compression produces a file within the limit.
- A non-compressible document over 100 MB is rejected with an understandable message.
- The upload path transmits encrypted bytes only; object-store access is private and signed URLs expire.
- Successful recipient acknowledgement deletes the staged object; a scheduled reaper removes expired/orphaned staged objects and incomplete multipart uploads.
- When both endpoints have no Internet, nearby mesh can transfer a file in chunks, verify integrity, resume after interruption, and acknowledge only after the recipient has assembled and verified the complete file.

### 19.4 Offline and mesh

- Two nearby devices can exchange text with mobile data/Wi-Fi Internet disabled.
- Three devices can relay an encrypted packet A → B → C; B cannot read it and C can decrypt it.
- Duplicate encounters do not create duplicate messages.
- Expired and over-hop-limit packets are dropped.
- Users can opt in/out of relaying; disabling relay stops forwarding new third-party packets.
- UI distinguishes local queue, relay acceptance, and final recipient delivery.
- Tests cover foreground, background, screen-locked, OS-killed, low-battery, low-storage, Bluetooth denied, and airplane-mode scenarios on real devices. Background success is best-effort and platform-specific; failures must degrade visibly, not corrupt or silently lose local messages.

### 19.5 Calls and web pairing

- Audio/video calls work between mobile devices and between web/mobile where supported.
- Calls establish direct WebRTC where possible and use TURN when necessary; the backend never stores a call recording.
- Group call actions are absent.
- QR pairing uses a one-time expiring challenge, requires mobile approval, and rejects replayed or expired QR payloads.
- Web history sync transfers only the configured recent window by default and does not create permanent server history.
- Revoking a browser prevents new access and rotates/revokes that device's authorization as supported by the selected E2EE protocol.

---

## 20. Suggested implementation sequence

Offline mesh is part of the required product, not an optional product feature. The sequence below manages technical risk; it does not remove mesh from the launch requirements.

### Phase 0 — Feasibility spikes (mandatory before committing architecture)

1. E2EE protocol/license spike covering Android, iOS, browser, Node, one-to-one messaging, groups, recovery, and linked-browser devices.
2. Native nearby connectivity spike for Android↔Android, iOS↔iOS, and Android↔iOS, including background/locked-device behavior.
3. Chunked 100 MB encrypted file transfer over nearby links with interrupted-transfer resume.
4. WebRTC direct/TURN call spike on mobile/mobile and mobile/web.
5. Upstash Redis + chosen queue/worker proof of concept, measuring idle command usage and command compatibility.
6. Temporary object-store proof: private encrypted 100 MB object, signed URL, acknowledge/delete, lifecycle expiry, and multipart-abort cleanup.

### Phase 1 — Secure foundations

- Monorepo, CI, typed configuration, account/auth, email OTP, OAuth, device registry, secure-key storage, local DB migrations, chosen crypto adapter, key verification, audit/logging rules.

### Phase 2 — Core Internet chat and delivery

- Direct messaging, groups, local history, WebSocket delivery, acknowledgements, Redis hot mailbox, Mongo fallback, retention worker, rate limiting, push notifications without content.

### Phase 3 — Attachments and QR-linked web

- Encryption/compression, 100 MB validation, temporary object staging, object cleanup, QR device pairing, IndexedDB, recent-history sync, attachment on-demand sync, browser revocation.

### Phase 4 — Offline nearby and mesh

- Direct nearby messaging, transport abstraction, relay opt-in, hop/TTL/dedupe rules, chunked file transfer/resume, background capabilities, storage quotas, UX statuses, battery/privacy controls. This phase must be completed and validated before the product is described as satisfying the offline-mesh launch requirement.

### Phase 5 — Calls and hardening

- One-to-one WebRTC calls, STUN/TURN, push call invitation, network transition recovery, load/cost/security testing, retention/deletion audits, incident runbooks, and release readiness.

---

## 21. Key technical risks and mitigation

| Risk                                                    | Mitigation                                                                                                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| E2EE library does not support RN, web, and Node cleanly | Do a mandatory crypto/library proof of concept before building the message engine; never fall back to custom cryptography                      |
| Current libsignal licensing/API stability is unsuitable | Evaluate its current AGPLv3 obligations and integration limits; document alternatives and select a protocol/library only after review          |
| iOS cannot run continuous background mesh               | Treat background delivery as best-effort; use available background Bluetooth modes responsibly, show queue status, and test on devices         |
| Multi-hop large files drain battery/storage             | Chunk payloads, opt-in relaying, quota/expiry/hop limits, pause/resume, configurable data/battery controls                                     |
| Redis-to-Mongo migration loses data                     | Worker migrates before Redis hard expiry, idempotent Mongo writes, confirm-before-delete, safety TTL and a reaper                              |
| Free Redis tier becomes costly under BullMQ polling     | Benchmark commands/idle polling; use BullMQ only if it remains cost-effective; consider a simple scheduled worker on an always-on small server |
| Free tiers change or sleep                              | Keep provider interfaces abstract, check current allowances and terms before launch, add usage alerts and a migration plan                     |
| Attachment objects outlive the message                  | Tie object expiry to message expiry, delete on ACK, run orphan cleanup and provider lifecycle rules                                            |
| User loses every device and backup                      | State clearly that local history is unrecoverable without a valid export/authorized device; never claim the server can restore history         |
| Server metadata reveals social graph/timing             | Minimize retained metadata, keep transient presence/call state short-lived, and explain the privacy boundary accurately                        |

---

## 22. Initial low-cost Providers

A low-budget launch can start with the following Providers, subject to verification of each provider's current free-tier limits and uptime constraints:

Database: MongoDB Atlas free tier (shared cluster, 512 MB storage, 100 concurrent connections). Verify current limits before launch.
Redis: Upstash free tier (shared Redis, 250mb storage, 10gb bandwidth, 500K monthly requests). Verify current limits before launch.
Queue/worker: Upstash BullMQ integration or upstash Qstash. Verify current limits before launch.
Email Provider: Zoho mail or zepto cpass mail. determined by EMAIL_PROVIDER environment variable. Verify current limits before launch.
storage: nor now use cloudinary, it provides free 25 credits per month, but use it only for parmanent storage like profile picture, for temporary storage use VPS storage.

---

## 23. Final architecture principles

1. **Devices own history.** Servers do not maintain a permanent chat archive.
2. **E2EE is mandatory.** The backend and relay devices cannot decrypt message or attachment contents.
3. **Temporary means temporary.** Redis, MongoDB delivery records, and staged file objects require explicit expiry, acknowledgements, migration, cleanup, and monitoring.
4. **A transport is replaceable.** Internet, Bluetooth, Wi-Fi peer-to-peer, and mesh carry the same encrypted protocol packets.
5. **Mesh is opportunistic.** Forwarding can improve offline delivery but cannot guarantee a route or evade OS background restrictions.
6. **Calls stay one-to-one.** WebRTC peer connections use STUN/TURN as needed; no group calling/media server is required.
7. **Keep the deployment simple.** Build a modular monolith, verify the risky integrations early, and add independent deployment units only for a demonstrated need.
8. **No security shortcuts for free hosting.** Free/low-cost infrastructure is preferred, but key management, cryptographic protocol review, integrity, deletion correctness, and user consent are release blockers.
