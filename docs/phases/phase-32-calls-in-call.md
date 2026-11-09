# Phase 32 — Calls C: voice ↔ video, screen sharing, background, picture-in-picture

**Goal:** a call can change while it goes on: voice ↔ video both ways, screen sharing (one app or the whole screen, done safely), front/back camera; it goes on in the background with the screen locked or another app open, as picture-in-picture for video; and the apps stay usable during a call. Camera filters: feasibility only.

**Depends on:** 25, 26 (both 🔄: their open items are device and staging checks, not code this phase changes). Requested by the user on 2026-11-09 (CHANGES).

**Read first:** ADR 0037, ADR 0028, ADR 0029, ARCHITECTURE A4 (call signaling), A6, A7.

## Tasks
- [x] Protocol: `CallSignal.TYPE_MODE` (`mode_change`, `mode_request_id`) and `screen_sharing`; codec and round-trip tests.
- [x] Call engine: every call has a `sendrecv` video section; `requestVideo` / `acceptVideo` / `declineVideo` / `cancelVideoRequest` / `switchToVoice`; `startScreenShare` / `stopScreenShare`; `CameraState` (`off` / `preview` / `on`); `canVideo`; the request timeout; scenarios over the fakes.
- [x] Sim client: video section in every call, agrees to every switch to video; integration test voice → video → screen → voice through the real server.
- [x] Web: platform session (one video sender: screen > camera > none), the share chooser (window/app or entire screen; never this tab), voice ↔ video, request banners, "Next camera", minimized draggable call window, picture-in-picture button and Chrome's automatic PiP, `display-capture=(self)`.
- [x] Android JS: the same platform model on react-native-webrtc; voice ↔ video (speaker ↔ earpiece, the foreground service adds `camera`); screen sharing through Android's dialog (one app from Android 14) with PingDost's window secure meanwhile; the back camera's self view not mirrored; the camera pauses while nobody sees the app; the mini window over every screen; the picture-in-picture view.
- [x] Android native (`modules/pingdost-calls`): `CallPip` (params, auto-enter on 12+, `onUserLeaveHint` on 8–11, Mute/Unmute and Hang up buttons, exit when the call ends), the screen-sharing service switched on, `ic_notification`, `FOREGROUND_SERVICE_MEDIA_PROJECTION`, wake and Wi-Fi locks in `CallService`; `plugins/with-call-pip.js`.
- [x] ADR 0037 (with the filters feasibility), CHANGES, ROADMAP, ARCHITECTURE, CLAUDE.md.
- [ ] Camera filters: only if the user decides (proposal in ADR 0037: colour/fun and beauty first, face filters after).

## Done when
- [x] `pnpm --filter @pingdost/protocol test`, `pnpm --filter @pingdost/call-engine test`, `pnpm --filter @pingdost/web test`, `pnpm --filter @pingdost/mobile test` pass; lint, typecheck and Prettier pass for the touched packages.
- [x] `test/calls-webrtc.int.test.ts` passes (the switch scenario included).
- [x] `:pingdost-calls:compileDebugKotlin` passes after a prebuild; the arm64 debug APK builds (`:app:assembleDebug`) and installs on both phones with their data kept. The manifest has `supportsPictureInPicture="true"`. Metro bundles `(app)/call` and `(app)/_layout`.
- [ ] **Web in Chrome:** voice → video request and accept, decline, video → voice, share a window and the entire screen (Test media off), stop from Chrome's own bar, minimize, picture-in-picture.
  - 2026-11-09 with Test media on, against the sim peer (`pd_nothing` in Chrome): voice call (direct) → Switch to video (peer agreed) → Share → "Your entire screen" (test screen replaced the camera, red bar, Stop brought the camera back) → Switch to voice → Minimize (chat usable, window lit up when the peer sent `!video`) → expand → Switch (accepted) → picture-in-picture (the remote `<video>` went into PiP) → hang up ("Call ended 2:12", peer: completed). No console errors. **Open:** the real browser picker with Test media off, Chrome's own "Stop sharing", Decline in the browser.
- [ ] **Android (a new build is required):** on a phone with the sim peer (`pnpm --filter @pingdost/sim-client peer`) or phone ↔ phone:
  - voice → video and back (speaker ↔ earpiece), the other side asking, declining;
  - flip camera (self view mirrored only for the front camera);
  - share one app and the entire screen (Android 14+ dialog), stop from the status bar; PingDost black in the share;
  - Home during a video call → picture-in-picture, Mute and Hang up from the window, expand back; the call ends in PiP → the window closes;
  - lock the screen in a video call: the sound goes on, the other side sees "camera off", the camera comes back after unlock;
  - another app open for several minutes during a voice call (and with the screen off) on both phone models: the call holds.
  - 2026-11-09 night: not done. Both phones were behind a secure lock screen and Claude does not unlock phones.
  - **2026-11-09 morning, Nothing A001T (`pd_nothing`) ↔ vivo V2437 (test account `pd_vivo_t1`), Android 16, same Wi-Fi, direct:**
    - passed:
      - voice → video both ways (the vivo asking and the Nothing asking), the request banner and "Asking … Cancel", audio moving to the speaker;
      - video → voice on both (speaker → earpiece, cameras released);
      - flip both ways with an effect on;
      - screen sharing "Entire screen" (Android's dialog → Continue): the Nothing showed the vivo's screen, PingDost's own window black in the share and in screenshots, "sharing their screen" label, our Stop share;
      - Home during a video call → picture-in-picture on both phones (auto-enter); Mute and Unmute from the PiP window reached the other side; expand back;
      - no PiP after the call ended;
      - a voice call kept for 60 s with the Nothing in Settings;
      - the mini window: shows, drags and snaps to an edge, a tap reopens the call;
      - the other phone killed mid-call → "Call failed" after about 35 s;
      - video call made directly, and calls in both directions.
    - **Fixed during the test:**
      - the self view covered the request banner and the effects row (now above the measured bottom panel);
      - closing the PiP window did not pause the camera (JS timers stop in the background): a native `visibility` event (`CallVisibility`, activity started/stopped) now drives it; checked: camera released, the other side sees the avatar, back on return;
      - the speaker switch used a stale stored route and once stayed on the earpiece (now read fresh from Android; checked again);
      - the mini window had no rounded corners (fixed; not looked at again).
    - Not checked: "One app" sharing, Android's own Stop sharing, Decline on a phone, the lock screen (PIN), ending a call inside PiP, more than a few minutes in the background, the screen off.
    - Seen once: the first Answer tap after the app's first start did nothing (missed call); not reproduced after a fresh start.

## Handoff notes
- iOS: screen sharing needs a ReplayKit broadcast extension and PiP needs `AVPictureInPictureController` with a sample-buffer layer: Phase 29/30 work, not done.
- Screen audio (sound of the shared app) is not sent.
- A request to switch to video that arrives while the app is in the background without PiP shows only when the app comes back (the asker gives up after 30 s). A notification for it could follow.
