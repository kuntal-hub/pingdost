# 0038 — Camera filters and effects in video calls

- **Status:** Accepted
- **Date:** 2026-11-09
- **Phase:** 33
- **Approved by user:** yes (the user asked for filters after the feasibility answer in ADR 0037: "ok let's add the filters and effects")

## Context
The user asked for camera filters in video calls ("beauty filters, animal filters, funny filters and many more"). ADR 0037 recorded the feasibility. Constraints: privacy first (A10), no money, permissive or OSI licenses, and E2EE must not change (REQ §7, §12).

## Options considered
| Option | Pros | Cons | License | Cost |
|---|---|---|---|---|
| **GLSL shaders on the device, before encoding**: Android through react-native-webrtc's video processor hook, the web through insertable streams + WebGL | One shader source for both apps; GPU, cheap on battery; nothing new to ship | Web only in Chrome/Edge (insertable streams) | none new | 0 |
| CPU filters on bitmaps | Simple | Too slow for beauty at 720p, 30 fps | — | 0 |
| **Face tracking: Android's built-in `android.media.FaceDetector`** | In the SDK: no library, no download, no network, no APK growth | Eye midpoint and distance only (no roll, no landmarks); weaker than modern models | Android SDK | 0 |
| MediaPipe Tasks (Face Detector / Landmarker) | Accurate, web and Android | Its privacy notice says MediaPipe Tasks send performance and usage metrics to Google; MediaPipe ToS; large native libs | Apache-2.0 + ToS | 0 |
| ML Kit face detection | Good on Android | Proprietary terms (not OSI), Google | proprietary | 0 |
| TF.js + BlazeFace (web face filters) | No telemetry, Apache-2.0 | About 1.5–2 MB of JS plus a self-hosted model; more upkeep | Apache-2.0 | 0 |

## Decision
- **Catalog** (`packages/call-engine/src/effects.ts`): 21 effects, each one GLSL ES 1.00 fragment shader over the upright picture (`tc` from the bottom left), with uniforms `uSize`, `uTime`, `uFace` (point between the eyes, eye distance, roll) and `uFaceOn` (fade).
  - Beauty: Beauty (edge-aware smoothing weighted to skin tones, a little lift and warmth), Soft glow.
  - Face: Cat, Dog, Bunny, Shades, Clown, Big eyes, Party hat, Mustache. Drawn as signed-distance shapes in face units (eyes at ±0.5), so there is no image asset to license.
  - Colour and fun: Warm, Cool, B&W, Vintage, Vivid, Comic, Sketch, Pixel, Thermal, Neon, Mirror.
- `effectFragmentShader(effect)` gives the complete source both apps compile: the prelude `precision mediump float; varying vec2 tc; uniform sampler2D tex;`, with every `sample(` turned into `texture2D(tex, `. Tests forbid identifiers that end in `sample`, direct `texture2D`, and face helpers outside face effects.
- **Android** (`modules/pingdost-calls` `CallEffects.kt`): the module registers the react-native-webrtc processor `pingdost-effects`; every camera track carries it (`track._setVideoEffects`). On the camera's GL thread, per frame:
  1. draw the frame upright into a texture (`VideoFrameDrawer`);
  2. draw the effect (`EffectProgram`, on WebRTC's public `GlShader`; its `GlGenericDrawer` is package-private) into a pooled texture (at most 6 in flight);
  3. hand it on as an RGB `TextureBufferImpl` with rotation 0.
  - With no effect chosen, the processor returns the frame unchanged and frees its GL objects.
  - A shader that fails to compile is skipped for the rest of the call.
  - Face tracking: every third frame, a 240-pixel-wide copy is read back and `FaceDetector` runs on one worker thread. The result is smoothed and fades out 0.8 s after the face is lost.
- **Web** (`apps/web/src/features/calls/effects.ts`): `MediaStreamTrackProcessor` → WebGL on an `OffscreenCanvas` → `MediaStreamTrackGenerator`.
  - The generator track replaces the camera on the sender and in the self view once an effect is picked, and follows camera changes.
  - Chrome and Edge only; other browsers show no Effects button.
  - No face effects on the web.
- **UI:** an Effects button in video calls (phone: a row of chips above the controls; web: a panel). Each call starts with none. Nothing is stored or signalled: the other side just sees the picture.
- **Privacy:** frames are processed on the device before encryption; no model, library or network call is added. Face positions stay in memory on the phone.

## Consequences
- A new Android build is required (calls module).
- Web face filters are left for later (TF.js + BlazeFace would be the candidate). Better Android tracking (roll, landmarks) would need a model runtime: recheck licenses and telemetry first.
- iOS: none of this yet (no Mac; Phases 29/30).
- `CallsModule` now compiles against react-native-webrtc (`compileOnly project(':react-native-webrtc')`), so the screen-sharing option is set directly, without reflection, and the app.json ProGuard rule for it is gone.

## Evidence
- `pnpm --filter @pingdost/call-engine test`: catalog rules (unique IDs, sampling only through `sample(`, face helpers only in face effects, no GLSL ES 3 constructs).
- Chrome, 2026-11-09: `checkEffectShaders()` compiled and linked all 21 shaders in WebGL (face ones included) with no error. In a video call with the sim peer and Test media, Vintage, Pixel, Neon and Comic showed in the self view and in the peer's echo (so in the encoded stream), upright. The effect survived voice → video → voice → video. No console errors.
- `:pingdost-calls:compileDebugKotlin` and the arm64 APK build pass; the APK's dex contains `CallEffects` and `android/media/FaceDetector`.
- MediaPipe telemetry: the MediaPipe Tasks privacy notice and terms (checked 2026-11-09) state that performance and usage metrics are sent to Google.
