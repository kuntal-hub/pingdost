# Phase 30 — iOS: nearby & mesh + Android↔iOS interop

**Depends on:** 28 · **Platforms:** iOS + Android · **Status:** 🔄 code written (2026-11-03); device checks blocked on an iPhone, the Apple account and a macOS build

## Goal
Nearby messaging, relaying and file chunks work on iOS within Apple's background limits, and **Android↔iOS** works over BLE. The limits are documented honestly (REQ §11.5).

## Read first
- REQ §11 (all), §19.4, §21 (iOS background row)
- ADRs: nearby transport (0023), nearby messaging (0024), mesh routing (0025), mesh files (0027), this phase (0033)

## Tasks
- [x] Swift implementation of the `modules/nearby` interface (`modules/nearby/ios`, ADR 0033):
  - CoreBluetooth central + peripheral with the same service UUID, framing, credits and rotating tokens as Android (`Core/` ports `Framing.kt`/`Link.kt`; 22 tests on Linux, golden bytes included);
  - state preservation and restoration (restore identifiers, `NearbyAppDelegate`); `bluetooth-central` / `bluetooth-peripheral` background modes;
  - the background advertising limits handled: iOS advertises only the service UUID, the token travels in HELLO/TOKEN, and **the iPhone connects to every peer it is not linked to** (Android cannot see its token).
- [x] Optional high-bandwidth paths evaluated in ADR 0033: MultipeerConnectivity (iOS↔iOS) and Wi-Fi Aware **deferred** until BLE device measurements exist.
- [x] Mesh relay on iOS: the TS relay runs unchanged on the iOS link layer; honest UI copy (`NEARBY_COPY.ios`: iOS may pause relaying, nothing continuous, swipe-away stops it), iOS permission flow, Bluetooth usage string.
- [x] The results matrix to fill in: `docs/ops/nearby-ios-matrix.md`.
- [ ] **First compile:** run `.github/workflows/ios.yml` and fix `BleEngine.swift`/`NearbyModule.swift` until they build.
- [ ] Cross-platform tests on devices (the matrix): Android↔iOS discovery and exchange in the foreground, background, screen-locked and app-killed states; iPhone↔iPhone; restoration; relay A → iPhone → C. Then make the in-app help match what was measured.

## Done when
- REQ §19.4 is met on iOS for the foreground.
- The background behavior is measured and documented.
- Android↔iOS text exchange works over BLE.

## Results (2026-11-03)
- `swift test` (Docker `swift:6.4.2-noble`) in `apps/mobile/modules/nearby/ios`: 22 passed (framing 8, link 9, policy 5).
- Mobile unit tests 125 passed (status +1: iOS wording); lint and typecheck clean.
- Linux `expo prebuild --platform ios`: pass (background modes `fetch`, `remote-notification`, `voip`, `audio`, `bluetooth-central`, `bluetooth-peripheral`; `NSBluetoothAlwaysUsageDescription`). `expo export --platform ios`: pass.
- **Not run:** any Swift compile with CoreBluetooth, any device.

## Handoff notes
**From Phase 24 (ADR 0027):** iOS sends and receives files as the same signed `MESH_CHUNK`s and holds the receipt until `verifyMeshFile` passes. iOS 26 Wi-Fi Aware is the natural bulk path for both platforms (deferred, ADR 0033).

**From Phase 23 (ADR 0025):** iOS relays and receives the same mesh packets; the shared TS runs unchanged; only the link layer and the background limits differ.

**From Phase 22 (ADR 0024):** iOS speaks the same handshake (two `Hello`s, `Ack`s, `dst` = `0x00`): it is `NearbyPeerTransport`, unchanged.

**From Phase 21 (ADR 0023):** GATT layout service `5dd57eaf-834a-4b2d-96f6-b68a646c4a0b`, RX `aa6298cf-710a-43a7-a85e-42eae340dc5a`, TX `5a378fa3-6ee8-409f-bcd4-99790bc7feec` (now in `BleEngine.swift` too).

**For later:** the dev screen (Settings → Developer → Nearby spike) still asks Android permissions and labels "Android SDK"; on iOS `sdk` is the iOS major version. Adjust it when the iPhone matrix runs.
