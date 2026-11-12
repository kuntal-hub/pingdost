# 0044 — Voice notes by hold, slide, lock and review

- **Status:** Accepted
- **Date:** 2026-11-12
- **Phase:** 40
- **Approved by user:** n.a. (item 22 of the UI list, CHANGES 2026-11-10; no wire or server change)

## Context
Item 22 of the user's UI list: voice notes should work as in other messengers. Phase 15 (ADR 0018) recorded by tap: the microphone opened a panel that recorded until Send or Cancel. The new flow: hold the microphone to record, release to send, slide left to cancel, slide up to lock, and listen to a locked recording before sending or deleting it. Motion and haptics must follow the user's settings (ADR 0035). The manifest (duration, up-to-64-sample waveform) and the send path are unchanged.

## Options considered
| Option | Pros | Cons | License | Cost |
|---|---|---|---|---|
| **One `usePanGesture` with `minDistance: 0` on the round button** (react-native-gesture-handler 3.3.0, installed) | Active from the touch, so a still hold is a hold; translation and release in one gesture; runs on the UI thread | The button must keep the same place in the tree from press to release | MIT | — |
| Long-press gesture plus a separate pan | Built-in minimum duration | Two gestures to coordinate; a long press fails when the finger moves | MIT | — |
| Core `Pressable` + `PanResponder` | No gesture library | Runs on the JS thread; janks under load | MIT | — |

## Decision
- **The rules are a pure state machine** (`apps/mobile/src/attachments/voice-gesture.ts`, unit-tested): phases `idle → holding → locked → review`. Each event returns the next state, an effect (`start`, `send`, `discard`, `review`) and a feedback cue (`start`, `lock`, `bin`, `short`). It reads no clock and touches no microphone.
  - Release after at least `MIN_HOLD_MS` (1 s) sends; a shorter hold is dropped with the hint "Hold to record, release to send".
  - `slideOutcome(dx, dy)`: whichever way the finger went further wins. 110 dp left cancels; 90 dp up locks. It is a worklet: the UI thread checks it every frame and tells the machine once, when the answer changes.
  - Interruptions (the app leaves the foreground, the chat loses focus, a call starts or rings): a held recording is dropped, a locked one goes to review. A system-cancelled touch drops a held recording. The 15-minute limit sends a held note and reviews a locked one. Notes under 0.5 s are never sent.
- **The composer** (`voice-recorder.tsx`: `useVoiceNote`, `MicHold`, `VoiceBar`) runs the effects:
  - Microphone work goes through one serial queue, so a release right after a press waits for the start and then stops it. Each recording ("take") tracks its own file, so a quick second press can never delete or send the previous note.
  - The microphone is released (`allowsRecording: false`) as soon as recording stops, before review starts. Leaving the chat or the app also stops it.
  - A first-time permission dialog takes the finger away: that hold records nothing, and the hint asks for a new hold. Interruptions are ignored while the dialog is up, because Android reports the app as in the background meanwhile.
  - Recording during a call is refused with a hint (the call holds the microphone).
- **UI:**
  - The voice bar covers the text field. The field stays mounted underneath, so a keyboard that was up stays up while the finger holds (no layout jump under the finger). The keyboard or emoji panel closes once the recording is locked.
  - While holding: a pulsing dot, the timer, "‹ Slide to cancel" (it follows the finger and fades), and a live waveform. A lock rail sits above the button, and the button grows and follows the finger along one axis.
  - Locked: Delete, the timer and waveform, and Stop (opens review); the round button becomes Send.
  - Review: Delete, Play/Pause, a waveform with a scrub thumb, the position or duration, and Send. The played part is a second copy of the bars, revealed by two opposite `translateX` transforms on the UI thread (a memoized component), so neither playback nor scrubbing re-renders the bars. The scrubber is `adjustable` for screen readers (±2 s).
  - **The scrubber uses React Native's responder props** (`box-only`, `locationX`), not a gesture-handler detector. On the emulator, a v3 `GestureDetector` around the waveform stopped the Play and Delete buttons beside it from getting any touch at all (no `touchStart`). Its handler was also offered touches up to 76 dp outside the waveform. An unflattened wrapper and `minDistance: 2` did not help. The thumb still moves through a shared value. The mic's detector sits in its own `collapsable={false}` view, and the emoji button next to it was checked to still work.
  - The recording row polls the recorder in one 100 ms interval, with one state update per tick. The first version set state in an effect keyed on `useAudioRecorderState`, which overran React's nested-update limit ("Maximum update depth exceeded") on the slow emulator.
  - If a hold ends before the recorder has captured 0.5 s (it can take a moment to start), the note is not sent, and the hint says "Too short to send. Hold a little longer" instead of nothing happening. The permission is checked once when the chat opens (no prompt), so a press goes straight to the recorder.
  - Cancel and delete show a bin that pops in and shakes (Full motion); a fade at Calm; nothing at Off.
  - Haptics through `haptic()`: light when recording starts and when it locks, a warning on a slide-cancel. The buttons have their own haptics.
- **Screen readers:** hold-and-slide is not accessible, so with TalkBack (or VoiceOver) on, the microphone is tap to start. The recording starts hands-free (the locked state), with Delete, Stop (review) and Send buttons.

## Consequences
- No new dependency, no native change, no wire or server change: the current dev build runs it.
- The web still plays voice notes but cannot record them (a later phase, if wanted).
- iOS (Phases 28–30) gets the same flow; it was not checked there.

## Evidence
- `pnpm --filter @pingdost/mobile test`: the machine's 19 cases (hold, release, short tap, cancel, lock, stop, review, send, delete, interrupt, lost touch, failure, limit, screen-reader tap, thresholds).
- Emulator (`Pixel_8_API_35`, dev build + Metro, sim peer, 2026-11-12), driven over adb (`input swipe` holds and slides):
  - First hold: the permission dialog appeared, nothing was sent, and the hint showed.
  - Hold → release: the peer received "audio/mp4, 3.1 s, 15 bars, playable MP4 audio".
  - Slide left: the machine cancelled at −114 dp, showed the bin and deleted the file.
  - Slide up: locked at −90 to −103 dp. Then Stop → review → Play (AudioTrack played it) → a tap on the waveform seeked to 3.0 s → Send: "7.0 s, 51 bars, playable".
  - Delete worked from both locked and review. A 0.3 s tap was dropped with the hint.
  - Home while locked → review (note kept); Home while holding → dropped.
  - TalkBack on: the mic is tap to start (hands-free), and Send and Delete work. TalkBack's own permission dialog counted as an interruption, as designed.
  - `dumpsys audio`: every recording start has a stop, so nothing keeps the microphone.
- The emulator's recorder takes 1–2.5 s to start cold: the first hold after opening the app captured 1.1 s of a 3.5 s hold. A real phone must be measured.
- gesture-handler 3.3.0 source checked on 2026-11-12. Android `PanGestureHandler` activates on the down event when `minDist` is 0. In v3, `onFinalize` has `canceled = FAILED || CANCELLED`. expo-audio 58.0.9: the recorder can be prepared again after `stop()`, since its `reset()` releases the `MediaRecorder`.
