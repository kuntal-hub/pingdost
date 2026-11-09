# Phase 33 — Calls D: camera filters and effects

**Goal:** beauty, face (animal and funny) and colour effects in video calls, drawn on the device before the picture is encrypted, on Android and the web.

**Depends on:** 32 (🔄: its open items are device checks). Requested by the user on 2026-11-09 after the feasibility answer in ADR 0037.

**Read first:** ADR 0038, ADR 0037.

## Tasks
- [x] Shared catalog of 21 GLSL effects (`@pingdost/call-engine` `effects.ts`): beauty 2, face 8, colour and fun 11; `effectFragmentShader`, `availableEffects`; tests.
- [x] Android: the `pingdost-effects` react-native-webrtc processor (`CallEffects.kt`: upright pass, effect program, texture pool, `FaceDetector` tracking with smoothing), `setVideoEffect` / `videoEffectsProcessor`; every camera track carries the processor.
- [x] Phone UI: Effects button in video calls, chip row; each call starts without an effect.
- [x] Web: insertable streams + WebGL pipeline (`effects.ts`), the platform's effect output track, Effects panel (Chrome/Edge; no face effects), `checkEffectShaders()` for development.
- [x] ADR 0038, CHANGES, ROADMAP, ARCHITECTURE, CLAUDE.md.

## Done when
- [x] `pnpm --filter @pingdost/call-engine test`, web and mobile tests, lint and typecheck pass.
- [x] All 21 shaders compile in WebGL (`checkEffectShaders()` in Chrome).
- [x] Web: effects visible in a call (self view and the peer's echo), upright, and kept through voice ↔ video.
- [x] `:pingdost-calls:compileDebugKotlin` and the arm64 APK build pass.
- [ ] **Android, on two phones:** every effect in a video call; the face effects follow the face (front and back camera, phone upright); the other phone sees the same; no stutter on the slower phone (frame rate in the call stats); effects off after the call; screen sharing and picture-in-picture still work with an effect on.

## Handoff notes
- Web face effects need a face tracker (TF.js + BlazeFace, Apache-2.0, about 2 MB): later, if wanted.
- Android's `FaceDetector` gives no roll: stickers stay upright when the head tilts.
- iOS: none of this (Phases 29/30).
