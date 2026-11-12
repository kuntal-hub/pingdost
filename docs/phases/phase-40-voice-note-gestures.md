# Phase 40 — Voice notes: hold to record, slide to cancel, lock, review

**Goal:** voice notes work as in other messengers. Hold the microphone to record and release to send; slide left to cancel; slide up to lock and record hands-free. After a locked recording, listen to it, then send or delete it.

**Depends on:** 15 (the voice recorder), 36 (the composer layout). User request 2026-11-10 (CHANGES; item 22 of `prompts/UI_modifications.txt`).

**Read first:** ADR 0018 (the voice-note manifest and waveform), ADR 0035 (motion, haptics). Code: `apps/mobile/src/screens/chats/voice-recorder.tsx` (today: tap to start, then Send or Cancel), the composer.

## Tasks
Built 2026-11-12 (ADR 0044): the machine is `apps/mobile/src/attachments/voice-gesture.ts`; the composer side is `screens/chats/voice-recorder.tsx` (`useVoiceNote`, `MicHold`, `VoiceBar`).
- [x] **Hold and slide:** with react-native-gesture-handler and Reanimated (both installed), pressing and holding the mic starts recording (haptic, a timer, the live waveform) and releasing sends. A recording under about 1 s is dropped with a "Hold to record" hint. Sliding left past a threshold cancels: the control follows the finger, then a haptic and a trash animation. Sliding up onto a lock icon locks the recording.
- [x] **Locked and review:** once locked the finger can lift; Stop ends the recording and opens review; Delete discards it. Review has play and pause, the waveform with the position, scrubbing and the duration, then Send or Delete. The microphone is released as soon as recording stops.
- [x] **Interruptions:** leaving the app or an incoming call during a recording stops it. A locked recording goes to review; a held one is dropped.
- [x] **Accessibility:** with a screen reader on, the mic stays tap to start (today's flow), since hold-and-slide gestures are not accessible.
- [x] Motion goes through `useMotion()` and haptics through `haptic()`.

## Done when
- [x] Mobile unit tests (the gesture as a pure state machine: hold, release, short tap, cancel, lock, stop, review, send, delete), lint and typecheck pass.
- [ ] On a phone with the sim peer: hold → release sends; slide to cancel; lock → stop → play → send; lock → delete; a very short tap; the peer receives a playable note with its waveform.
  - **Emulator: all passed** (2026-11-12, ADR 0044 Evidence): every row above, plus delete from review, Home while locked (→ review) and while holding (→ dropped), and TalkBack tap-to-start. The sim peer confirmed each note ("… s voice note with N waveform bars, playable MP4 audio").
  - **Still open on a real phone:** the feel of the hold, slide, lock and haptics (adb swipes cannot judge it), and how long the recorder takes to start (1–2.5 s cold on the emulator; the first hold lost its start).

## Handoff notes
- The web plays voice notes but does not record them; recording on the web would be a later phase.
- The review scrubber uses React Native's responder, not a gesture-handler detector. A v3 detector there blocked the Play and Delete buttons beside it (ADR 0044). Check any new detector placed next to Pressables the same way.
