# 0011 — Message engine: store contract, outbox, sessions, repair and receipts

- **Status:** Accepted
- **Date:** 2026-10-19
- **Phase:** 09
- **Approved by user:** n.a.

## Context
- REQ §4.3 asks for a transport-neutral engine. REQ §8.1 asks for a durable local outbox, idempotent delivery and handling of reconnects and device changes. REQ §8.3 forbids "delivered" without a recipient-device acknowledgement.
- ARCHITECTURE A3 (mailbox), A4 (wire protocol), A5 (E2EE, multi-device) and ADR 0003 (pre-key routing, session rules) set the constraints.
- Phase 9 found three gaps in the v1 protocol:
  1. a sender's own other devices could not tell which conversation their copy belongs to;
  2. no conversation ID was defined for 1:1 chats;
  3. a receiver could not find the owner (and so the keys) of a device it had never seen, and it needs them before it can decrypt a first pre-key message.

## Options considered
| Option | Pros | Cons | License | Cost |
|---|---|---|---|---|
| **Owner of an unknown device:** `GET /v1/keys/devices/:id` (chosen) | Envelope unchanged; relays see no user IDs | One REST call per new device; offline (mesh) first contact needs another path | — | — |
| Owner via `sender_user_id` in the Envelope | Works offline | Puts user IDs in front of every relay | — | — |
| Owner via the pre-key message's identity key | No server call | Needs a new binding (Rust + WASM + Android rebuild), and normal messages still need a lookup | — | — |
| **Conversation ID:** UUIDv5 of the sorted user IDs (chosen) | Both sides derive it; fits the 16-byte header field | — | — | — |
| Random ID sent in the first message | — | Races when both users start a chat | — | — |
| **Store API:** one atomic `apply(batch)` (chosen) | Maps to one SQLite / Dexie transaction | Reads happen outside the batch, under the engine lock | — | — |
| Per-entity methods inside a transaction callback | Familiar | Harder to keep atomic across SQLite and IndexedDB | — | — |

## Decision
1. **Packages.**
   - `@pingdost/transport`: the `Transport` interface (`send`, `onPacket`, `status$`, `kind`), `WsTransport` and a `TransportRouter` (Internet only until Phase 22).
     - `WsTransport` uses only the standard `WebSocket` API. Node 24 has a global `WebSocket`, so no `ws` shim is needed.
     - Close codes: 4001 refreshes the token, then reconnects; 4002 and 4003 stop for good; 4008 backs off further.
     - It pings while idle; ACKs within 20 ms go out as one frame.
   - `@pingdost/message-engine`: `MessageEngine` plus the `EngineStore` interface and `MemoryEngineStore`. `@pingdost/message-engine/testing` adds the store contract suite and an in-memory fake server.
2. **Protocol additions** (v1, add-only; ADR 0006 still holds):
   - `ContentHeader.recipient_user_id` (field 7): in direct messages, the other user.
   - Direct conversation ID: `directConversationIdFor(a, b)` = UUIDv5(fixed namespace, lower user ID bytes ‖ higher user ID bytes).
   - Receivers accept a direct message only if:
     - the sending device belongs to `sender_user_id` (from the verified directory);
     - `recipient_user_id` is this user, or the sender is this user (an own-device copy);
     - `conversation_id` matches `directConversationIdFor(sender, recipient)`.
   - `decodeContentHeader` reads the header of a body this build does not know, so the engine stores an "update needed" placeholder (`kind: 'unsupported'`).
   - `GET /v1/keys/devices/:deviceId` → `{ deviceId, userId }` for active devices (NOT_FOUND otherwise). The engine then fetches and verifies that user's directory.
   - `DEFAULT_LIMITS.messageMaxRetentionSeconds` (14 days) in public config; the server's default comes from it.
3. **Store.**
   - Every write goes through `apply(batch)`, which must be atomic. A batch can hold the account pickle, conversations, messages, deliveries, outbox items, sessions, directory entries, seen IDs and settings.
   - A received message, the advanced Olm session (and the account after a new inbound session), the seen IDs and the receipt to send are committed together, before the transport ACK.
   - The engine serializes Olm work and writes behind one lock. Network calls run outside it.
4. **Outbox** (two levels).
   - `sendText` stores the message (UUIDv7, `local_queued`) and a `fanout` item before any network call.
   - Fan-out happens once the peer's and the sender's own directories are known (refetched when older than `directoryMaxAgeMs`, default 5 min). It creates one `device` item per device of the peer and per other device of the sender, plus a delivery row (`own` marks the sender's devices).
   - A device item is encrypted once. Its packet is stored with the advanced session, so retransmits resend the same bytes under the same envelope ID.
   - The packet's `expires_at` is createdAt + max retention, so the server never keeps it past the sender's expiry deadline.
   - Results:
     - `Accepted`: the device is `sent_to_server`.
     - Retryable errors and timeouts: backoff with jitter (2 s doubling to 5 min).
     - `OFFLINE`: not counted as an attempt; the item goes again when the status turns online.
     - `RECIPIENT_UNKNOWN`: the item is dropped and the directory refetched.
     - Other errors: `failed` until the user retries.
   - Keys for devices without a session are claimed in one call per 100 devices; signatures are checked before use.
5. **States.**
   - Each recipient device has its own state.
   - The message shows the best state among the recipient user's devices: read > delivered > sent/relayed > sending > queued > failed. The sender's own devices never count.
   - Every change follows the shared transition table (`advance` may skip `sending`).
   - Expiry: no receipt by createdAt + max retention → `expired_undelivered`. A late receipt still moves the message to delivered.
   - A crash mid-send leaves rows `sending`; `start()` moves them back to `local_queued`.
6. **Sessions** (ADR 0003).
   - The engine encrypts with the most recently active session with the device (the latest of created and last decrypted), so both sides converge after a simultaneous start or a repair.
   - A pre-key message goes to the session with its `prekeyMessageSessionId`; a new inbound session is created only when none matches.
   - A device ID whose identity keys changed counts as a new device.
7. **Directory trust.**
   - A device is used only if its certificate verifies against the account identity key.
   - Fallback keys are cached only with a valid device signature (for Phase 23's offline first contact).
   - A changed account identity key adds a "safety number changed" notice to the conversation, resets the verified state and emits `identity_changed`.
   - Own devices are trusted only under the locally known own identity key.
   - Removed devices lose their queued items and their unconfirmed delivery rows.
8. **Repair.**
   - When an envelope cannot be decrypted, it is ACKed but **not** marked seen. The device sends `SessionReset` on a freshly claimed session (at most once per device per 5 min).
   - The peer that receives it re-encrypts its queued items to that device and resends every unconfirmed text message under the same envelope ID. The server deleted the old copy on ACK, and the receiver never stored it, so the resend gets through.
9. **Receipts.**
   - `Receipt{DELIVERED}` goes only to the sending device, and only when the `receipts` option allows it.
   - Receipts queued within `receiptDelayMs` (200 ms) go out as one Content (up to 200 IDs).
   - Only a receipt from a recipient device listed for that message changes its state.
   - Own-device copies are stored as outgoing `sent_to_server` and send no receipts.
10. **Keys.**
    - `publishKeys`/`syncKeys` moved from the Android app into the engine.
    - `replenishKeys()` handles `OtkLow` and rotates the fallback key weekly (ADR 0003). vodozemac keeps the previous fallback key, so pre-key messages made from it still decrypt.

## Consequences
- Phase 10 implements `EngineStore` on SQLCipher and runs `runEngineStoreContract` against it, then wires `WsTransport` and `replenishKeys` into the app. The app's `device/keys.ts` re-exports the engine's.
- Phase 11: read receipts (`receipts('read')` plus per-message read tracking), and scoping typing to conversations on the server.
- Phase 13: Megolm envelopes are ACKed and dropped for now, and `checkHeader` accepts only direct messages.
- Phases 16 and 17: a linked device's own copies show `sent_to_server`. Decide whether receipts should go to all of the sender's devices.
- Phase 17: the Dexie store must pass the same contract.
- Phase 23: offline first contact over the mesh cannot call `GET /v1/keys/devices/:id`. Use cached directories or the Hello handshake.
- Known limits:
  - The sender's other devices learn about messages only through their own copies.
  - A commit that fails after a new inbound session leaves the in-memory account without that one-time key, so a redelivery cannot decrypt. It is logged; this is rare.

## Evidence
- `pnpm --filter @pingdost/message-engine test`: 37 tests. They cover the 13 engine scenarios over the fake server with real vodozemac (WASM), the state machine, the store contract, header checks and directory verification.
- `pnpm --filter @pingdost/transport test`: 13 tests.
- `pnpm --filter @pingdost/server test:int`: 104/104. `test/engine.int.test.ts` covers the 8 Phase 9 scenarios through a listening server, including a restart and the Redis/Mongo/WebSocket plaintext-marker scan.
- `pnpm --filter @pingdost/sim-client start -- --messages 20` against the dev server, 2026-10-19:
  - 20 offline messages reached `sent_to_server`, then `delivered_to_recipient_device` after receipts;
  - 20 online messages were delivered once each;
  - no plaintext marker appeared in 136 captured frames.
