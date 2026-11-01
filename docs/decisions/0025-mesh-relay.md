# 0025 — Mesh store-and-forward relay: routing tokens, spray-and-wait, signed packets

- **Status:** Accepted
- **Date:** 2026-11-01
- **Phase:** 23
- **Approved by user:** n.a. (follows the Phase 23 plan; the user approved starting before Phases 15 and 22 are ✅)

## Context
REQ §11.1 mode 2: an opted-in phone temporarily stores an encrypted packet and forwards it when it meets the next reachable phone. The constraints:
- REQ §11.3: relays forward ciphertext they cannot decrypt or change undetectably; relay-visible data is minimised; relay acceptance is not delivery.
- REQ §11.4: every packet has a unique ID, creation time, absolute expiry, destination token, hop budget (default 8), type and integrity metadata. A bounded seen-cache, a relay storage cap (250 MB) with per-origin quotas, rate limits on creation, relaying and discovery, battery and storage policies, an explicit opt-in.
- REQ §8.3, §11.6: "Forwarded by N devices — not yet delivered"; delivered only after the recipient device's E2EE receipt.
- REQ §19.1 bullet 3 and §19.4: proven A → B → C, where B cannot read or alter the packet; no duplicates; expired and over-hop packets dropped; relaying can be switched off.
- ARCHITECTURE A10: no custom cryptography.

Phase 22 (ADR 0024) gave proved BLE links: each peer is a known contact device or an unknown valid key. Relays are mostly strangers, who must not learn device IDs, because `GET /v1/keys/devices/:id` resolves a device ID to its account.

## Options considered
**Forwarding**
| Option | Pros | Cons |
|---|---|---|
| Flooding with a hop limit (BitChat-style) | Best delivery odds in a sparse crowd. Simple. | Every relay keeps and sends every packet: storage, airtime and battery grow with the crowd. |
| **Binary spray-and-wait with a hop limit (chosen)** | At most L copies of a packet exist (L = 8). A holder with n > 1 copies hands floor(n/2) to a relay and keeps the rest; with one copy it waits for the recipient. Bounded cost per packet, good delivery in published DTN results. | Fewer copies than flooding, so delivery is slower in very sparse groups. The copy count is relay-mutable. |
| Source spray-and-wait only | Simplest bound. | Effectively two hops; the hop budget means nothing. |

**Naming the recipient**
| Option | Pros | Cons |
|---|---|---|
| Device ID as `dst` | No new derivation. | Any relay with an account can resolve it to the person. |
| **Daily routing token: SHA-256(context ‖ device ID ‖ UTC day), first 16 bytes (chosen)** | A hash of identifiers, not a key: no new crypto. Relays cannot reverse it; it changes every day, so a relay cannot link one recipient's packets across days. | Anyone who knows the device ID (contacts, the server) can compute it. The recipient announces its tokens for the TTL window to each phone it links to. |
| Contact-only secret tags | Strangers learn nothing. | A new key-derivation protocol: out under A10 (see ADR 0026). |

**Integrity**
| Option | Pros | Cons |
|---|---|---|
| Rely on Olm's MAC only | Nothing to add. | The Envelope's own fields (envelope ID, crypto type, group) and the header (expiry) could be changed. |
| **Sender's Ed25519 signature over every field relays must not change, checked by the recipient (chosen)** | Standard signature, context-prefixed statement (as ADRs 0008 and 0024). Any change at a relay is caught. | Relays cannot check it (they do not know the sender's key), so they may carry a tampered packet until the recipient refuses it. |
| A signature relays can check | Relays drop forgeries early. | The packet would carry the sender's stable key: every relay could link the sender's packets forever. |

**Delivered lists ("vaccines")**
| Option | Pros | Cons |
|---|---|---|
| None | No forgery risk. | Relays keep delivered copies until they expire (14 days). |
| **Unauthenticated delivered IDs in the summary; holders drop matching copies, the sender never does (chosen)** | Frees storage and airtime soon after delivery. | A malicious peer can make holders drop copies it names. That is no more than a malicious relay can do already (drop what it holds). The sender keeps its own copy until the E2EE receipt. |
| A hash-lock committed by the sender | Authenticated. | Needs a secret inside the E2EE content and a new construction: deferred. |

## Decision
**Wire (add-only, v1; `buf breaking` clean):**
- New `PacketKind`s: `MESH_ENVELOPE` (7, payload `MeshEnvelope`) and `MESH_SUMMARY` (8, payload `MeshSummary`, hop-local).
- `TransportPacket.copies` (10): spray copies the holder may hand on; relays change it, so it is not signed.
- A relayed packet's header is the `TransportPacket`'s own fields: packet ID (the inner envelope packet's ID, so rebuilding it gives the same bytes), `created_at_ms`, `expires_at_ms` (at most `MESH_PACKET_TTL_SECONDS` after creation, never later than the message's own expiry), `dst` = the recipient's routing token, `hop_budget`, `copies`. `MeshHeader` is unused and kept only to reserve its numbers.
- `MeshEnvelope`: `origin_token` (the sender's routing token for the creation day), the Envelope's `envelope_id`, `crypto_type`, `group_id`, `megolm_session_id` and `ciphertext`, **without** either device ID, and `signature`.
- `meshEnvelopeMessage` = `"pingdost/mesh-envelope/v1"` ‖ 0x00 ‖ packet ID (16) ‖ created (8) ‖ expires (8) ‖ dst (16) ‖ origin token (16) ‖ envelope ID (16) ‖ crypto type (4) ‖ has group (1) ‖ group ID (16 or none) ‖ session ID length (2) ‖ session ID ‖ ciphertext. Integers are big-endian.
- `MeshAck` gains `status` (`ACCEPTED`, `DELIVERED`, `DUPLICATE`, `REFUSED`) and `signature`. `meshAckMessage` = `"pingdost/mesh-ack/v1"` ‖ 0x00 ‖ the other side's link token (16) ‖ packet ID (16) ‖ status (4). It is signed with the key the answering device proved in its Hello, so it binds to that link.
- `meshRouteInput` = `"pingdost/mesh-route/v1"` ‖ 0x00 ‖ device ID (16) ‖ UTC day (4). The token is SHA-256 of it, cut to 16 bytes (`meshRoutingToken`).
- `MeshSummary`: the sender's routing tokens for every day a live packet to it can carry (now − TTL … now + 1 day; at most 40), and up to 256 delivered packet IDs.
- Golden vectors: `mesh-envelope`, `mesh-summary`, `packet/mesh-envelope`, `packet/mesh-summary` (additions only).

**Relay (`MeshRelay`, `packages/transport/src/mesh.ts`; limits and stores in `packages/mesh-protocol`):**
- It runs on links `NearbyPeerTransport` proved, known or unknown. Each side sends its summary once the peer's proof checks.
- **Sending.** For a device not in direct range, the router's new tier `mesh` (`Transport.carries`) hands the encrypted packet to the relay. The relay signs it and holds it, and `send` answers `held`. The sender sprays it to relay-capable peers (`HELLO_CAPABILITY_RELAY`) that are not the recipient itself. The recipient, when linked as a known contact, gets it over the direct path instead.
- **Carrying (relaying on):**
  - A packet for another device is checked (`checkMeshPacket`: kind, 16-byte token, not expired, created at most 10 minutes ahead, lifetime ≤ TTL, hop budget ≤ `MESH_PACKET_MAX_HOPS`, copies 1–64, decodable payload).
  - It is refused when relaying is off, the hop budget is 0, a rate is exceeded, or the store refuses it. A seen or stored ID is a duplicate.
  - Otherwise it is stored with the hop budget minus one and answered ACCEPTED.
  - Stored packets go to a peer whose tokens include their `dst` (DELIVERED drops them, and their IDs join the delivered list). With more than one copy and hops left, half the copies go to relay-capable peers that do not have the packet yet.
- **Receiving.** A packet whose `dst` is one of this device's tokens:
  - the origin token is resolved among the cached, verified directories (`resolveOrigin`; blocked users do not count);
  - the signature is checked, the Envelope rebuilt and handed to the engine like any packet;
  - DELIVERED is answered once it is stored.
  - An unknown sender or a failed check is REFUSED and **not** marked seen, so an intact copy can still arrive through another relay.
- **Offers** go one at a time per link and wait for the signed `MeshAck` (15 s, then the next peer). An ACK with a bad signature is ignored.
- **Own copies** stay until the engine withdraws them. `EngineCore.commit` calls `transport.withdraw` for every outbox item it deletes: accepted, a receipt, a revocation. Delivered lists never remove an own copy.

**Limits (`MeshPolicy`, every value configurable):**
- Hops 8 and TTL 14 days (REQ §17). Relay store 250 MB: expired packets are evicted first, then the oldest received. Per origin token: 1,000 packets and 25 MiB, refused beyond that.
- Seen-cache: 20,000 IDs, LRU plus expiry, persisted (`seen_mesh_packets`).
- Rates: own packets 120 per minute; per neighbour 120 per minute (burst 60); per origin 60 per minute; summaries 6 per minute per neighbour (burst 3).
- Discovery stays bounded by the BLE module (ADR 0023: balanced scans, 7 links, credit flow control).

**States (engine):**
- `held`: the device item stays in the outbox, parked, and its row becomes `waiting_for_nearby_route` ("Queued on this device — waiting for a nearby route").
- The relay's `onRelayed` event (distinct accepting relays, by key) moves the row to `relayed` with `via: mesh` and `relays: N` ("Forwarded by N devices — not yet delivered", `relayedLabel`).
- A relayed row never goes back to queued, sending or waiting (`EngineCore.moved`).
- The same packet still goes over the Internet or a direct link when one appears: the recipient dedupes by envelope ID, and the sender's state only moves forward. Only the E2EE receipt delivers it.
- A browser device is never routed into the mesh: it waits for the Internet.

**Android (`apps/mobile/src/nearby/`):**
- Store: `SqliteMeshPersistence` (migration 008: `mesh_relay_packets`, `delivery_state.relays`) inside the SQLCipher database, apart from chats. It is wiped at sign-out.
- Settings → **Nearby relay**: the opt-in "Allow this device to relay messages", off by default. The screen says what relays see, the battery and storage use, the pause rules (battery below 20%, battery saver, only while charging, free storage below 1 GB) and when relaying stops.
- Settings → Storage → **Nearby relay cache**: its size and its own "Clear relay cache".
- Turning relaying off, or a pause rule, refuses new packets and stops passing any on at once (REQ §19.4). Held packets stay until they expire or are cleared. The rules are checked every minute and whenever nearby is re-applied.
- Peers learn "relays" from the Hello capability of a new link. An existing link keeps what it started with; refusals cover a switch to off at once.
- The foreground service notification says "PingDost nearby relay active" while relaying (`setRelayNotification`), else "Nearby is on". The service runs while nearby messaging is on, and relaying needs nearby.
- **After a restart** (optional, best-effort): the relay's logic is JavaScript, which Android does not start at boot. A boot-started service would keep Bluetooth busy without relaying. Instead, a `BOOT_COMPLETED` receiver posts "Nearby is paused since the restart — open PingDost to turn it back on" when the user asked for it.

## Consequences
- **Relays see** (stated in the app): the recipient's and sender's daily tokens, packet ID, creation and expiry times, hop budget, copies, approximate size, crypto type, and for group traffic the group ID and Megolm session ID. They see no device IDs, names or contents.
  - A relay that meets the recipient learns which phone (stable Ed25519 key, ADR 0024) owns a token. Every phone announces its tokens for the TTL window to every phone it links to, so daily rotation hides nothing from a relay that meets it.
- **Forged delivered lists and false ACCEPTED answers** (a lying peer) can only drop or hold copies: the sender's own copy and its outbox item stay until the receipt. The message then shows "Forwarded" until it is delivered another way or expires.
- **Sybil strangers** (new keys at will) defeat per-origin and per-neighbour quotas; the store cap and eviction bound the damage. Authenticated quotas need identities and are out of scope offline.
- No re-handshake when relaying turns on: peers learn it on their next link.
- The relay cache lives in the SQLCipher database (250 MB cap). Deleted pages are reused but not returned to the OS until a VACUUM (Phase 27 may add one to "Clear relay cache").
- The simulation lives in `packages/message-engine/src/mesh/` (`MeshSim`, mobility schedules), not under `packages/mesh-protocol/test/sim/`: the scenarios need real engines, which `mesh-protocol` cannot depend on.
- Offers go one at a time per link (stop-and-wait on the signed ACK). Phase 24 should pipeline chunks.
- Phase 22's open issue, "a peer that proved a contact's key could ACK and drop", is softened only for the mesh path: the direct path still deletes the item on the nearby ACK.
- Updated:
  - ARCHITECTURE A4, A5, A6; CHANGES 2026-11-01 (Phase 23);
  - Phase 24 (chunks reuse tokens, signatures, the relay store and `copies`; pipelining), Phase 27 (privacy notice wording, VACUUM, Play declaration for `RECEIVE_BOOT_COMPLETED`, sybil limits), Phase 30 (iOS speaks the same packets);
  - CLAUDE.md commands.

## Evidence
- Tests (2026-11-01):
  - `packages/protocol/src/mesh.test.ts`: the token matches an independent SHA-256 over the documented layout, statement layouts, codecs and limits.
  - `packages/mesh-protocol/src/mesh.test.ts`: checks, spray split, seen-cache, store cap, eviction order, per-origin quota, rate limiter.
  - `packages/message-engine/src/mesh/mesh.test.ts`, real vodozemac, all over the real router and nearby transport in airplane mode:
    - A → B → C with A and C never in range: C decrypts, the receipt returns C → B → A, and A shows waiting → relayed → delivered with nothing on the server;
    - B holds no plaintext and no device IDs, and cannot open the pre-key message;
    - tamper at B (a ciphertext byte, a stretched expiry) is refused at C, and an intact copy through D still arrives;
    - "Forwarded by 2 devices"; repeated encounters and a later Internet path give one message;
    - hop 0 delivers but is not passed on; over-budget and expired packets are dropped;
    - relaying off forwards nothing, on takes it, off again stops at once, and clearing leaves chats;
    - per-origin quota and byte cap; per-origin rate limit and the source's creation limit.
  - `apps/mobile/src/nearby/relay-store.test.ts` (migration 008 on SQLite) and `relay.test.ts` (pause rules and wording).
- Not run on phones yet: see the PROGRESS entry (relay opt-in, cache clearing and the receipt UI need two phones; a physical A → B → C needs three).
