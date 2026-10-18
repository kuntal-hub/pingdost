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
