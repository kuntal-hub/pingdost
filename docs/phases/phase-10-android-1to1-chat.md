# Phase 10 — 1:1 encrypted chat on Android

**Depends on:** 07, 09 · **Platforms:** Android

## Goal
Real users can find each other by username and chat 1:1 with E2EE on Android. Delivery statuses are honest, history is local and encrypted, contacts can be verified, and typing and presence are transient.

## Read first
- REQ §7.3 (verification), §8.1, §8.3, §11.6 (status wording), §14.1, §14.3
- ARCHITECTURE A6, A8
- **Load skill `expo:expo-overview`**

## Tasks
- [ ] **SQLite migration 002:** REQ §14.1 tables (conversations, messages, group_memberships, attachments, outbox, delivery_state, seen_mesh_packets, device_sync_state, local_settings), crypto sessions, the device-directory cache, and an FTS5 table for message text (populated in Phase 11). Add indexes for the access patterns.
- [ ] **`SqliteEngineStore`** implementing `EngineStore`. Run the engine's store contract tests against it; write a shared contract-test suite in message-engine if one is missing.
- [ ] **Engine lifecycle:** a singleton started after auth. AppState: connect on foreground; disconnect after a background grace period. Handle network changes (NetInfo) and the token refresh hook.
- [ ] **Screens:**
  - **Chats list:** last-message preview (decrypted locally), unread counts, status icons, empty state.
  - **New chat:** exact username lookup → profile card → start the conversation.
  - **Chat:** FlashList, paginated from SQLite; composer; day separators; per-message status with **honest labels** (REQ §8.3 / §11.6 copy); retry on failure; long-press **Message info** shows per-device states.
  - **Contact info:** safety number display + QR; scan the contact's QR to mark them **Verified**.
    - Finalize the format proposed in ADR 0003: Signal-style numeric fingerprint over the two **account identity keys** (not device keys), 60 digits, with a version in the QR.
    - Record the final format in a short ADR.
  - **Key changes** show a system message "Safety number changed", and the verified state resets.
- [ ] **Typing and presence:** transient WS frames, in-memory on the server, expiring in seconds, and respecting the privacy toggles (if typing is disabled, neither send nor show it). Nothing is persisted.
- [ ] **Message expiry UI:** "Expired before delivery" for `expired_undelivered`.
- [ ] Profile avatars displayed with caching (expo-image).

## Key files
`apps/mobile/src/db/migrations/002_chat.sql`, `apps/mobile/src/engine/*`, `apps/mobile/app/(app)/chats/*`, `apps/mobile/app/(app)/contact/*`

## Out of scope
Reactions, edit, search and other extras (11); push (12); groups (13); attachments (15).

## Done when
- Two Android devices (2 phones, or a phone + an emulator with an x86_64 build) chat E2EE.
- Airplane mode on the sender → "Queued" → reconnect → sent → "Delivered" after the recipient receipt.
- Kill and relaunch keeps history.
- Mongo/Redis inspection during an offline send shows only ciphertext.
- QR verification marks the contact verified.
- `pnpm lint typecheck test` passes.

## Handoff notes
**From Phase 3 (ADR 0005):**
- Add chat tables as migration 002 in `apps/mobile/src/db/migrate.ts` (ordered, `PRAGMA user_version`).
- **Never use expo-sqlite's `withExclusiveTransactionAsync`** (or `useNewConnection`): the extra connection has no SQLCipher key and fails with "file is not a database". Use `withTransactionAsync` or `BEGIN IMMEDIATE … COMMIT` on the keyed connection from `getCryptoContext()`.
- Persist every Olm session as a pickle (pickle key from `src/crypto/secrets.ts`) and re-save the account after one-time keys change.
- `@pingdost/crypto/conformance` and the dev route `(dev)/crypto` stay available for regression checks on new devices.

**From Phase 4 (ADR 0006):**
- Before the app first uses `@pingdost/protocol`, install on `globalThis`:
  - a `TextDecoder` that supports `fatal: true` (protobuf-es needs it; Hermes may lack it). Check the polyfill's license and version first.
  - `crypto.getRandomValues` (for `uuid`), e.g. from `expo-crypto`.
**From Phase 7 (ADR 0009):**
- The app imports only `@pingdost/protocol/signing` and `/ids`, and installs just `crypto.getRandomValues` (`src/polyfills.ts`). Add the `TextDecoder` polyfill there before importing the package root.
- Replace the placeholder `src/screens/chats.tsx` in the `(app)/(chats)` stack. The API client and session live in `src/api`. Use `useAccount` (`src/settings/account.ts`) for the display name and the privacy prefs.
- `local_settings` helpers are in `src/db/settings.ts`. The device record `{ deviceId, userId }` is under key `device`.
**From Phase 8 (ADR 0010):**
- Open the socket only in the `ready` stage. `EXPO_PUBLIC_WS_URL` now ends in `/v1/ws`.
- Send a `Ping` every `AuthOk.heartbeat_interval_ms` while idle.
- Close codes:
  - 4001: refresh the token, then reconnect;
  - 4002: replaced by a newer socket of this device; do not fight it;
  - 4003: revoked; sign out;
  - 4008: back off;
  - 1002: protocol bug.
- Frames need the `TextDecoder` polyfill (see the Phase 7 note).
**From Phase 9 (ADR 0011):**
- Implement `EngineStore` (`packages/message-engine/src/store.ts`). `apply(batch)` must be one transaction on the keyed connection (never `withExclusiveTransactionAsync`). Run `runEngineStoreContract` from `@pingdost/message-engine/testing` against it.
- The engine re-pickles the Olm account into `batch.account`: write it to the same `crypto_store` row that `CryptoStore` uses (`device-olm-account`), and pass `CryptoStore.account` as `EngineOptions.account`.
- Wiring:
  - `new WsTransport({ url, getAccessToken, refreshToken })` inside a `TransportRouter`;
  - `api: { ...keysApi(client), keys: keysApi(client) }`;
  - `self.accountIdentityKey` from SecureStore;
  - on the transport's `otk_low` event, call `engine.replenishKeys()`;
  - on `revoked`, sign out.
- `apps/mobile/src/device/keys.ts` duplicates `publishKeys`/`syncKeys`, which now live in the engine: re-export them.
- The UI API:
  - `openDirectConversation`, `sendText`, `retry`, `markRead`, `listMessages` (cursor `{ sortAt, messageId }`), `messageInfo`;
  - `subscribe(conversationId)` (message and typing events), `onConversationListChanged`;
  - `setTyping`, `contact` / `markVerified`, and `onEvent` (`identity_changed`).
- System notices are `kind: 'system'` with `body: 'safety_number_changed'`. Unknown bodies are `kind: 'unsupported'` (show "update needed").
- The engine imports `@pingdost/protocol` (the root), so the `TextDecoder` polyfill must be in `src/polyfills.ts` first.
