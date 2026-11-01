# Phase 30 — iOS: nearby & mesh + Android↔iOS interop (DEFERRED)

**Depends on:** 28 · **Platforms:** iOS + Android · **Status:** ⏸

## Goal
Nearby messaging, relaying and file chunks work on iOS within Apple's background limits, and **Android↔iOS** works over BLE. The limits are documented honestly (REQ §11.5).

## Read first
- REQ §11 (all), §19.4, §21 (iOS background row)
- ADRs: nearby transport, mesh routing

## Tasks (outline)
- [ ] Swift implementation of the `modules/nearby` interface:
  - CoreBluetooth central + peripheral, the same service UUID, framing and rotating tokens as Android;
  - **state preservation and restoration**; `bluetooth-central` / `bluetooth-peripheral` background modes;
  - an awareness of the restrictions on background advertising (service UUIDs move to the overflow area, so background discovery is limited).
- [ ] Optional high-bandwidth paths: MultipeerConnectivity (iOS↔iOS), and re-evaluate Wi-Fi Aware for Android↔iOS (an ADR update).
- [ ] Cross-platform tests: Android↔iOS discovery and exchange in the foreground, background, screen-locked and app-killed states. Record the results matrix; the in-app help reflects what works.
- [ ] Mesh relay on iOS, best-effort, with honest UI copy that iOS may pause relaying.

## Done when
- REQ §19.4 is met on iOS for the foreground.
- The background behavior is measured and documented.
- Android↔iOS text exchange works over BLE.

## Handoff notes
**From Phase 24 (ADR 0027):** iOS sends and receives files as the same signed `MESH_CHUNK`s (`meshChunkMessage`, `meshChunkPacketId`, `MeshSummary.transfers` bitmaps) and holds the receipt until `verifyMeshFile` passes. iOS 26 Wi-Fi Aware is the natural bulk path for both platforms.

**From Phase 23 (ADR 0025):** iOS relays and receives the same mesh packets: `MESH_ENVELOPE` with daily routing tokens (`meshRoutingToken`), the sender's signature (`meshEnvelopeMessage`), `MeshSummary` after the handshake, signed `MeshAck`s (`meshAckMessage`) and spray copies. The shared TS (`@pingdost/mesh-protocol`, `MeshRelay`) should run unchanged; only the link layer and the background limits differ (iOS gives far less background time).

**From Phase 22 (ADR 0024):** iOS must speak the same handshake to reach Android phones:
- two `Hello`s per link, the second with a `HelloProof` over `nearbyHelloMessage`;
- `Ack` packets on the same link;
- HELLO and ACK with `dst` = `0x00`.

`NearbyPeerTransport` is platform-neutral TypeScript: an iOS `NearbyTransport` (link layer) is all that is missing.

**From Phase 21 (ADR 0023):**
- Android's GATT layout: service `5dd57eaf-834a-4b2d-96f6-b68a646c4a0b`, RX `aa6298cf-710a-43a7-a85e-42eae340dc5a` (write without response), TX `5a378fa3-6ee8-409f-bcd4-99790bc7feec` (notify). Framing (HELLO/DATA/CREDIT/TOKEN) is in `modules/nearby/android/.../Framing.kt`, with JVM tests to port.
- Android puts the rotating token in the scan response as service data. iOS cannot advertise service data, and in the background it moves service UUIDs to its overflow area, so an iPhone's token comes only from the link HELLO. Android may not discover a backgrounded iPhone at all: measure it.
- iOS 26 has a Wi-Fi Aware framework (iPhone 12 and later), and Phase 24 may add Android Wi-Fi Aware: check whether the two interoperate before choosing MultipeerConnectivity.
