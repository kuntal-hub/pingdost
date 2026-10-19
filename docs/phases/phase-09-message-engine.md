# Phase 09 — Message engine & session management

**Depends on:** 04, 08 · **Platforms:** shared TS (Node-tested)

## Goal
Build a platform-neutral, transport-neutral engine: local outbox, REQ §8.3 states, retries, idempotent dedupe, multi-device fan-out, Olm session setup and repair, and E2EE receipts. Prove it end to end with two headless clients through the real server.

## Read first
- REQ §4.3, §7.3, §8.1, §8.3
- ARCHITECTURE A3, A4, A5, A8
- The E2EE ADR

## Tasks
- [x] **`packages/transport`:**
  - `Transport` interface: `send(packet)`, `onPacket`, `status$`, `kind`;
  - `WsTransport`, using the standard `WebSocket` API so it works in RN and browsers, with a `ws` shim in Node: auth frame, reconnect with exponential backoff + jitter, heartbeat, and resume fetch on reconnect;
  - a `TransportRouter` skeleton (Internet only; nearby added in Phase 22).
- [x] **`packages/message-engine`:**
  - **`EngineStore` interface** (conversations, messages, outbox, delivery_state, crypto sessions/pickles, device-directory cache, seen message IDs, settings). Include an **in-memory implementation** for tests. SQLite comes in Phase 10, Dexie in Phase 17.
  - **Outbox:**
    - create the local message (UUIDv7) **before** any network call;
    - expand to per-recipient-device jobs, covering every active device of the recipient **and** the sender's own other devices;
    - `envelopeId = envelopeIdFor(messageId, deviceId)`;
    - retry with backoff; survives app restarts (store-backed).
  - **State machine:** the legal transitions from `shared-types`; aggregate per-message state from per-device states. "Delivered" happens only on an E2EE delivery receipt from a recipient device. The device's own other devices don't count.
  - **Session manager:**
    - fetch and cache the device directory (`GET /v1/keys/users/:id`); detect added and removed devices;
    - claim OTKs; create outbound sessions; handle inbound prekey messages. Route a repeated pre-key message to the existing session via `prekeyMessageSessionId()`, and create a new inbound session only when none matches (ADR 0003);
    - verify device certificates (account identity key, Phase 6) and one-time key signatures before encrypting to a device;
    - on a decrypt failure, send `SessionReset` and re-establish;
    - cache contacts' fallback keys (needed for mesh later).
  - **Content codec:** encode `Content` → pad → encrypt; reverse on receive.
  - **Receive pipeline:**
    1. decrypt;
    2. dedupe by messageId (the seen set);
    3. persist;
    4. transport `Ack`;
    5. emit events;
    6. send an E2EE `Receipt{DELIVERED}` if the user setting allows it.
  - **Expiry:** mark `expired_undelivered` when there is no delivery receipt by createdAt + max retention (value from public config).
  - **Events API** for UIs: `subscribe(conversationId)` and `onConversationListChanged`.
- [x] Upgrade `tools/sim-client` to the engine + WASM `CryptoProvider` + in-memory store.
- [x] **Integration tests** (`pnpm test:int`, real server + infra). Two or three sim clients:
  1. online exchange;
  2. offline recipient, then later online;
  3. reconnect mid-send (no duplicates);
  4. duplicate Deliver frames → a single visible message;
  5. server restart during the outbox;
  6. recipient adds a second device: new messages go to both, and the new device does not get old ones;
  7. recipient device revoked: no further envelopes to it;
  8. **ciphertext-only check:** scan Redis/Mongo dumps and captured WS frames for a plaintext marker string (REQ §19.1 bullets 1–2).
- [x] **Unit tests:** state machine transitions, outbox retry/backoff, dedupe, session repair.

## Key files
`packages/transport/src/*`, `packages/message-engine/src/{engine.ts,outbox.ts,states.ts,sessions.ts,receive.ts,store.ts,memoryStore.ts}`, `tools/sim-client/*`

## Out of scope
UI, groups (13), attachments (14), nearby (22).

## Done when
- All the integration scenarios and unit tests pass.
- The plaintext-marker scan finds nothing on the server side.
- `pnpm lint typecheck test` passes.

## Handoff notes
**From Phase 4 (ADR 0006):**
- `encodeContent` already pads to the size buckets, so "encode → pad → encrypt" is `encodeContent` → encrypt. `decodeContent` ignores padding.
- Check that `ContentHeader.sender_user_id` owns the sending device. Show `UNKNOWN_BODY` decode errors as "update needed" rather than dropping the message.
- int64 fields are `bigint` in protobuf-es.
- The `MessageState` transition table in `shared-types` is a first version: change it if the engine needs another edge, and keep its tests.

**From Phase 6 (ADR 0008):**
- Before encrypting to a device:
  - verify `deviceCertificate` against the account identity key with `deviceCertificateMessage` (`@pingdost/protocol`);
  - verify claimed one-time and fallback key signatures against the device ed25519 key with `signedKeyMessage`;
  - use `CryptoProvider.verifyEd25519` (strict).
- The directory returns each device's signed `fallbackKey` (cache it for mesh first contact) and `keyVersion` (refetch when it changes).
**From Phase 8 (ADR 0010):**
- Gateway `ws(s)://<host>/v1/ws`. The first frame is `Auth{accessToken, protocolVersion}` within 5 s.
- `Send` → one `Accepted` or `ServerError` with the same `request_id`.
  - `STORED` and `DELIVERED_TRANSPORT` both mean only `sent_to_server`; delivery receipts are E2EE content.
  - Retry only errors with `retryable: true` (`MAILBOX_UNAVAILABLE`, `RATE_LIMITED`). Keep the envelope in the outbox until `Accepted`.
- `Deliver` must be acknowledged with `Ack{envelope_ids}` only after the message is stored locally. Fetches arrive in batches of 50, and the next batch waits for the ACKs (30 s). Dedupe on `message_id`: the same envelope can arrive twice (online, then from the mailbox).
- The server sets `expiresAt` = min(packet expiry, receive time + 14 days).
- `OtkLow` → `replenishKeys()` (mobile).
- `tools/sim-client/src/socket.ts` is a working reference client.
