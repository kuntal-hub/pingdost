# Phase 21 — Nearby connectivity spike (Android)

**Depends on:** 03 · **Platforms:** Android (2 real phones; BLE does not work in emulators)

## Goal
Find out, on real Android phones, what offline nearby transport actually delivers. This is the REQ §20 nearby spike: discovery, connection, throughput, background behavior and permissions. The output is a native module foundation and an ADR choosing the transport stack.

## Read first
- REQ §11.1, §11.2, §11.5, §19.4 (last bullet), §21 (rows on iOS/background, battery)
- ARCHITECTURE A6, A12
- **Load skill `expo:expo-overview`** → `expo-module`

## Tasks
- [ ] **Research (web search, dated):**
  - current Android BLE APIs: GATT server and client, advertising limits, extended advertising, MTU (up to 517), 2M PHY;
  - Android 12+ permissions (`BLUETOOTH_SCAN` with `neverForLocation`, `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT`), Android 14/15 foreground-service type rules (`connectedDevice`), background scan restrictions and Doze;
  - Google **Nearby Connections** (Play Services dependency, strategies, bandwidth upgrade to Wi-Fi), **Wi-Fi Direct**, **Wi-Fi Aware**;
  - **BitChat-android** design (BLE mesh, public domain; confirm the license) as a reference.
- [ ] **Expo local module `apps/mobile/modules/nearby`** (Kotlin):
  - advertise a PingDost service UUID with a **rotating ephemeral peer token**, so there is no static identifier in adverts;
  - scan with filters;
  - GATT server with write and notify characteristics; GATT client connect;
  - MTU negotiation;
  - a **framing layer**: length-prefixed fragments, reassembly, a per-link sequence, flow control;
  - multiple concurrent links;
  - events to JS: `peerDiscovered`, `linkUp`, `linkDown`, `packet`;
  - a small **native inbound/outbound queue**, so packets survive brief JS suspension.
- [ ] **Optional second module path:** a Nearby Connections wrapper for bulk transfer between Android devices. Measure it, and note the Play Services requirement and the fallback to BLE on de-Googled phones.
- [ ] **Dev screen** `app/(dev)/nearby.tsx`: discover, connect, send text, a throughput test (1 MB and 10 MB), latency, and a live link log.
- [ ] **Measure and record a matrix:**
  - throughput, connection setup time and range for BLE and Nearby Connections;
  - behavior foreground / background / screen-off / with the foreground service / Doze / battery saver / app swiped away / **Bluetooth off or denied**;
  - battery drain over 1 h relay-idle.
- [ ] **ADR (nearby transport):**
  - the chosen stack (BLE baseline for discovery and small packets, optional Nearby Connections for bulk on Android);
  - the background strategy (a foreground service while nearby/relay is enabled);
  - the honest limits;
  - the iOS outlook: CoreBluetooth with state restoration; Android↔iOS over BLE only; Wi-Fi Aware to revisit in Phase 30.
- [ ] Update the Phase 22–24 files with the concrete findings, such as MTU and realistic file sizes.

## Key files
`apps/mobile/modules/nearby/{android/**,src/index.ts,expo-module.config.json}`, `apps/mobile/app/(dev)/nearby.tsx`

## Out of scope
Message routing (22); relay logic (23).

## Done when
- Two phones in **airplane mode with Bluetooth on** discover each other and exchange packets both ways via the module.
- The throughput and background matrix and the ADR are written; PROGRESS summarizes them.
- `pnpm lint typecheck` passes.
