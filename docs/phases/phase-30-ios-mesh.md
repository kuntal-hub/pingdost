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
