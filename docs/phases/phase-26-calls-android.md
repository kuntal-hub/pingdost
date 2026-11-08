# Phase 26 — Calls B: Android calls & incoming-call UX

**Depends on:** 12, 25 · **Platforms:** Android (+ web interop)

## Goal
Reliable one-to-one audio and video calls on Android, phone↔phone and phone↔web. The phone wakes for incoming calls via push, shows a proper incoming-call UI, handles audio routing and camera, and recovers from network changes.

## Read first
- REQ §12 (all), §19.5 (call bullets)
- ARCHITECTURE A6
- **Load skill `expo:expo-overview`**

## Tasks
- [x] **`react-native-webrtc`** + its Expo config plugin (check current versions and compatibility). Implement the call-engine platform adapter for RN.
- [x] **Incoming call:** (ADR 0029: full-screen-intent call notification in a local module; the server's `call` push was done in Phase 25)
  - the server sends a high-priority FCM `{t:"call"}` (no SDP, no caller info) to the callee's devices when an invite targets an offline or backgrounded device;
  - the app wakes → connects WS → receives the E2EE offer → shows the incoming UI.
  - **Evaluate and choose (ADR):** a self-managed `ConnectionService` (e.g. a maintained callkeep-style library) vs a full-screen-intent notification (notifee or a custom module), against Android 14+ full-screen-intent permission rules. Ringing timeout, plus a missed-call local notification.
- [x] **In-call:**
  - mute; video on/off; front/back camera switch;
  - speaker / earpiece / Bluetooth headset routing (e.g. an in-call manager library or a small native module);
  - proximity sensor screen-off on earpiece;
  - keep-awake; foreground service with a `phoneCall` or `microphone|camera` type as Android requires;
  - permission handling with explanations.
- [x] **Network transitions:** detect Wi-Fi ↔ mobile switches → ICE restart → show "Reconnecting"; failure after a timeout → "Call failed".
- [x] **Busy and edge cases:** (GSM call from the audio mode; CHANGES 2026-11-01) a second incoming call while in a call → busy; a call while a GSM call is active; the app killed during ringing.
- [ ] **Test matrix** (record it in PROGRESS; open: needs phones): phone↔phone on the same Wi-Fi, phone on mobile data ↔ phone on Wi-Fi, TURN-forced, phone↔web, a network switch mid-call, a locked-screen incoming call, the app killed before the incoming call.
  - **2026-11-08 on two phones** (dev server; the only TURN the phones reach is the local coturn through `adb reverse tcp:3478`):
    - passed: same Wi-Fi (voice, video, speaker, mute, missed, busy); TURN-forced ("Relayed (TURN), forced"); mobile data ↔ Wi-Fi (connected, held 1:30+); locked-screen incoming call while the callee's socket was up; the full-screen-intent card appears when the permission is off and opens Android's page.
    - **a network switch mid-call: failed, fixed (`7a815bd`), then passed.** Wi-Fi → mobile data and back on the callee ended every call after about 30–35 s, with or without forced relay. Timed dev logs showed WebRTC rode out the switch: the ICE restart went through and the connection never left "connected". But `networkChanged()` had marked the call "reconnecting" and started the reconnect timer, which only a fresh "connected" event clears, so it hung up a healthy call. Now a network change only restarts ICE; real "disconnected"/"failed" events drive the state. After the fix one call held through Wi-Fi off and back on (4:42); B's ICE stayed "connected" after each restart. The caller switching passed too (A's Wi-Fi off for 63 s, then on; each restart ended in ICE "completed", the call ran 2:00+). Not yet tried against staging coturn.
    - phone↔web passed: web → vivo and vivo → web (the call rang the Nothing and the web; answered on the web, the Nothing stopped ringing). Direct host/host UDP, media counters rising.
    - open: the app killed (needs Firebase), proximity sensor, Bluetooth headset, a GSM call during a call.
- [x] Confirm group chats have no call actions (a UI test or snapshot). (`callActionsFor` unit test)

## Key files
`apps/mobile/src/calls/*`, `apps/mobile/app/(app)/call/*`, `apps/server/src/modules/push/*` (call wake)

## Out of scope
iOS CallKit (29).

## Done when
- The REQ §19.5 call criteria pass on devices per the matrix: calls work phone↔phone and phone↔web, direct and via TURN; the backend stores no recording or record.
- The incoming call rings on a locked phone.
- `pnpm lint typecheck test` passes.

## Handoff notes
**From Phase 12 (ADR 0015):**
- `PushService.wake(deviceId, urgent)` already skips the throttle when `urgent`, but always sends `{"t":"wake"}`: add the `{"t":"call"}` payload (`PUSH_WAKE` / `PushPayload` in `@pingdost/shared-types`) for call invites.
- The `calls` notification channel (max importance) already exists (`apps/mobile/src/push/notifications.ts`); the headless task treats every data message as a wake today (`push/task.ts`).
**From Phase 13 (ADR 0016):** group screens have no call action; keep it that way (REQ §8.2).
**From Phase 25 (ADR 0028):**
- `@pingdost/call-engine` is platform-neutral: implement `CallPlatform` with react-native-webrtc (`createPeer` opens media and adds tracks, maps `connectionstatechange`; `iceServers` = `callsApi(api).turnCredentials()`). Use `incomingPolicy` for a GSM call (`'busy'`).
- The phone already receives invites: `engine.onCallSignal`; invites to an offline phone trigger `{"t":"call"}` (FCM HIGH, `collapse_key: call`, TTL 60 s), at most one per 15 s. The caller re-sends the invite every 3 s for 45 s, so a woken phone that connects gets it.
- Record history with `engine.recordCall` (the web runtime's `onEnded` shows the mapping).
- Single-phone checks: `pnpm --filter @pingdost/sim-client peer` answers calls with a werift echo (`--relay`, `--answer-after`, `--dial-user <user ID> [--video]` to ring the phone).
- Dev TURN: `docker compose --profile calls up -d --wait` with `PINGDOST_TURN_IP=<PC LAN IP>`, and the TURN URLs in `.env` pointing at that IP.
