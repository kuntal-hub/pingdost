# 0024 — Direct nearby messaging: handshake, routing and states

- **Status:** Accepted
- **Date:** 2026-11-01
- **Phase:** 22
- **Approved by user:** n.a. (follows the Phase 22 plan; the user approved starting before Phases 10 and 21 are ✅)

## Context
REQ §11.1 modes 1 and 3: two phones with no Internet exchange messages directly, the app uses the Internet when it can and nearby otherwise, and **the E2EE content format does not change**. Other requirements:
- REQ §11.3: origin and integrity are authenticated.
- REQ §8.3 and §11.6: the states stay honest; "delivered" only after the recipient device's receipt.
- REQ §19.4: no duplicates, and failures are visible.

The link layer is ADR 0023: platform BLE, unpaired and unencrypted, with packets up to 128 KiB and at most 7 links. ARCHITECTURE A4 reserved `PACKET_KIND_HELLO` and `PACKET_KIND_ACK`. A5 reserved "mesh first contact" from cached fallback keys.

Three questions needed answers:
1. How does a phone know which contact device is on the other end of a link, without telling strangers who it is?
2. How does one engine choose between two paths without sending twice or losing a message?
3. What does the sender see after the recipient's phone took a message over Bluetooth?

## Options considered
**Who is on the link**
| Option | Pros | Cons |
|---|---|---|
| **Two-step signed `Hello`, naming only the Ed25519 device key (chosen)** | Standard Ed25519 signatures over a context-prefixed statement (ADR 0008 style). Bound to both sides' fresh tokens, so a proof cannot be replayed on another link. A stranger learns a public key, not a device ID, user or name. | Two round trips. The key is stable, so a stranger who records it can tell "the same phone again" later. |
| Signed `Hello` with the device ID | One lookup (`findDeviceOwner`). | Anyone nearby can resolve the device ID to the account through `GET /v1/keys/devices/:id`. |
| Recognition tags only contacts can compute (Briar-style, from shared secrets) | Strangers learn nothing stable. | A new protocol and new key derivations: "no custom cryptography" (A10) rules it out without its own ADR and review. |

**Routing**
| Option | Pros | Cons |
|---|---|---|
| **Per device: Internet if up, else nearby if that device proved its key on a link, else wait (chosen)** | Simple and testable. The Internet stays the source of truth. Waiting messages are not encrypted early, and no key is claimed. | Both paths are never used at once for speed. |
| Send on every path, always | Fastest delivery. | Doubles traffic, and duplicates every envelope in the mailbox. |

**State after the nearby ACK**
| Option | Pros | Cons |
|---|---|---|
| **`sent_to_server` with the path on the delivery row (chosen)** | The state machine is unchanged ("the next hop holds it; only an E2EE receipt delivers it"). Labels and message info name the path. No sync or wire change. | The REQ name says "server"; the UI never shows it raw. |
| A new `sent_nearby` state | Exact name. | Touches the shared enum, transitions, aggregates, SQLite/Dexie, history sync, both UIs. |
| `delivered_to_recipient_device` on the ACK | Feels faster. | The ACK is not authenticated per packet (the link is unencrypted). REQ §8.3 wants the recipient's receipt. |

## Decision
**Wire (add-only, protocol v1):**
- `Hello` gains `capabilities` (`HELLO_CAPABILITY_DIRECT` = 1, `RELAY` = 2 for Phase 23) and `proof`.
- `HelloProof` holds `identity_key` (32 bytes) and `signature` (64 bytes).
- The signed statement is `nearbyHelloMessage` = `"pingdost/nearby-hello/v1"` ‖ 0x00 ‖ the signer's token (16) ‖ the other side's token (16) ‖ ed25519 (32) ‖ capabilities (u32, big-endian).
- HELLO and ACK packets are hop-local: `dst` = `0x00`, and they expire after 10 minutes, as room for clock skew.
- Codecs: `encodeHello`/`decodeHello` and `encodeAck`/`decodeAck` (at most 256 IDs).

**Handshake (`NearbyPeerTransport`, `packages/transport/src/nearby.ts`):**
1. On `linkUp`, each side sends `Hello{token}`, with a fresh random token per link.
2. On the peer's `Hello` it sends `Hello{token, proof}`.
3. The receiver checks the signature (`crypto.verifyEd25519`), then looks the key up in its **cached, certified directories** (`EngineStore.listDirectories`, `createNearbyIdentity` in the engine). The outcome is one of:
   - **known** (a contact device): envelopes for that device go over this link;
   - **unknown** (a valid key it does not know): kept for Phase 23, sent nothing, and never looked up on the server;
   - **invalid**: three invalid proofs close the link.
- A blocked user's device counts as unknown.
- A peer that changes its token (a JS reload) is re-proved. Links that were up before JS started are reported as new, so they handshake again.
- No proof within 15 s counts as unknown.

**Delivery:**
- Only envelopes whose `dst` is the verified recipient device go to a link.
- The receiver accepts only envelopes for its own device. It answers `PACKET_KIND_ACK{envelope_ids}` on the same link once the engine stored them; a burst is coalesced into one ACK.
- Sender outcomes:
  - the ACK → `ok`, `delivered_transport`, `via: nearby`;
  - no ACK within 15 s, or the link drops → `TIMEOUT` (retryable);
  - no verified link → `NO_ROUTE`.
- The E2EE delivery receipt is an ordinary outbox item and takes the same route back.

**Router (`TransportRouter`):**
- `route(deviceId)` returns one of:
  - `internet`: an online transport that reaches every device;
  - `nearby`: an online transport whose `reaches(deviceId)` is true;
  - `unreachable`: something is up but nothing reaches this device;
  - `offline`: nothing is up.
- `send` stamps the path on success (`via`). `onRoutesChanged` fires on any status or reach change.
- Nearby is `online` while it is looking for peers, so the router is online in airplane mode with Bluetooth on.

**Engine (`outbox.ts`):**
- Before encrypting, each device item asks for its route:
  - `unreachable`: the item is parked (in memory) and its row becomes `waiting_for_nearby_route`. This is not an attempt, and nothing is encrypted or claimed. `routesChanged` unparks every item and kicks the outbox.
  - `nearby`: no key claim (there is no Internet). A device with no session uses its cached, signature-checked fallback key (A5 mesh first contact).
- A `NO_ROUTE` result parks the item too.
- A success records `via` on the delivery row. The state is `sent_to_server`: the next hop holds it, and only the E2EE receipt delivers it.
- **Partial fan-out:** when some recipients' directories are uncached and unreachable (offline), the reachable peer devices get their items now, and the fan-out item stays for the rest. In practice that is the sender's own linked browsers.
- `canReachOffline(userId)`: whether a phone of that user has a session or a cached fallback key.

**Duplicates:**
- The same envelope (same ID and bytes) can go nearby, lose its ACK, then go through the server. The recipient's seen-ID cache drops the second copy.
- The sender's state only moves forward (`advance`), and a receipt from either path settles it.

**Android app (`apps/mobile/src/nearby/`):**
- The "Nearby messaging" toggle is local to the phone and **off by default**.
- A setup screen explains Bluetooth and the Nearby devices permission (Location on Android 8–11) before Android asks.
- `startNearby` follows the toggle, the permissions and Bluetooth. It starts the `connectedDevice` service only with the app in the foreground.
- `nearbyStatus` names every state: unavailable, off, permission, Bluetooth off (with airplane mode), starting, stopped, and on with N contacts.
- The UI:
  - the offline banner says what nearby is doing, and "Can't reach this contact offline until you've connected once online";
  - the chat header shows "nearby · Bluetooth" while the contact's phone is linked;
  - message info shows the path per device;
  - the chat screen's Internet status comes from the WebSocket only.

## Consequences
- **Privacy trade-off, stated in the app:**
  - While nearby is on, any PingDost phone in range sees that a PingDost phone is near and, once it connects, this device's public Ed25519 key. That key is stable, so a stranger who records it can recognise the phone later. It cannot be resolved to an account through PingDost's API, but someone who already fetched a target's key directory could recognise that target.
  - Phase 23 should weigh contact-only recognition (its own ADR, no custom crypto) before relaying makes many more strangers connect.
- Store changes:
  - `EngineStore.listDirectories()` is in all three stores and in the contract;
  - `DeliveryRecord.via` (SQLite migration 007 `delivery_state.via`; Dexie and memory store the record as is).
- `@pingdost/transport/testing` exports `FakeLinks`/`connectFakeLinks`, an in-memory radio for engine tests.
- Group messages route the same way per device, but group fan-out still needs every member's directory. Groups over nearby are not tested and stay out of Phase 22's scope.
- Unknown peers keep their links (one of seven slots) and may be reconnected by auto-connect. Phase 23 decides slot policy with relaying.
- The dev spike screen and nearby messaging read the same native queue: turn nearby off before using the dev screen.
- Nothing ties a nearby ACK to the handshake key. A peer that proved a contact's key could ACK and drop envelopes. The receipt never arrives, so the message stays "Sent", not delivered, and the Internet path does not resend it. Phase 23 should consider re-sending unconfirmed nearby messages over the Internet after a delay.
- Updated:
  - Phase 22 (done in code); Phase 23 handoff (unknown peers, relay capability, slot policy, recognition, nearby resend); Phase 24 (ACK and route model for chunks); Phase 27 (permission declarations and the privacy notice); Phase 30 (iOS must speak the same `Hello`);
  - ARCHITECTURE A4 and A5.

## Evidence
- Tests (2026-11-01):
  - `packages/protocol/src/nearby.test.ts`: codecs and the golden statement;
  - `packages/transport/src/nearby.test.ts` and `router.test.ts`: handshake, unknown peer, replayed proof, timeout, reload, delivery, ACK, link drop, path choice, flush;
  - `packages/message-engine/src/routing/routing.test.ts`, with real vodozemac:
    - airplane-mode text both ways, with an offline first session from the fallback key;
    - waiting, then a flush when the contact comes into range;
    - nearby without ACK, then the Internet, with no duplicate;
    - the sender's own browser getting its copy later;
    - the Internet preferred;
    - identity checks.
- No phone run yet: Phase 21's two-phone check and this phase's device checks are open (PROGRESS).
