# Phase 23 — Mesh store-and-forward relay

**Depends on:** 22 · **Platforms:** shared TS, Android

## Goal
Opt-in devices temporarily store and forward encrypted third-party packets with hop, TTL, dedupe, quota and battery policies. It must be proven A→B→C, where B cannot read or alter the packet, and the UI must distinguish "relayed" from "delivered".

## Read first
- REQ §8.3, §11.1 (mode 2), §11.3, §11.4, §11.5, §11.6, §14.3 (separate caches), §19.1 (bullet 3), §19.4
- ARCHITECTURE A4
- The nearby transport ADR

## Tasks
- [ ] **`packages/mesh-protocol`:**
  - `MeshHeader` handling: unique packet ID, creation time, absolute expiry, destination routing token, hop budget, type, chunk ref, integrity;
  - **validation:** reject expired, malformed, oversized and over-budget packets; decrement the hop budget per hop; `MESH_PACKET_MAX_HOPS` and `MESH_PACKET_TTL_SECONDS` from config;
  - a **bounded seen-cache** (LRU + expiry, persisted to `seen_mesh_packets`);
  - a **relay store**: byte cap `MESH_RELAY_STORAGE_LIMIT_BYTES` (default 250 MB), eviction (expired first, then oldest), per-origin quotas, and rate limits on packet creation, relay and discovery;
  - **forwarding strategy ADR** (mesh routing & relay policy): bounded-copy spray-and-wait vs flooding with a hop limit; routing token design (e.g. a rotating token derived from the recipient device ID + epoch day; identifiers only, no new crypto); what relays can see (REQ §11.3);
  - **mesh ACKs:** the destination's delivery ACK propagates so relays drop their stored copies.
- [ ] **Relay receipts:** when B accepts a packet from A, B returns a signed `accepted` frame, and A moves the message to `relayed` ("Forwarded by N devices — not yet delivered"). The final state still requires the recipient's E2EE receipt; its hop count is optional.
- [ ] **Consent and controls:**
  - an explicit opt-in screen "Allow this device to relay messages", explaining routing metadata visibility, battery and storage, with an easy off switch. **Disabling it stops forwarding new third-party packets immediately.**
  - **Clear relay cache** sits in the Storage screen, separate from chat history.
- [ ] **Policies:** pause relaying when the battery is below a threshold or the saver is on, storage is low, or the data/battery mode is restricted (user settings). All thresholds are configurable.
- [ ] **Android foreground service** (`connectedDevice`) while relay or nearby is enabled, with a persistent notification "PingDost nearby relay active". Stop it when disabled. Make boot restart optional and best-effort. Document the background limits in the in-app help (REQ §11.5).
- [ ] **Simulation harness** (`packages/mesh-protocol/test/sim/` or `tools/sim-client`): virtual devices with an in-memory nearby transport and a mobility schedule. **Scenarios:**
  - A→B→C delivery, where C decrypts;
  - B cannot decrypt, because it has no keys;
  - tamper at B is detected at C;
  - duplicate encounters create no duplicates;
  - expired and over-hop packets are dropped;
  - relay disabled → no forwarding;
  - storage cap and per-origin quota enforced;
  - spam origin rate-limited.
- [ ] **Device test:** with 2 phones, verify relay acceptance and the receipt UI. With a 3rd phone (if available), do a physical A→B→C run, with B out of A's range when it delivers. Otherwise record it as pending in PROGRESS.

## Key files
`packages/mesh-protocol/src/*`, `packages/mesh-protocol/test/sim/*`, `apps/mobile/src/nearby/relay*`, `apps/mobile/modules/nearby/android/**` (foreground service), `apps/mobile/app/(app)/settings/relay.tsx`

## Out of scope
File chunk transfer (24); iOS (30).

## Done when
- Every simulation scenario passes.
- The relay opt-in, opt-out and cache clearing work on a device.
- The UI distinguishes queued / relayed / delivered.
- The ADR is written, and `pnpm lint typecheck test` passes.

## Handoff notes
**From Phase 9 (ADR 0011):**
- A receiver finds the owner of an unknown sending device with `GET /v1/keys/devices/:id`, which is impossible offline.
- For offline first contact, use cached directories: `DirectoryRecord.devices[].fallbackKey` is signature-checked. A Hello handshake is the other option.
- `MeshAck` should map to a `relayed` delivery row (`states.ts` already ranks it).
