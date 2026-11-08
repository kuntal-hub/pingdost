# 0023 — Nearby transport: BLE GATT on platform APIs, rotating tokens, a connectedDevice foreground service

- **Status:** Accepted (design and code). The device matrix below is still to be measured on two phones.
- **Date:** 2026-10-31
- **Phase:** 21
- **Approved by user:** n.a. (no gate). On 2026-10-31 the user chose "BLE only, no Google library" for the Nearby Connections license question.

## Context
REQ §11.1 needs direct nearby delivery, store-and-forward relay and mixed routing. §11.2 asks for a native transport abstraction whose API is chosen only after a proof of concept. §11.5 and §19.4 make background mesh a best-effort requirement whose failures must show visibly. REQ §20's Phase 0 lists this nearby spike. ARCHITECTURE A6 plans a Kotlin Expo module and a `connectedDevice` foreground service; A12 keeps iOS for later (Phase 30). CLAUDE.md requires permissive or OSI-licensed dependencies.

## Options considered
| Option | Pros | Cons | License | Cost |
|---|---|---|---|---|
| **BLE GATT on Android's platform APIs** (chosen) | On every Android 8+ phone with BLE, including de-Googled ones. The same GATT model as iOS CoreBluetooth (Phase 30). Small packets work at the default MTU. | Low throughput (expected tens to low hundreds of KB/s). About 7 links per phone. Background limits. | Platform (AOSP) | free |
| Google Nearby Connections (`play-services-nearby` 19.5.1, 2026-09-28) | BLE discovery plus an automatic Wi-Fi upgrade (MB/s) for `P2P_STAR`/`P2P_POINT_TO_POINT`. Topology handled. | Needs Google Play services. Closed source under the Android SDK License (not OSI). No iOS peer. **Rejected by the user** (license rule). | Proprietary | free |
| Wi-Fi Direct (`WifiP2pManager`) | Platform API, high throughput, no Play Services | One group at a time. OEM quirks. Invitation dialogs unless a group's name and passphrase are shared out of band (API 29+). `NEARBY_WIFI_DEVICES` on Android 13+. No iOS. | Platform | free |
| Wi-Fi Aware (`WifiAwareManager`) | Platform API, high throughput, several sessions. **iOS 26 has a Wi-Fi Aware framework** (iPhone 12 and later), so it is the one bulk path with an iOS future. | Hardware-dependent: many Android phones lack it. `NEARBY_WIFI_DEVICES`. Untested here. | Platform | free |
| BLE L2CAP connection-oriented channels (Android 10+) | Stream semantics; usually faster than GATT writes; iOS has L2CAP too | Android 10+ only; more moving parts for a spike | Platform | free |
| BitChat-android as a base | A working BLE mesh to learn from | **GPL-3.0** since 1.7.x (was MIT; it was never public domain). Copying code would change this project's license terms. | GPL-3.0 | — |

## Decision
1. **Transport:** BLE GATT through the platform APIs, in the local Expo module `apps/mobile/modules/nearby` (Kotlin; JS in `modules/nearby/src`).
   - Every phone is both a GATT server and a client of one primary service `5dd57eaf-834a-4b2d-96f6-b68a646c4a0b`.
   - The server's `RX` (`aa6298cf-…`) takes write-without-response from the central. Its `TX` (`5a378fa3-…`) notifies the central.
   - The central asks for **MTU 517** (Android 14+ always negotiates 517 for the first client, then min(517, peer)), connection priority `HIGH` and **LE 2M PHY** when supported.
   - No Play Services, no new dependency; JUnit 4.13.2 (EPL-1.0) for tests only.
2. **Discovery without a static identifier:**
   - The advert is legacy (31 bytes, so iOS-readable): flags plus the 128-bit service UUID, connectable and scannable.
   - The **scan response** carries an **8-byte random token** as service data. There is no device name and no TX power.
   - The token rotates every 10 minutes (30–3600 s configurable). Each rotation restarts the advertising set, which on most stacks also gets a new random address (to verify on the devices).
   - Peers already linked learn the new token over the link (`TOKEN` frame), so they don't connect a second time.
   - Scans always use a service-UUID filter: Android stops unfiltered scans while the screen is off.
3. **Link protocol** (`Framing.kt`, `Link.kt`; one frame per GATT write or notification of at most MTU − 3 bytes):
   - `HELLO` (version, token, max packet, credits), `DATA` (first/last flags, a 16-bit per-link sequence, length on the first fragment), `CREDIT`, `TOKEN`.
   - Packets of up to **128 KiB**, so a 64 KiB envelope or file chunk plus headers fits.
   - Credit flow control: 8 packets initially, returned in batches of 4 as the app takes packets. A peer that sends without credit, skips a sequence number or breaks the framing is disconnected.
   - Per link, 512 KiB may wait in the outbound queue; after that `send` waits (backpressure), and more than 64 waiting sends fail with `queue_full`.
   - At most **7 links** per phone.
4. **Native queues:**
   - Outbound packets keep sending while JS is busy.
   - Inbound packets wait in a native queue until JS takes them in batches (`receive`, `linkId u32 | length u32 | bytes`). Credits go back only then, so a suspended JS stalls the sender instead of losing packets.
   - The engine is a process singleton: links and queued packets survive a JS reload.
   - `linkDown` reports how many packets were never sent, for the router to resend elsewhere (Phase 22).
5. **Who connects:**
   - With auto-connect on, only the side with the **lower token** connects.
   - If both connect anyway, each phone keeps the link whose central had the lower HELLO token, so both close the same one.
6. **Security boundary:**
   - The BLE link is neither authenticated nor encrypted. There is no BLE pairing: it shows system dialogs and leaves a persistent bond identifier.
   - Everything above the link is E2EE (Olm/Megolm, ADR 0003). Phase 22's signed application HELLO authenticates contacts. Relays see only the outer mesh header (Phase 23, REQ §11.3).
   - The module never logs packet contents; its `log` event carries states and sizes only.
7. **Background:**
   - A `connectedDevice` **foreground service** (`NearbyService`, a persistent "Nearby is on" notification) keeps the process out of the cached state, so it is not frozen or killed while nearby or relay is enabled.
   - Android 14+ requires `FOREGROUND_SERVICE_CONNECTED_DEVICE` plus a granted Bluetooth runtime permission for it. Android 15's BOOT_COMPLETED restriction does not list `connectedDevice`.
   - It is started from the foreground only (Android 12+ refuses background starts). The OS may still stop it.
   - Without it, nearby is foreground-only in practice.
8. **Permissions and versions:**
   - Android 12+: `BLUETOOTH_SCAN` (`neverForLocation`), `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT`.
   - Android 8–11: `ACCESS_FINE_LOCATION` (and location services on), plus the legacy `BLUETOOTH`/`BLUETOOTH_ADMIN`, all capped at `maxSdkVersion 30` (checked in the merged manifest).
   - **Nearby needs Android 8.0 (API 26)**, for advertising sets and PHY options. The app's minSdk stays 24, and 7.x phones report `android_too_old`.
   - Bluetooth off, permission revoked and unsupported hardware are explicit states and errors, never silent.
9. **Bulk transfer:**
   - Google Nearby Connections is **not used** (user decision).
   - Phase 24 starts from BLE chunks. It evaluates **Wi-Fi Aware** first (platform API, iOS 26 interop), then **Wi-Fi Direct** with credentials exchanged over the BLE link, as an optional faster path between phones that both support it.
10. **iOS outlook (Phase 30):**
    - CoreBluetooth in both roles, with state restoration.
    - In the background, iOS moves service UUIDs to its overflow area and drops service data, so an iOS peer's token arrives only in the HELLO after connecting, and Android may not discover a backgrounded iPhone at all.
    - Android↔iOS stays BLE only; Wi-Fi Aware is revisited there.
    - No continuous background mesh is promised on iOS (REQ §11.5).

## Consequences
- Phase 22 builds on `createBleTransport` (REQ §11.2's interface in `modules/nearby/src/transport.ts`, to be moved behind `packages/transport`'s `NearbyTransport`). It also adds the product toggle, the permission onboarding and the visible degraded states, and decides when to start the foreground service.
- Phase 23 reuses `NearbyService` for relaying (notification text, opt-in, optional boot start).
- Phase 24 sizes chunks at 64 KiB per link packet and sets the default mesh file limit from the measured throughput. Its Nearby Connections task becomes the Wi-Fi Aware/Direct evaluation.
- Phase 27 adds the Play Console declarations: foreground service type `connectedDevice` with a video, and the Bluetooth permission use.
- The phase files for Phases 22–24 were updated, and CHANGES 2026-10-31 (Phase 21) records the deviations.
- The dev screen (Settings → Developer → Nearby spike) is excluded from release bundles. The module and its permissions ship in every build.

## Measurement matrix (fill on two phones; dev screen → Share report)
Expected values come from documentation and community reports, not from this project. "?" means not measured yet.

Measured 2026-11-07/08 on a Nothing A001T and a vivo V2437 (both Android 16), debug builds over adb (PROGRESS 2026-11-08). The background rows were run with the product path (Nearby messaging, which always runs the foreground service; messages sent with the dev server stopped), not the spike screen's auto-ping. Before these runs, every packet over 512 bytes hung: Android refuses GATT values over 512 bytes, so frames are now capped at `min(MTU − 3, 512)`.

**Throughput and setup** (both phones in the foreground, scan mode `lowLatency`, about 1 m apart)
| Measure | Expected | Measured |
|---|---|---|
| Discovery, Start → first `peerDiscovered` | < 2 s | 0.7 s |
| Link setup, connect → both HELLOs (`setupMs`) | 0.5–2 s | 1.0 s |
| Negotiated MTU and PHY | 517 / 2M on Android 14+ phones with 2M | 517 / 2M |
| 1 MB, central → peripheral (writes) | 50–150 KB/s | not run separately (10 MB below) |
| 1 MB, peripheral → central (notifications) | 50–150 KB/s | not run separately (10 MB below) |
| 10 MB, either way | as for 1 MB, steady | 87.6 KB/s writes, 83.7 KB/s notifications; 20 299/20 299 frames |
| Ping round trip (auto-ping) | 20–60 ms | 61 ms average, 20/20 |
| Range indoors, line of sight, until auto-ping fails | 10–30 m | ? (needs someone to walk) |

**Background** (link up, auto-ping on from the other phone, 5 minutes per row unless stated)
| Scenario | Expected | Measured |
|---|---|---|
| App in the background (Home), screen on | works for a while; may freeze once cached | works (message delivered over Bluetooth) |
| Screen off, no foreground service | stops within minutes (frozen cached app) | ? (the product always runs the service) |
| Screen off, foreground service on | keeps working | ? |
| Doze forced (`adb shell dumpsys deviceidle force-idle`), service on | the link holds; scans slow down | works (delivered) |
| Doze forced, no service | stops | ? |
| Battery saver on, service on | works; scans may be throttled | works (delivered; phone marked unplugged with `dumpsys battery unplug`) |
| App swiped away from Recents, service on | stock Android keeps it; some OEMs kill it | ? |
| Bluetooth turned off while linked | `linkDown bluetooth_off`, "Bluetooth OFF" shown; turned on → advertising and scanning resume | "Bluetooth off" shown clearly; the resume was not checked on its own |
| A Bluetooth permission revoked in Settings | the app restarts; Start fails with `permission`, missing list shown | the denied state is shown, with "Open app settings" |
| Airplane mode with Bluetooth on | discovery, links and packets work | works |
| 1 h relay-idle (advertise + scan, service on, screen off, no link): battery drop | ≈1–3 % | ? (needs the phone unplugged from USB) |

A link left half-dead after airplane-mode flips now closes after two missed ACKs (`MAX_MISSED_ACKS`); on the phones it recovered by itself in about 3 minutes.

### How to measure
1. Build and install the dev client on both phones (`pnpm --filter @pingdost/mobile android`, once per phone; the module is new native code).
2. On each phone: Settings → Developer → **Nearby spike (dev)** → **Permissions** (allow) → **Start**. Leave "Auto-connect" on.
3. The peers appear and, a moment later, a link. Note the discovery and setup lines under Results.
4. On one link, tap **1 MB**, then **10 MB**. Repeat from the other phone, since the other role sends notifications instead of writes.
5. Turn **Auto-ping** on, walk away until pings stop, and note the distance.
6. Background rows: keep auto-ping running on phone A. Change phone B's state as each row says (foreground service button on the screen; Doze with the `adb` command above, and `adb shell dumpsys deviceidle unforce` afterwards). Watch A's ping counts.
7. Battery: on phone B, start the foreground service, tap **Mark battery**, stop phone A's nearby, and turn B's screen off for an hour. Then open the screen and read "Battery since mark".
8. Tap **Share report** on each phone and send the text back; the numbers go into this table and PROGRESS.

## Evidence
Checked 2026-10-31 by web search. Several were read from search summaries rather than the full pages; re-open them before quoting figures:
- Android 14 behaviour changes, "MTU is set to 517 for the first GATT client requesting an MTU": developer.android.com/about/versions/14/behavior-changes-all. A Nordic DevZone thread shows `requestMtu(460)` answered with 517 on Android 14.
- Foreground service types required on Android 14 (`connectedDevice` needs `FOREGROUND_SERVICE_CONNECTED_DEVICE` plus one of the Bluetooth, Wi-Fi, NFC or USB runtime prerequisites): developer.android.com/about/versions/14/changes/fgs-types-required.
- Android 15 bars BOOT_COMPLETED starts for `dataSync`, `camera`, `mediaPlayback`, `phoneCall`, `mediaProjection` and `microphone` (not `connectedDevice`): developer.android.com/about/versions/15/changes/foreground-service-types.
- Android 16 adds bond-loss and encryption-change intents for apps targeting it (not needed here, since there is no bonding): developer.android.com/about/versions/16/summary.
- Unfiltered BLE scans stop with the screen off since Android 8.1. Samsung needs a non-empty filter (Samsung developer forum; Stack Overflow archive). Android 7+ throttles apps that start scans more than about 5 times in 30 s (community reports; we start once).
- `play-services-nearby` 19.5.1 (2026-09-28): developers.google.com/android/guides/releases. Strategies and bandwidth: developers.google.com/android/reference/com/google/android/gms/nearby/connection/Strategy. The Wi-Fi upgrade exists only for STAR and POINT_TO_POINT, per a 2018 answer from a Nearby engineer.
- bitchat-android changelog "update license from MIT to GPLv3": github.com/permissionlesstech/bitchat-android/releases (a mirror lists GPL-3.0).
- iOS 26 Wi-Fi Aware framework, available worldwide, iPhone 12 and later (MacRumors 2025-06-21, heise, Apple developer forums).
- Build checks (this PC): the module compiles (`:nearby:compileDebugKotlin`); 16 JVM tests pass (`FramingTest` 7, `LinkTest` 9, `:nearby:testDebugUnitTest`); autolinking lists `com.pingdost.nearby.NearbyModule` and `:expo:compileDebugKotlin` passes; the merged app manifest has the permissions above, the service with `foregroundServiceType="connectedDevice"`, and `maxSdkVersion="30"` on the legacy ones; Metro bundles the dev route for Android.
