# Phase 23 — Mesh store-and-forward relay

**Depends on:** 22 · **Platforms:** shared TS, Android

## Goal
Opt-in devices temporarily store and forward encrypted third-party packets with hop, TTL, dedupe, quota and battery policies. It must be proven A→B→C, where B cannot read or alter the packet, and the UI must distinguish "relayed" from "delivered".

## Read first
- REQ §8.3, §11.1 (mode 2), §11.3, §11.4, §11.5, §11.6, §14.3 (separate caches), §19.1 (bullet 3), §19.4
- ARCHITECTURE A4
- The nearby transport ADR

## Tasks
- [x] **`packages/mesh-protocol`:**
  - `MeshHeader` handling: unique packet ID, creation time, absolute expiry, destination routing token, hop budget, type, chunk ref, integrity;
  - **validation:** reject expired, malformed, oversized and over-budget packets; decrement the hop budget per hop; `MESH_PACKET_MAX_HOPS` and `MESH_PACKET_TTL_SECONDS` from config;
  - a **bounded seen-cache** (LRU + expiry, persisted to `seen_mesh_packets`);
  - a **relay store**: byte cap `MESH_RELAY_STORAGE_LIMIT_BYTES` (default 250 MB), eviction (expired first, then oldest), per-origin quotas, and rate limits on packet creation, relay and discovery;
  - **forwarding strategy ADR** (mesh routing & relay policy): bounded-copy spray-and-wait vs flooding with a hop limit; routing token design (e.g. a rotating token derived from the recipient device ID + epoch day; identifiers only, no new crypto); what relays can see (REQ §11.3);
  - **mesh ACKs:** the destination's delivery ACK propagates so relays drop their stored copies.
- [x] **Relay receipts:** when B accepts a packet from A, B returns a signed `accepted` frame, and A moves the message to `relayed` ("Forwarded by N devices — not yet delivered"). The final state still requires the recipient's E2EE receipt; its hop count is optional.
- [x] **Consent and controls:**
  - an explicit opt-in screen "Allow this device to relay messages", explaining routing metadata visibility, battery and storage, with an easy off switch. **Disabling it stops forwarding new third-party packets immediately.**
  - **Clear relay cache** sits in the Storage screen, separate from chat history.
- [x] **Policies:** pause relaying when the battery is below a threshold or the saver is on, storage is low, or the data/battery mode is restricted (user settings). All thresholds are configurable.
- [x] **Android foreground service** (`connectedDevice`) while relay or nearby is enabled, with a persistent notification "PingDost nearby relay active". Stop it when disabled. Make boot restart optional and best-effort. Document the background limits in the in-app help (REQ §11.5).
- [x] **Simulation harness** (`packages/mesh-protocol/test/sim/` or `tools/sim-client`): virtual devices with an in-memory nearby transport and a mobility schedule. **Scenarios:**
  - A→B→C delivery, where C decrypts;
  - B cannot decrypt, because it has no keys;
  - tamper at B is detected at C;
  - duplicate encounters create no duplicates;
  - expired and over-hop packets are dropped;
  - relay disabled → no forwarding;
  - storage cap and per-origin quota enforced;
  - spam origin rate-limited.
- [x] **Device test** (open: needs two phones, three for the physical run; PROGRESS 2026-11-01): with 2 phones, verify relay acceptance and the receipt UI. With a 3rd phone (if available), do a physical A→B→C run, with B out of A's range when it delivers. Otherwise record it as pending in PROGRESS.
  - **Two-phone part done 2026-11-08** (PROGRESS): relay on and off, its notification text, "Forwarded by 1 device", the pause on battery saver and when not charging, Clear relay cache. Fixed on the way: switching the relay on while the phones were already linked was ignored (now announced in a new signed HELLO). **Pending:** the physical A→B→C run (no third phone) and the boot restart reminder (needs a reboot).

## Key files
`packages/mesh-protocol/src/*`, `packages/mesh-protocol/test/sim/*`, `apps/mobile/src/nearby/relay*`, `apps/mobile/modules/nearby/android/**` (foreground service), `apps/mobile/app/(app)/settings/relay.tsx`

## Out of scope
File chunk transfer (24); iOS (30).

## Done when
- Every simulation scenario passes.
- The relay opt-in, opt-out and cache clearing work on a device.
- The UI distinguishes queued / relayed / delivered.
- The ADR is written, and `pnpm lint typecheck test` passes.

## Done in Phase 23 (ADR 0025, ADR 0026)
- Deviations (CHANGES 2026-11-01, Phase 23): the boot restart is a tap-to-resume notification; delivered lists are unauthenticated and never remove the sender's copy; relaying needs nearby messaging on; the simulation is in `packages/message-engine/src/mesh/`; recognition stays key-based.
- The relay settings route is `(settings)/nearby-relay.tsx` (screen `screens/settings/relay.tsx`).

## Handoff notes
**From Phase 9 (ADR 0011):**
- A receiver finds the owner of an unknown sending device with `GET /v1/keys/devices/:id`, which is impossible offline.
- For offline first contact, use cached directories: `DirectoryRecord.devices[].fallbackKey` is signature-checked. A Hello handshake is the other option.
- `MeshAck` should map to a `relayed` delivery row (`states.ts` already ranks it).

**From Phase 21 (ADR 0023):**
- The `connectedDevice` foreground service already exists: `NearbyService` in `modules/nearby`, started with `PingdostNearby.startForegroundService()`, `START_NOT_STICKY`, notification "Nearby is on".
  - This phase adapts the text for relaying, keeps it running while relay *or* nearby is on, and adds the optional boot start (Android 15 allows `connectedDevice` from BOOT_COMPLETED).
- Each link grants 8 packets of credit, and a peer that sends without credit is disconnected. That bounds what one neighbour can push at once; per-origin quotas and rate limits still sit above it.
- At most 7 links per phone. Each link carries packets of up to 128 KiB, and the mesh header plus a 64 KiB envelope fits.

**From Phase 22 (ADR 0024):**
- **Peers:** `NearbyPeerTransport` (`packages/transport/src/nearby.ts`) runs the handshake. Links end up `known` (a contact device, direct delivery) or `unknown` (a valid key with no directory entry): the unknown links are the relay candidates.
  - Peers announce `HELLO_CAPABILITY_RELAY` (2) in `Hello.capabilities` when relaying is on.
  - Relay packets need their own `PacketKind`s (`MESH_ACK`, `MESH_CHUNK` are reserved) and should be dispatched in `#onPacket`, where they are ignored today.
  - Only envelopes whose `dst` is this device are accepted now.
- **Slots:** unknown links keep one of the 7 slots and auto-connect may reconnect them. Decide a slot and reconnect policy together with relaying.
- **Recognition:** the handshake shows strangers this phone's stable Ed25519 key (CHANGES 2026-11-01). Before relaying makes many strangers connect, weigh contact-only recognition (an ADR, no custom crypto).
- **Routing:** `TransportRouter.route()` is per device. Add relay routes there, as a transport whose `reaches` answers for routing tokens; the outbox already parks `unreachable` items and flushes on `onRoutesChanged`. A relay's `MeshAck` maps to `relayed`. Record `via` (a new value) if message info should name the relay path.
- **Groups:** fan-out still needs every member's directory, and groups over nearby were not tested.
- **Nearby resend:** a nearby ACK is not tied to the handshake key. A peer that proved a contact's key could ACK and drop envelopes, and the Internet would not resend them (the outbox item is gone). Consider keeping unconfirmed nearby messages to resend over the Internet after a delay.
- **Background:** the foreground service starts only from the foreground (`apps/mobile/src/nearby/service.ts`). A push wake does not start nearby.

**From Phase 15 (ADR 0018):** Settings → Storage has a "Nearby relay cache" row (`screens/settings/storage.tsx`) waiting for real numbers. "Clear cache" there touches only previews and temporary files; give the relay cache its own clear action.