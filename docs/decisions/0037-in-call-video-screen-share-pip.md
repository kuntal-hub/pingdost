# 0037 — In-call changes: voice ↔ video, screen sharing, background and picture-in-picture

- **Status:** Accepted
- **Date:** 2026-11-09
- **Phase:** 32
- **Approved by user:** n.a. (the user asked for the features; the choices below are Claude's, reported to the user)

## Context
After Phases 25–26 a call's kind was fixed when it was dialled, nobody could share a screen, and the web call covered the whole page. The user asked (2026-11-09) for:
1. screen sharing in video calls, done securely, with a choice of one app or the whole screen;
2. front/back camera switching;
3. switching between voice and video without hanging up, both ways;
4. calls that go on in the background, with the screen locked or another app open, without blocking anything else;
5. picture-in-picture for video calls;
6. camera filters (beauty, animal, funny): a feasibility answer first, no build yet.

REQ §12 (calls), ARCHITECTURE A4 (call signaling), A6/A7 (apps), A10 (privacy). Builds on ADR 0028 (signaling, `CallManager`) and ADR 0029 (Android call UX).

## Options considered
**Switching voice ↔ video**

| Option | Pros | Cons |
|---|---|---|
| Renegotiate (add a video m-line mid-call) | Smallest SDP for voice calls | Only the caller makes offers (ADR 0028): the callee would have to ask; glare between renegotiation and ICE restarts; more state |
| **Every call carries a send-and-receive video section from the start; switching is `replaceTrack`** | No renegotiation, no new glare, the same code for screen sharing; an empty sender sends nothing | A voice call's SDP has a video m-line; an older app answers it receive-only (then switching is refused: `canVideo`) |

| Option | Pros | Cons |
|---|---|---|
| Each side just turns its own camera on (Telegram style) | No request protocol | Not what the user described ("switch the call"); a call can be half video |
| **Voice → video is a request the other side accepts or declines; video → voice applies at once on both sides (WhatsApp style)** | Matches the user's words; nobody's camera turns on without their own tap; going to voice only reduces what anyone shows, so it needs no consent | A small request protocol (numbers, timeout, both asking at once) |

**Screen sharing**: Android has one path (MediaProjection: react-native-webrtc's `getDisplayMedia` and its `mediaProjection` foreground service, MIT, already a dependency); browsers have `getDisplayMedia`. Nothing new to add.

**Picture-in-picture**: Android's own PiP (no library) vs. a floating overlay window (`SYSTEM_ALERT_WINDOW`, blocked in app.json since Phase 27). Android PiP chosen. Web: the video element's Picture-in-Picture API (plus Chrome's automatic PiP through Media Session).

## Decision
**Protocol** (`content.proto`, additive): `CallSignal.TYPE_MODE` with `mode_change` (`VIDEO_REQUEST`, `VIDEO_ACCEPT`, `VIDEO_DECLINE`, `VOICE`) and `mode_request_id` (random uint32 picked by the asker, repeated by the answer, so a late answer to a withdrawn request is ignored); `screen_sharing` in `MEDIA_STATE`. Still E2EE ephemeral signaling between the two call devices; the server sees none of it.

**Call engine** (`CallManager`, shared by web, Android and the sim client):
- Every call has one audio and one `sendrecv` video section. The caller adds an empty video transceiver to a voice call; the callee turns the offer's video section `sendrecv` before answering. `CallPeer.canVideo` reports whether video was negotiated both ways; without it, switching and sharing throw `CallError('no_video')`.
- Voice → video: `requestVideo()` opens this camera as a **preview** (`CameraState` `preview`: self view only, nothing sent) and sends the request. The other side sees "X wants to switch to video" and `acceptVideo()` (camera `on`, call becomes video) or `declineVideo()`. The asker withdraws after 30 s (`videoRequestTimeoutMs`) or on Cancel; the asked side also drops it after 30 s. Both asking at once: each accepts the other's request. A request while already video is answered with an accept.
- Video → voice: `switchToVoice()` closes this camera and tells the other side, whose camera closes too.
- Screen sharing: `startScreenShare('app' | 'screen')` → `'sharing' | 'cancelled' | 'unavailable'`. The video sender carries the screen if shared, else the camera if on, else nothing. The system's or browser's own "Stop sharing" ends it (`PeerEvents.onScreenShareEnded`). Switching to voice keeps a shared screen.
- In-call changes apply only once answered (connecting, connected, reconnecting) and only from the call's device.

**Security of screen sharing**:
- Android: Android's consent dialog every time (the OS requires it). "One app" (Android 14+, API 34) leaves the app choice to that dialog; "Entire screen" asks for the whole display only (`createConfigForDefaultDisplay`). Before Android 14 only the whole screen is offered. While this side shares, **PingDost's own window is secure** (`expo-screen-capture` key `call-screen-share`): it shows black in the share, so other chats, the call screen and the picture-in-picture window never travel with it. A red "You are sharing your screen" line stays on the call screen.
- Web: the browser's picker every time; `selfBrowserSurface: 'exclude'` (this PingDost tab is never offered); "One window or app" leaves whole screens out of the picker (`monitorTypeSurfaces: 'exclude'`). Permissions-Policy names `display-capture=(self)`. No screen audio.
- The picture goes over the call's DTLS-SRTP connection like the camera (TURN only relays ciphertext).

**Background and picture-in-picture (Android)**:
- The call already ran in a `phoneCall` foreground service (ADR 0029). It now also holds a partial wake lock and a Wi-Fi lock (6 h safety timeout), and is started again (from the foreground) when the camera comes into use, so its `camera` type is added mid-call.
- During a video call (or while the other side shares a screen), leaving the app shrinks the call into picture-in-picture: auto-enter on Android 12+, `onUserLeaveHint` on Android 8–11 (`modules/pingdost-calls` `CallPip`). The window shows only the other side's picture and has Mute/Unmute and Hang up. The main activity declares `supportsPictureInPicture` (`plugins/with-call-pip.js`). It closes when the call ends.
- Without picture-in-picture (lock screen, PiP turned off for the app, a voice call), the call's sound goes on; **the camera pauses** while nobody can see the app and comes back on return (the other side sees "camera off"). A phone in a pocket does not keep filming.
  - "Seen" is the main activity being started (PiP counts), reported by the calls module's `visibility` event (`CallVisibility`, an `ActivityLifecycleCallbacks`). JS timers stop in the background on Android, and closing the PiP window stops the activity without any app-state change JS hears about, so polling from JS could not do it (found on the two phones, 2026-11-09).
- In the app, leaving the call screen (Minimize, or Back) keeps the call in a draggable mini window over every screen; a tap returns to it.

**Web**: Minimize turns the full-screen call into a draggable window so the app stays usable; a picture-in-picture button pops the other side's video out of the tab, and Chrome may do it by itself when the user switches tabs. "Next camera" cycles cameras when there are two or more.

**Camera filters**: not built. Feasibility below; a later phase if the user decides.

## Consequences
- Voice calls carry a video m-line in their SDP. A call with an app version from before this change answers it receive-only: switching and sharing are refused there with a notice ("the other app needs an update").
- New Android build required (native module, manifest, config plugin). iOS: the Swift side is unchanged; screen sharing and picture-in-picture on iOS are left for Phase 29/30 (ReplayKit broadcast extension, `AVPictureInPictureController` for video calls).
- The sim client always adds a video section and agrees to every switch to video (for device checks with one phone).
- Phase files: new Phase 32. Phases 25/26 are not reworked.

## Evidence
- `pnpm --filter @pingdost/call-engine test`: 13 new scenarios (accept, decline, withdraw, timeout, a late answer to an old request, both asking at once, asking while asked, video → voice and back, no camera, an older app, only once answered and only from the call's device, screen sharing in voice, a cancelled picker and the system's Stop, switching to voice while sharing).
- `apps/server/test/calls-webrtc.int.test.ts`: two werift sim clients through the real server: voice → video → shared screen → voice on one connection (same `connectedAt`), no SDP/ICE text on the socket, no Mongo writes.
- react-native-webrtc 155.0.1 source checked 2026-11-09: `getDisplayMedia({ android: { createConfigForDefaultDisplay } })` (API 34+), `MediaProjectionService` behind `WebRTCModuleOptions.enableMediaProjectionService`, its notification needs an `ic_notification` drawable (added in `modules/pingdost-calls`), disabling a local video track stops the capturer, `videoEffects.ProcessorProvider` exists (for filters).

### Camera filters: feasibility (2026-11-09)
- **Where they run:** on the phone or in the browser, before encoding. Frames never leave the device unencrypted; E2EE is unchanged. No server, no money.
- **Android:** react-native-webrtc 155 has a native hook for this (`ProcessorProvider.addProcessor(name, factory)` + `track._setVideoEffects([name])`, a `VideoFrameProcessor` per frame). Filters would be Kotlin + OpenGL ES shaders in `modules/pingdost-calls`.
- **Web:** `MediaStreamTrackProcessor`/`VideoTrackGenerator` (Chrome) or a canvas → `captureStream` (all browsers) with WebGL shaders.
- **Colour and fun filters** (warm, cool, mono, vintage, posterize, comic, mirror, pixelate): easy, shader only, cheap on battery. About one phase for both apps.
- **Beauty** (skin smoothing, brightening): medium; a bilateral/guided blur shader, better with a face mask. Inside the same phase or the next.
- **Animal and funny face filters** (ears, noses, glasses, big eyes): hard. They need face landmarks every frame: MediaPipe Face Landmarker (Apache-2.0; on-device; Android AAR and web WASM, a model of about 4 MB) plus 2D stickers anchored to the landmarks, and original sticker art. Larger APK (to be measured, likely +10–20 MB unless the model downloads on demand), more heat and battery on mid-range phones, frame-rate risk. One or two phases. Google ML Kit's face mesh is not an option (proprietary terms; the license rule needs OSI or permissive).
- **iOS:** waits for the iOS phases (no Mac here).
