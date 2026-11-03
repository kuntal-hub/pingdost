# 0033 — iOS nearby: CoreBluetooth with Android's link protocol, who connects, background limits

- **Status:** Accepted (code; device checks blocked on an iPhone, the Apple account and a macOS build)
- **Date:** 2026-11-03
- **Phase:** 30
- **Approved by user:** n.a. Nothing paid.

## Context
REQ §11 asks for nearby and mesh on both platforms, §19.4 for foreground success on iOS and measured background behaviour, §11.5 and §21 for honesty about iOS background limits. ADR 0023 fixed the BLE GATT layout, framing (HELLO/DATA/CREDIT/TOKEN), credit flow control and the "lower advertised token connects" rule on Android. ADRs 0024, 0025 and 0027 put everything above the link in platform-neutral TypeScript (`NearbyPeerTransport`, `MeshRelay`, files), so iOS needs only a link layer. iOS cannot advertise service data, and in the background it moves service UUIDs to an "overflow" area that only foreground iPhones can match.

## Options considered
| Topic | Option | Pros | Cons | License | Cost |
|---|---|---|---|---|---|
| Link layer | **CoreBluetooth in both roles, same GATT service and framing as Android** | Talks to Android phones; the TS above runs unchanged; no dependency | GATT throughput (tens to low hundreds of KB/s); iOS background limits | Platform | free |
| | MultipeerConnectivity | Fast iPhone↔iPhone (Bluetooth + peer-to-peer Wi-Fi), Apple handles discovery | iPhone only, no Android peer; a second link layer to build and prove; Apple's own session encryption and invitations to fit around ours | Platform | free |
| | Wi-Fi Aware (iOS 26, iPhone 12+) | A bulk path with an Android counterpart (ADR 0023, 0027) | Android hardware support varies; Android↔iOS interop unproven; nothing here can test it | Platform | free |
| Who connects (Android↔iOS) | Keep "lower token connects" | One rule everywhere | Android never sees an iPhone's token, so links form only when the iPhone's token is lower: half of all pairs never link | — | — |
| | Android connects to token-less adverts too | Symmetric | An Android change and a new build; duplicates on every Android↔iPhone pair | — | — |
| | **The iPhone connects to every peer it is not linked to; Android unchanged** | Every Android↔iPhone pair links, from either side's discovery by the iPhone; no Android build needed | iPhone↔iPhone pairs both connect, and the duplicate rule closes one; backoff and remembered tokens stop reconnect loops | — | — |
| Testing without a Mac | Write the Swift and wait for macOS CI | — | Nothing proved until a Mac build | — | — |
| | **Split a pure core (`Core/`: framing, link, policy, inbound queue) and test it on Linux** (Docker `swift:6.4.2-noble`, CI job) | The bytes and the protocol logic are proved now, with the Kotlin tests ported plus golden frames | The CoreBluetooth glue still waits for macOS CI | Apache-2.0 (Swift toolchain, dev only) | free |

## Decision
1. **`modules/nearby/ios`** (Swift, no dependency):
   - `Core/Framing.swift`, `Core/Link.swift`: ports of `Framing.kt` and `Link.kt` with the same bytes, limits (128 KiB packets, 8 credits, batches of 4, 512 KiB queue, 64 waiting sends) and failure reasons. `Core/Policy.swift`: tokens, `ConnectPolicy` (below), the duplicate rule (Android's `maybeUp`), and `InboundQueue` (the `linkId u32 | length u32 | bytes` batches `parseInbound` reads).
   - `Package.swift` builds `Core/` alone; `swift test` runs 22 tests on Linux (the ported `FramingTest`/`LinkTest`, golden bytes, policy, batches). CI job `swift-nearby` runs them in the `swift:6.4.2-noble` container.
   - `BleEngine.swift` (CoreBluetooth): GATT server with RX (write, write without response) and TX (notify); scans with the service filter; advertises **only the service UUID** (no name, no service data); writes without response paced by `canSendWriteWithoutResponse`/`peripheralIsReady`, notifications paced by `updateValue`/`peripheralManagerIsReady`; MTU from `maximumWriteValueLength`/`maximumUpdateValueLength` + 3; the token rotates (30–3600 s) and travels in HELLO/TOKEN frames only; 7 links; the same events and state shape as Android (`address` is the CoreBluetooth peer UUID; `power` maps Low Power Mode, battery and foreground onto the Android fields).
   - `NearbyModule.swift` (`PingdostNearby`, the same functions; `startForegroundService`, `setRelayNotification`, `setRestartReminder` do nothing; `requestPermission` is iOS-only) and `NearbyAppDelegate.swift`.
2. **Who connects:** an iPhone connects to every PingDost peer it discovers unless it is already linked to it (by peer UUID, by the token Android advertises, or by a token remembered from an earlier link to that UUID), with a 10 s backoff. Android keeps ADR 0023's rule and never connects to a token-less advert, so an Android↔iPhone pair has exactly one link. Two iPhones both connect; both keep the link whose central had the lower HELLO token.
3. **Background:** background modes `bluetooth-central` and `bluetooth-peripheral`; restore identifiers on both managers; the AppDelegate subscriber recreates them when iOS relaunches the app for Bluetooth. Restored connections are dropped and redone, because sequence numbers and credits died with the process. iOS does not relaunch an app the user swiped away. The managers are created only when nearby starts or asks for permission, so the Bluetooth prompt never appears at launch.
4. **App:** `requestNearbyPermissions` asks iOS (`requestPermission`); `NEARBY_COPY` and `describeNearby(…, 'ios')` give iOS wording: Bluetooth access, Control Center, "Keep PingDost open to be found", and background limits for nearby and relaying that promise nothing continuous (tested). `NSBluetoothAlwaysUsageDescription` in app.json.
5. **MultipeerConnectivity and Wi-Fi Aware are deferred.** BLE is the only path both platforms share and the only one the TS layers use. Revisit them once the BLE device measurements (ADR 0023's matrix) exist on an iPhone and two Android phones; Wi-Fi Aware needs an iPhone 12+ and an Android phone with `FEATURE_WIFI_AWARE`.

## Consequences
- **Expected iOS limits (to measure; `docs/ops/nearby-ios-matrix.md`):** foreground ↔ anything works; an iPhone in the background still scans (slower, no duplicates) and keeps its links, so it can reach phones with PingDost open, but Android and backgrounded iPhones cannot discover it (overflow area); two backgrounded iPhones do not find each other; a swiped-away app does nothing; a locked screen behaves like the background.
- iOS cannot drop a central from the peripheral side: a central over the link limit gets no HELLO and times out (20 s).
- Relaying on iOS is best-effort by design (REQ §11.5); the UI says iOS may pause it.
- Not compiled: `BleEngine.swift`, `NearbyModule.swift`, `NearbyAppDelegate.swift` (first compile: `.github/workflows/ios.yml`).

## Evidence
- `docker run … swift:6.4.2-noble swift test` in `apps/mobile/modules/nearby/ios`: 22 tests, 0 failures (2026-11-03). Swift 6.4.2 was the newest Docker Hub tag that day.
- Linux `expo prebuild --platform ios`: Info.plist has `bluetooth-central`, `bluetooth-peripheral` and `NSBluetoothAlwaysUsageDescription`.
- iOS facts used from ADR 0023 (dated research): no service data in iOS adverts, the overflow area in the background, iOS 26 Wi-Fi Aware on iPhone 12+. CoreBluetooth APIs as known when written, **not re-checked against Apple's docs this session**: restore identifiers and `willRestoreState`, `canSendWriteWithoutResponse`, `maximumUpdateValueLength`, the absence of a "disconnect central" API.
