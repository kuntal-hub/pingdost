# Phase 22 — Direct nearby messaging + transport routing

**Depends on:** 10, 21 · **Platforms:** Android, shared TS

## Goal
Two phones with no Internet exchange E2EE messages directly over the nearby transport. The same encrypted packets are used as on the Internet, the router picks the best path, duplicates are impossible, and the UI is honest.

## Read first
- REQ §8.3, §11.1 (modes 1 & 3), §11.2, §11.3, §11.6, §19.4 (bullets 1, 3, 6, 7)
- ARCHITECTURE A4, A5 (Mesh first contact)
- The nearby transport ADR

## Tasks
- [x] **`NearbyTransport`** in `packages/transport` (the REQ §11.2 interface), with the Android implementation in `apps/mobile/src/nearby/` bridging the native module.
  - Done: `NearbyTransport` is the link interface, which `createBleTransport` implements. `NearbyPeerTransport` is the engine-facing `Transport` (kind `nearby`), and `apps/mobile/src/nearby/service.ts` wires the two.
- [x] **Peer handshake** after the link comes up: a signed `HELLO` packet (device ed25519 identity, ephemeral token, protocol version, capabilities). Verify it against the cached device directory.
  - Known contacts' devices → eligible for direct delivery.
  - Unknown peers → kept only as potential relays (Phase 23); no identity is shown to them.
  - Done (ADR 0024): two `Hello`s per side; the proof signs both link tokens and names only the Ed25519 key, not the device ID. Strangers still see that key (CHANGES 2026-11-01).
- [x] **`TransportRouter` policy:**
  - Internet (WS connected) first.
  - Otherwise, if the recipient device is in nearby range, send directly.
  - Otherwise mark `waiting_for_nearby_route` and keep the packet queued.
  - When either path appears, flush.
  - The same envelope may arrive by both paths; the recipient dedupes by messageId, and the sender's state merges.
- [x] **Acknowledgements:** a nearby transport ACK plus the E2EE delivery receipt sent back over the same link, or later via the Internet.
- [x] **Offline first contact:** use the cached fallback key (Phase 9 cache) to create an Olm prekey message offline. If there is no cached key, show "Can't reach this contact offline until you've connected once online".
- [x] **Settings and permissions:**
  - a "Nearby messaging" toggle (local to the phone, off by default);
  - a permission onboarding screen explaining why Bluetooth and Nearby devices are needed (Location on Android 8–11);
  - clear degraded states (Bluetooth off, permission denied, airplane mode), never silent failure (REQ §19.4 last bullet): in Settings and in the offline banner.
- [x] **UI:**
  - status copy "Queued on this device — waiting for a nearby route" (REQ §11.6);
  - a nearby indicator in the chat header when the peer is in range;
  - message info shows the path used (Internet / nearby).
- [x] **Tests:** router unit tests with fake transports (path selection, flush on reconnect, dual-path dedupe, state merge); handshake verification tests.
- [x] **Device checks** (two phones; PROGRESS 2026-11-08). Text both ways with the dev server stopped: message info said "Over Bluetooth, directly to this phone"; queued messages went out when the phones met again; no duplicates once the server was back; Bluetooth off and the denied permission were shown clearly. Airplane mode alone does not cut a phone off from the dev server here (adb reverse runs over USB), so the server was stopped instead. Found and fixed on the way: frames over 512 bytes hung (GATT limit), and a half-dead link now closes after two missed ACKs.

## Key files
- `packages/protocol/proto/pingdost/v1/mesh.proto` (`Hello`, `HelloProof`), `packages/protocol/src/{signing.ts,codec.ts}` (`nearbyHelloMessage`, Hello/Ack codecs)
- `packages/transport/src/{nearby.ts,router.ts,testing.ts}`
- `packages/message-engine/src/routing/identity.ts`, `outbox.ts` (routes, parking, `via`, fallback key, partial fan-out), `engine.ts` (`canReachOffline`)
- `apps/mobile/src/nearby/{service.ts,status.ts}`, `src/screens/settings/{nearby.tsx,nearby-setup.tsx}`, `src/components/offline-banner.tsx`, `src/db/migrations/007-nearby.ts`

## Out of scope
Multi-hop relay (23); file chunks (24).

## Done when
- Two phones in airplane mode (Bluetooth on) exchange text both ways, with correct status labels.
- Turning Internet back on doesn't duplicate messages.
- Bluetooth-denied and Bluetooth-off states are visible.
- The tests pass, and `pnpm lint typecheck test` passes.

## Handoff notes
**From Phase 21 (ADR 0023):**
- The native module `PingdostNearby` (`apps/mobile/modules/nearby`) and `createBleTransport(PingdostNearby)` (REQ §11.2 shape, `modules/nearby/src/transport.ts`, unit-tested with a fake) exist.
  - Put the platform-neutral `NearbyTransport` interface in `packages/transport`; keep the module wrapper in `apps/mobile/src/nearby/`.
- **Link limits:**
  - packets up to 128 KiB (`Link.MAX_PACKET`);
  - a GATT frame carries MTU − 3 bytes (514 at MTU 517, 20 at the default 23); framing is native;
  - `send` resolves when the packet is in the native queue, not on delivery. `linkDown.unsent` counts packets that never went out: the router requeues them;
  - at most 7 links per phone.
- **Identity:** the advert token is random and rotates every 10 minutes, and the link-level HELLO token is not an identity. Send this phase's signed application HELLO as the first packet after `linkUp`.
- **Permissions:**
  - Android 12+: `BLUETOOTH_SCAN`/`ADVERTISE`/`CONNECT`. Android 8–11: fine location, with location services on. Below Android 8: `unsupportedReason: android_too_old`.
  - `start` rejects with `permission`. Bluetooth off is not an error: the engine waits, and `stateChanged`/`getState().enabled` report it.
  - Build the onboarding and degraded states on `getState()` (`missingPermissions`, `enabled`, `supported`).
- **Background:** call `startForegroundService()` (only possible from the foreground) while "Nearby messaging" is on. Without it, nearby works only in the foreground.
- `autoConnect: true` makes the lower-token side connect; duplicate links are resolved natively.
- The dev screen (Settings → Developer → Nearby spike) stays for measurements. The measured numbers are in ADR 0023's matrix (check PROGRESS whether they are filled).

**From Phase 9 (ADR 0011):** `TransportRouter` (`packages/transport/src/router.ts`) sends over the first online transport. Add the nearby transport, routing by recipient reachability and `waiting_for_nearby_route`. Incoming packets already fan in with a per-transport `ack`.
