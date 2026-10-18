# Phase 22 — Direct nearby messaging + transport routing

**Depends on:** 10, 21 · **Platforms:** Android, shared TS

## Goal
Two phones with no Internet exchange E2EE messages directly over the nearby transport. The same encrypted packets are used as on the Internet, the router picks the best path, duplicates are impossible, and the UI is honest.

## Read first
- REQ §8.3, §11.1 (modes 1 & 3), §11.2, §11.3, §11.6, §19.4 (bullets 1, 3, 6, 7)
- ARCHITECTURE A4, A5 (Mesh first contact)
- The nearby transport ADR

## Tasks
- [ ] **`NearbyTransport`** in `packages/transport` (the REQ §11.2 interface), with the Android implementation in `apps/mobile/src/nearby/` bridging the native module.
- [ ] **Peer handshake** after the link comes up: a signed `HELLO` packet (device ed25519 identity, ephemeral token, protocol version, capabilities). Verify it against the cached device directory.
  - Known contacts' devices → eligible for direct delivery.
  - Unknown peers → kept only as potential relays (Phase 23); no identity is shown to them.
- [ ] **`TransportRouter` policy:**
  - Internet (WS connected) first.
  - Otherwise, if the recipient device is in nearby range, send directly.
  - Otherwise mark `waiting_for_nearby_route` and keep the packet queued.
  - When either path appears, flush.
  - The same envelope may arrive by both paths; the recipient dedupes by messageId, and the sender's state merges.
- [ ] **Acknowledgements:** a nearby transport ACK plus the E2EE delivery receipt sent back over the same link, or later via the Internet.
- [ ] **Offline first contact:** use the cached fallback key (Phase 9 cache) to create an Olm prekey message offline. If there is no cached key, show "Can't reach this contact offline until you've connected once online".
- [ ] **Settings and permissions:**
  - a "Nearby messaging" toggle;
  - a permission onboarding screen explaining why Bluetooth and Nearby devices are needed;
  - clear degraded states (Bluetooth off, permission denied, airplane mode), never silent failure (REQ §19.4 last bullet).
- [ ] **UI:**
  - status copy "Queued on this device — waiting for a nearby route" (REQ §11.6);
  - a nearby indicator in the chat header when the peer is in range;
  - message info shows the path used (Internet / nearby).
- [ ] **Tests:** router unit tests with fake transports (path selection, flush on reconnect, dual-path dedupe, state merge); handshake verification tests.

## Key files
`packages/transport/src/{nearby.ts,router.ts}`, `apps/mobile/src/nearby/*`, `packages/message-engine/src/routing/*`

## Out of scope
Multi-hop relay (23); file chunks (24).

## Done when
- Two phones in airplane mode (Bluetooth on) exchange text both ways, with correct status labels.
- Turning Internet back on doesn't duplicate messages.
- Bluetooth-denied and Bluetooth-off states are visible.
- The tests pass, and `pnpm lint typecheck test` passes.
