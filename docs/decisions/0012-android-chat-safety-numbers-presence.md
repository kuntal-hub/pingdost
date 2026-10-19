# 0012 — Android 1:1 chat: safety numbers, presence, profiles and the local store

- **Status:** Accepted
- **Date:** 2026-10-19
- **Phase:** 10
- **Approved by user:** n.a.

## Context
- Phase 10 puts the Phase 9 engine (ADR 0011) into the Android app. The requirements:
  - REQ §7.3: user-verifiable identity (safety numbers);
  - REQ §8.1: transient typing and online indicators;
  - REQ §8.3 / §11.6: honest states;
  - REQ §14.1: local storage.
- ADR 0003 proposed the safety-number format; this phase finalizes it.
- Three gaps surfaced:
  1. Presence had no server relay. The server keeps no contact list, so it cannot know whom to tell.
  2. An incoming chat reveals only the sender's user ID: no username or avatar.
  3. protobuf-es needs a global `TextDecoder` that honours `fatal: true`. Hermes support is unclear, and Expo installs no polyfill.

## Options considered
| Option | Pros | Cons | License | Cost |
|---|---|---|---|---|
| **Presence:** explicit watch lists, reciprocal (chosen) | No contact list on the server; a user sees only the chat they open | Online state shows only while a chat is open | — | — |
| Presence to everyone who ever exchanged envelopes | Like other messengers | The server would build a social graph | — | — |
| **TextDecoder:** feature-detect, then our WHATWG UTF-8 decoder (chosen) | No dependency; differential tests against Node's decoder | Code to maintain (≈100 lines, not cryptography) | — | — |
| fast-text-encoding | Maintained by Google | Throws for `fatal: true` | Apache-2.0 | — |
| text-encoding-utf-8 | Spec algorithm | No license field; unmaintained | — | — |
| @borewit/text-codec, @bacons/text-decoder | Small | No `TextDecoder` class (borewit); `fatal` undocumented (bacons) | MIT | — |
| **QR rendering:** `qrcode-generator` + Views (chosen) | Pure JS, no native module | ≈ hundreds of Views per code | MIT | — |
| react-native-svg / react-native-qrcode-svg | Crisper drawing | Another native module | MIT | — |
| **SHA-512 for safety numbers:** `@noble/hashes` (chosen) | Audited, synchronous, shared by web and mobile | — | MIT | — |
| expo-crypto `digestStringAsync` | Native | 10,400 async bridge calls per number; mobile only | MIT | — |

## Decision
1. **Safety numbers** (`@pingdost/protocol/safety-number`; finalizes ADR 0003).
   - Fingerprint per user: SHA-512(`version` (2 bytes, big-endian, 1) ‖ account identity key (32 bytes) ‖ user ID (16 bytes)), then 5,200 rounds of `SHA-512(hash ‖ key)`. The first 30 bytes are the fingerprint.
   - Digits: six 5-byte big-endian chunks, each mod 100,000, give 30 digits per user. The lower 30-digit string goes first, so both phones show the same 60 digits (12 groups of 5).
   - QR code: `pingdost:sn:` + base64url(version ‖ shower's fingerprint ‖ scanner's fingerprint).
     - The scanner accepts it only if both halves equal what it computed itself.
     - Results: `match`, `mismatch`, `invalid`, `unsupported_version`.
     - On `match`, `engine.markVerified(user, key)` stores the verified account identity key. Verification lapses on its own when the key changes, and the engine adds a "safety number changed" notice (ADR 0011).
   - The construction is cross-checked against `node:crypto` in tests, and a pinned vector protects existing safety numbers.
2. **Presence** (`Presence.watch_user_ids`, field 3, add-only).
   - A client sends `Presence{online, watch_user_ids}`. The list replaces the previous one, with at most 32 users.
   - The gateway's `PresenceHub` is in memory only and never writes anywhere.
     - A user is online while one of their sockets says it is in the foreground.
     - Watchers hear only about users who share `privacy.lastSeen`, and only if they share their own (reciprocal).
     - The privacy cache (15 s) is invalidated on `PATCH /v1/me`.
   - The app watches only the open chat's peer. It sends `online: false` when backgrounded, and the socket closes 30 s later.
3. **Profiles:** `GET /v1/users/:userId` returns the public profile (`UserLookupResponse`; separate `userProfile` rate limit, 300 per 15 min). It cannot enumerate users: IDs are random UUIDv7s learned only from messages. The app caches profiles in a `contacts` table and refreshes them daily.
4. **TextDecoder:** `src/polyfills.ts` installs `Utf8TextDecoder` (`src/utils/utf8-decoder.ts`) only when the global decoder is missing or does not throw on invalid UTF-8 with `fatal: true`.
5. **Local store:** migration 002 creates the REQ §14.1 tables plus the engine's own (`crypto_sessions`, `device_directory`, `directory_devices`, `seen_ids`, `contacts`) and `messages_fts` (FTS5, filled in Phase 11).
   - `SqliteEngineStore` runs `apply` as one queued `BEGIN IMMEDIATE … COMMIT` on the keyed connection.
   - The account pickle goes into the `crypto_store` row that `CryptoStore` uses.
   - The store passes `runEngineStoreContract` on `node:sqlite` with the real migrations.
6. **Runtime** (`src/engine/runtime.ts`).
   - One engine per process, started in the `ready` stage and stopped otherwise.
   - On foreground the socket connects with presence online. In the background presence goes off at once and the socket closes after 30 s.
   - When the network returns it reconnects at once. Close code 4001 refreshes the token through the auth store.
   - On `revoked`, the app stops the engine, wipes the chat tables and sessions, and signs out. Setup's account reset after a revocation wipes them too.
   - **While the engine runs, every Olm account change goes through it** (`engine.replenishKeys`, with `ensureFallback` at start). The app-level `replenishKeys` was removed: concurrent pickle writes could have stored an older account.
7. **Navigation:** `(app)` is a Stack. `(tabs)` (NativeTabs: Chats, Settings) is its first screen, and `chat/[conversationId]`, `new-chat`, `contact/[userId]`, `scan/[userId]` and `message-info/[messageId]` (modal) are pushed over the tabs.
8. **Honest labels** (`src/engine/labels.ts`):
   - Queued: "Queued on this device — waiting for a connection" (or "… for a nearby route").
   - Sending.
   - "Sent to the server — not yet delivered".
   - "Delivered to the recipient's device", only after a receipt.
   - Read.
   - "Expired before delivery".
   - "Not sent · Tap to retry".
   - Message info lists each device; the sender's own devices are marked as never counting.
9. **Libraries:**
   - `@shopify/flash-list` 2.3.2;
   - `expo-image` 58.0.16 (avatars, memory+disk cache);
   - `expo-camera` 58.0.11, QR scanning only, with no microphone. It moved here from Phase 16. The image picker now passes a camera usage string instead of blocking `CAMERA`, which would have removed the permission from the merged manifest.
   - `qrcode-generator` 2.0.4;
   - `@noble/hashes` 2.4.0 (protocol).

## Consequences
- Phase 11 adds read receipts (`receipts('read')`) and the delivery-receipt toggle. FTS fills `messages_fts`.
- Phase 16 can use the installed expo-camera for pairing; the permission text may need widening.
- Phase 17 (web) uses the same safety-number module and the same presence frames.
- Presence state lives in one API instance (ARCHITECTURE A2). Several instances would need a shared hub.
- The `contacts` cache holds only public profile fields.

## Evidence
- `@pingdost/protocol` tests: safety-number symmetry, a pinned vector, the `node:crypto` cross-check, QR match/mismatch/invalid/version, and the presence watch-list limits.
- Server: `presence.test.ts` (4 tests) and the gateway integration test (watch, foreground/background/close, reciprocity after `PATCH /v1/me`); `GET /v1/users/:id` in `profile.int.test.ts`.
- Mobile:
  - `utf8-decoder.test.ts`: 400 randomized inputs match Node's decoder in lenient and fatal modes;
  - `sqlite-store.test.ts`: the contract, atomicity, wipe, and the engine end to end on SQLite;
  - `labels.test.ts`: no state other than a recipient receipt reads "delivered".
- Device results are in PROGRESS (Phase 10).
