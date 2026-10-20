# Phase 26 — Calls B: Android calls & incoming-call UX

**Depends on:** 12, 25 · **Platforms:** Android (+ web interop)

## Goal
Reliable one-to-one audio and video calls on Android, phone↔phone and phone↔web. The phone wakes for incoming calls via push, shows a proper incoming-call UI, handles audio routing and camera, and recovers from network changes.

## Read first
- REQ §12 (all), §19.5 (call bullets)
- ARCHITECTURE A6
- **Load skill `expo:expo-overview`**

## Tasks
- [ ] **`react-native-webrtc`** + its Expo config plugin (check current versions and compatibility). Implement the call-engine platform adapter for RN.
- [ ] **Incoming call:**
  - the server sends a high-priority FCM `{t:"call"}` (no SDP, no caller info) to the callee's devices when an invite targets an offline or backgrounded device;
  - the app wakes → connects WS → receives the E2EE offer → shows the incoming UI.
  - **Evaluate and choose (ADR):** a self-managed `ConnectionService` (e.g. a maintained callkeep-style library) vs a full-screen-intent notification (notifee or a custom module), against Android 14+ full-screen-intent permission rules. Ringing timeout, plus a missed-call local notification.
- [ ] **In-call:**
  - mute; video on/off; front/back camera switch;
  - speaker / earpiece / Bluetooth headset routing (e.g. an in-call manager library or a small native module);
  - proximity sensor screen-off on earpiece;
  - keep-awake; foreground service with a `phoneCall` or `microphone|camera` type as Android requires;
  - permission handling with explanations.
- [ ] **Network transitions:** detect Wi-Fi ↔ mobile switches → ICE restart → show "Reconnecting"; failure after a timeout → "Call failed".
- [ ] **Busy and edge cases:** a second incoming call while in a call → busy; a call while a GSM call is active; the app killed during ringing.
- [ ] **Test matrix** (record it in PROGRESS): phone↔phone on the same Wi-Fi, phone on mobile data ↔ phone on Wi-Fi, TURN-forced, phone↔web, a network switch mid-call, a locked-screen incoming call, the app killed before the incoming call.
- [ ] Confirm group chats have no call actions (a UI test or snapshot).

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
