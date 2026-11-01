# 0029 — Android calls: react-native-webrtc, a local calls module, full-screen-intent incoming calls

- **Status:** Accepted (the device matrix is pending; see Evidence)
- **Date:** 2026-11-01
- **Phase:** 26
- **Approved by user:** n.a.

## Context
REQ §12 and §19.5: one-to-one calls phone↔phone and phone↔web, direct and via TURN; the phone wakes for incoming calls, shows a proper incoming-call UI (also on a locked phone), routes audio (speaker, earpiece, Bluetooth), turns the screen off at the ear, survives network changes, answers busy during another call, and keeps no record on the server. ADR 0028 already gives the shared call manager, E2EE signaling and the content-free `{"t":"call"}` push. The app is Expo SDK 58 on React Native 0.88 (new architecture only), with local Kotlin modules for nearby (ADR 0023) and media (ADR 0018).

## Options considered
| Question | Option | Pros | Cons | License |
|---|---|---|---|---|
| WebRTC | **react-native-webrtc 155.0.1 + @config-plugins/react-native-webrtc 15.0.2** | The maintained RN WebRTC (libwebrtc); W3C API, so the shared call manager runs unchanged | A classic native module and view (runs through RN's interop layer); APK size | MIT, MIT |
| Incoming-call UI | Self-managed `ConnectionService` (react-native-callkeep 4.6.1) | System call integration (car, headset buttons, the dialer's call log) | Telecom state machine on top of ours; a phone account to register; history of device-specific bugs; new-architecture support not verified | ISC |
| | notifee full-screen notification | Ready-made | Last published Dec 2024; Android 14+ rules not covered | Apache-2.0 |
| | **Local module `pingdost-calls`: CallStyle notification with a full-screen intent, a `phoneCall` foreground service, AudioManager routing** | Android's own APIs; few lines; matches our other modules; no Telecom coupling | No dialer/car integration; we maintain ~400 lines of Kotlin | ours |
| Audio routing | react-native-incall-manager 4.3.0 | Ready-made | Another native dependency for ~150 lines of AudioManager | ISC |
| | **In `pingdost-calls`** | One module; Android 12+ `setCommunicationDevice` | — | ours |

## Decision
1. **react-native-webrtc 155.0.1** with its config plugin (permission texts in `app.json`; the plugin sets minSdk 24, which the app already has). It vendors its own event-target shim, so no Metro change. `src/calls/platform.ts` implements `CallPlatform` (`getUserMedia` with the front camera at 720p, `iceTransportPolicy: 'relay'` under Force relay, `applyConstraints({ facingMode })` to flip, `_switchCamera` as a fallback).
2. **Local module `modules/pingdost-calls`** (Kotlin, no dependency):
   - `CallNotifications`: channels `incoming_calls` (high importance, the phone's ringtone, vibration) and `ongoing_calls` (low). The incoming notification is `CallStyle.forIncomingCall` (Android 12+; plain actions before), `FLAG_INSISTENT`, a 45 s timeout, and a full-screen intent to `pingdost://call?callId=…&action=show`. Answer opens `…&action=answer`; Decline is a broadcast (no UI).
   - `CallService`: foreground service with type `phoneCall` (Android 14+ requires `MANAGE_OWN_CALLS`, declared; it is a normal permission), plus `microphone` and `camera` when granted; started only from the foreground (the user dialled or answered); "Ongoing call" with Hang up.
   - `CallAudio`: `MODE_IN_COMMUNICATION`, transient audio focus, routes earpiece/speaker/headset/Bluetooth (Android 12+ `setCommunicationDevice`, older the speakerphone/SCO switches), a headset or Bluetooth device wins when it appears, the proximity screen-off wake lock, the in-app ring (looping ringtone and vibration, honouring silent/vibrate), and "a GSM call is going on" from the audio mode (no phone permission).
   - `CallActivityListener`: an activity opened by `pingdost://call` shows over the lock screen and turns the screen on; JS turns that off when the call ends. Also keep-screen-on, full-screen-intent permission state and its settings page.
3. **Runtime** (`src/calls/runtime.ts`), started with the engine: the call manager on the engine's signaling; on screen an incoming call rings in the app and opens `/call`; off screen it is the call notification; GSM call → busy; a live call keeps the gateway socket open in the background (the engine runtime and the push wake check `callInProgress`); Wi-Fi ↔ mobile data (or the network coming back) → `networkChanged` (ICE restart, "Reconnecting"); ended calls → `engine.recordCall`; a missed call → a local notification on `missed_calls` (the name only when previews show senders).
4. **Push:** the background task sends `{"t":"call"}` to `handleCallWake`: connect, wait up to 15 s for the re-sent invite, keep the socket while the call rings or runs. The app killed during ringing therefore rings again as soon as the next invite copy arrives.
5. **UI:** call buttons (voice, video) in direct chats only, from `callActionsFor` (groups: none; unit-tested); `/call` full-screen modal (answer/decline; remote video or picture, self view, mute, camera off, flip, audio route chooser, hang up, "Reconnecting…", errors); a **Calls tab** with the local history, call back, the full-screen permission state (Android 14+) and Force relay.

## Consequences
- Phone↔phone, phone↔web and phone↔sim-peer calls use the same manager and signaling as the web (ADR 0028); the server is unchanged.
- No system call log, car or headset-button integration (a self-managed `ConnectionService` can be added in Phase 27 if wanted). Play Store: `USE_FULL_SCREEN_INTENT` and the `phoneCall` foreground service are allowed for calling apps but must be declared in the Play Console (Phase 27).
- iOS (Phase 29) needs CallKit and its own platform; the module is Android-only.
- A new dev build is needed (native module and WebRTC): `pnpm --filter @pingdost/mobile android`.

## Evidence
- `modules/pingdost-calls` and react-native-webrtc compile against RN 0.88 (Gradle `:pingdost-calls:compileDebugKotlin`, `:react-native-webrtc:compileDebugJavaWithJavac`).
- Unit: `src/calls/logic.test.ts` (call actions: none for groups; push kind; wording; missed-call privacy; proximity rule).
- Pending (devices): the Phase 26 test matrix in PROGRESS.
- Checked 2026-11-01: react-native-webrtc 155.0.1 (MIT, 2026-10-20), @config-plugins/react-native-webrtc 15.0.2 (MIT, peer `expo >=56`), react-native-callkeep 4.6.1 (ISC), @notifee/react-native 9.1.8 (last published 2024-12-20), react-native-incall-manager 4.3.0 (ISC).
