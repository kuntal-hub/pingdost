# Nearby on iOS: device test matrix (Phase 30, ADR 0033)

REQ §19.4 asks for tests on real devices in the foreground, background, screen-locked, OS-killed, low-battery, low-storage, Bluetooth-denied and airplane-mode states. Background success is best-effort; failures must show, never lose messages. **Nothing below has been run** (no iPhone yet). Record each result as ✅ works, ⚠ works with a delay (say how long), or ❌ does not work, with the date, devices and iOS/Android versions.

## Setup
1. A development build on the iPhone (macOS CI or EAS, after the Apple account; ADR 0031) and a current dev build on each Android phone (the Phase 22 crash fix is in it, ADR 0029).
2. Both phones signed in as contacts who have chatted online once (they need each other's keys).
3. Settings → Nearby messaging on both; for relay rows also Settings → Nearby relay.
4. Internet off: airplane mode with Bluetooth turned back on, or Wi-Fi and mobile data off.
5. iPhone: Settings → Developer → **Nearby spike (dev)** shows links, tokens and the log; **Share report** exports it.

## Matrix
States: **F** app open, **B** app in the background (home screen), **L** screen locked, **K** swiped away, **S** iOS ended the app itself (memory pressure; hard to force: note when seen).

| # | iPhone | Android | Check | Expected (ADR 0033) | Result |
|---|---|---|---|---|---|
| 1 | F | F | Discovery, link, text both ways, receipts | ✅ | |
| 2 | F | F | A 1 MB and a 25 MB file | ✅ at BLE speed | |
| 3 | B | F | iPhone receives a text sent from Android | ✅ or ⚠ (background scanning is slower) | |
| 4 | B | F | iPhone sends (queued while open, then backgrounded) | ✅ or ⚠ | |
| 5 | F | B (foreground service) | Both ways | ✅ | |
| 6 | L | F | Both ways | ⚠ like B | |
| 7 | K | F | Anything | ❌ until PingDost is opened; messages wait on both phones | |
| 8 | S | F | iOS relaunches the app for Bluetooth (restoration) and the link comes back | ⚠ | |
| 9 | B | B | Both in the background | ⚠ only if the iPhone's background scan finds Android's advert | |
| 10 | F | F | Rotation: wait past a token rotation with the link up | The link stays; no second link | |
| 11 | F | F | Bluetooth denied on the iPhone, then allowed in Settings | "Needs Bluetooth access" → on | |
| 12 | F | F | Bluetooth off on the iPhone | "Bluetooth is off" | |
| 13 | F | F | Low Power Mode on the iPhone with relay on and "pause on battery saver" | Relay paused | |
| 14 | F (relay) | F → F | A → iPhone relay → C (third phone or the sim) | ✅ "Forwarded by 1 device", then delivered | |

**iPhone ↔ iPhone** (needs two iPhones):

| # | iPhone A | iPhone B | Expected | Result |
|---|---|---|---|---|
| 15 | F | F | One link after the duplicate rule (both connect) | |
| 16 | F | B | A finds B (overflow area matched by a foreground iPhone) | |
| 17 | B | B | Not found | |

## After the run
- Put the measured results into the in-app wording (`NEARBY_COPY` in `apps/mobile/src/nearby/status.ts`) if they differ from what it says.
- Note setup times, throughput and battery use as in ADR 0023's Android matrix.
