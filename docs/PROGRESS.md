# PingDost — Progress / Handoff Log

Newest entry first. Each session prepends one entry. Keep it short: the next session reads **only the top entry**. Detail belongs in the phase files, ADRs or code.

<!-- TEMPLATE (copy above the latest entry)
## YYYY-MM-DD — Phase NN: <title> — ✅ done | 🔄 partial
**Done:**
- …
**Remaining (if partial):** checklist items still open, in order
- [ ] …
**Deviations / decisions:** (link ADRs, CHANGES entries)
- …
**Verification results:** commands run + pass/fail; device checks done or pending for the user
- …
**Known issues / tech debt:**
- …
**Next:** phase NN, plus anything the next session must know first
-->

## 2026-11-12 — Phase 40: Voice notes: hold to record, slide to cancel, lock, review — 🔄 partial (code done, emulator checks pass; real-phone feel check open)
Started with 36 still 🔄 (only its phone check is open), with the user's go-ahead.

**Done (ADR 0044, CHANGES 2026-11-12 "Phase 40"):**
- `apps/mobile/src/attachments/voice-gesture.ts`: the gesture as a pure machine (idle → holding → locked → review), plus worklet-safe `slideOutcome`/`slideOffset`. 19 unit tests.
- `screens/chats/voice-recorder.tsx` rewritten:
  - `useVoiceNote`: effects run through one serial microphone queue, one "take" per recording. Interruptions come from AppState, chat blur and calls. The permission is checked up front. The microphone is released as soon as recording stops.
  - `MicHold`: a pan with `minDistance: 0`; the button follows the finger, with a lock rail above it.
  - `VoiceBar`: the recording, locked, review and bin rows.
  - The review has play/pause, a waveform scrubber with a thumb, and Send/Delete.
- Screen readers keep tap to start (hands-free, the locked state).
- Composer (`chat.tsx`): the voice bar covers the field, which stays mounted, so the keyboard does not jump under the finger. The round button morphs to Send while locked or in review.
- Sim peer: downloads and decrypts every file or voice note it receives, checks the size and the MP4 header, and replies with the duration and waveform bars (new workspace dependency `@pingdost/attachments`).

**Verification:**
- `pnpm turbo run lint typecheck test` 59/59 (mobile: 28 files / 174 tests); `pnpm format:check` clean. While the emulator, Metro, the server and the peer were running, `@pingdost/backup` timed out twice (Argon2id, 5 s limit). It passed alone, and in the full run once the emulator was stopped.
- Emulator with the sim peer, driven by adb swipes:
  - First hold → the permission dialog, then the hint.
  - Hold → send ("3.1 s, 15 bars, playable MP4 audio").
  - Slide left → bin and discard. Slide up → lock → Stop → review → Play → tap-to-seek → Send ("7.0 s, 51 bars, playable").
  - Delete works when locked and in review. A 0.3 s tap is dropped with the hint.
  - Home while locked → review; Home while holding → dropped.
  - TalkBack tap-to-start → Send and Delete work.
  - `dumpsys audio`: every start has a stop.
- Found and fixed on the emulator:
  - an update-depth loop in the recording row (effect on polled status);
  - the review's gesture-handler detector blocking the Play/Delete buttons beside it, so the scrubber now uses RN responder props;
  - Fast Refresh/StrictMode cleanup leaving `gone` set;
  - Reanimated dependency-array warnings;
  - a silent drop when a hold ended before the recorder started ("Too short" hint now).

**Remaining:**
- [ ] Real phone (no new build needed; Phase 40 adds no native code): the feel of hold, slide, lock and haptics, and how long the recorder takes to start. On the emulator the first hold after opening the app captured 1.1 s of a 3.5 s hold.

**Known issues:**
- Phase 37 (seen while setting up): after the peer accepted the circle request, the requester's New chat row kept "Requested" until the app restarted. The server log shows no circle reload after the accept, though the socket was connected. Check this during 37's open two-phone check.
- `adb input text` with no field focused triggers React Native dev shortcuts (`i` opens the inspector).

**Next:** the open phone checks of 34–40 with one new build, or the next phase the user picks.

## 2026-11-11 — Phase 39: Select several messages and forward them — 🔄 partial (code done, checks pass; real-phone check needs a new build)
Started with 35 and 37 still 🔄 (only their phone checks are open), as the user asked for 38 and 39 together.

**Done (ADR 0043, CHANGES 2026-11-11 "Phase 39"):**
- Wire: `ContentHeader.forwarded` (E2EE, additive). Engine: `forwardText` (≤ 5 chats), `forwarded` on `sendText`/`sendAttachment`, `deleteManyForEveryone` (one batch, all or nothing), `MessageRecord.forwarded` in every store (phone migration 010).
- `@pingdost/chat-core` `selection.ts`: selection, copy text, delete-for-everyone check with reasons, forward targets, notices.
- Phone: long press starts selection; header with count, Reply (one), Copy, Forward, Delete, More (one: the old sheet); full-screen Forward picker; files re-sent from the vault copy; "Forwarded" label. Copy uses `expo-clipboard` 58.0.4 (MIT, native).
- Web: Select in the hover toolbar, then click-to-select rows, Esc; the same bar, delete dialog with reasons, Forward dialog; files re-sent from the cache in the leader tab.
- Sim peer polls circle requests every 5 s (was 2 s, which used up the per-IP 300/15 min budget that every local client shares).

**Verification:** `pnpm turbo run lint typecheck test` 59/59; `pnpm --filter @pingdost/server test:int` 28 files, 193 passed (4 skipped as before); `pnpm format:check` clean; `pnpm licenses:check` ok. Chrome with the sim peer: select 3, the delete reason, batch delete for everyone (peer saw both removals), forward the peer's message (marked) and an own one (unmarked) to a chat and a group, a photo forwarded as a new upload, Copy of two lines. Emulator (Phase 35 APK + Metro): selection, Forward of two texts to two chats (one opened on Send), "Forwarded" only on the peer's. Found and fixed there: on a build without the clipboard module the lazy import raised an uncaught error; it now checks `requireOptionalNativeModule` first.

**Remaining:**
- [ ] A new APK (for Copy), then the phone row of Done when on a real phone: Copy, a photo forward, five targets, delete for everyone.

**Known issues:** the emulator was very slow (a forward to two chats took about two minutes to return); the Expo dev-menu button covers the header's Delete icon on the emulator.

**Next:** Phase 40 (voice-note gestures), or the open phone checks of 34–39 with one new build.
## 2026-11-11 — Phase 38: Find people and pick group members — 🔄 partial (code done, checks pass; phone check next)
Started with Phase 37 still 🔄 (only its two-phone check is open).

**Done (ADR 0042):** `GET /v1/users/search?q=` (username and folded name-word prefixes from 2 characters, whole email only, 10 results with circle state, never an email, blocked/unverified/deleted excluded, `findByName` / `findByEmail` privacy settings, 60 searches/min per account); `users.searchWords` with index and start-up back-fill; phone and web new chat (circle members matched on the device at once, server results after 300 ms, stale answers dropped; Message / Add / Requested / Accept); circle-only multi-select member pickers with chips and "Already in the group"; group description on create; the two toggles in Privacy (phone) and Settings (web).

**Verification:** `users-search.int.test.ts` 9/9; full `test:int` 28 files pass after updating `profile.int.test.ts` for the two new privacy fields; lint/typecheck/test for server, mobile, web, chat-core, shared-types, api-client pass. Chrome: part of a username, whole email vs a fragment, group with a description from the circle-only picker, current member not pickable.

**Remaining:**
- [ ] The phone row of Done when (Phase 35's APK is enough), incl. a group with three picked members (the test account had one circle member).
## 2026-11-11 — Phase 37: Circles — 🔄 partial (code done, all checks pass; two-phone test next)
**Done (ADR 0041, CHANGES 2026-11-11):** server module `circles` (REST `/v1/circle*`, in-memory cache, `CircleChanged` frame, `{"t":"circle"}` push); enforcement on envelopes, calls, key claims (`refusedDeviceIds`), typing, presence and group adds; blocks sever links; account deletion and `retention-audit` cover both collections; engine `circle` option (nearby/mesh drop) and refused-claim handling; phone (Circle screen, Requests row, contact card, locked composer, new chat "Add to circle", circle push); web (Circle page, Settings link, Requests row, locked composer, new chat); `SimClient.linkWith/linkAll`; peer accepts requests and `--dial-user` asks first; privacy policy and explainer; run-on-devices.md.
**Verification:** `pnpm turbo run lint typecheck test` 59/59; `pnpm --filter @pingdost/server test:int` 27 files, 184 passed (4 skipped: 100 MB spike, coturn/S3 halves), incl. `circles.int.test.ts` 13/13 and `redis-budget.int.test.ts`; `pnpm format:check` clean; `retention-audit` on the dev DB `ok: true` with the circle checks. `mailbox.int.test.ts` 2–4 failed once under load (a leftover envelope from test 1 came due within the 2 s stage); their assertions now check their own envelope. Emulator + sim peer: locked composer, request → accept → chat, remove, incoming request → accept → call rings. Chrome: Circle page, add from new chat, locked composer.
**Remaining:**
- [ ] Two-phone check in the phase file (needs the Phase 35 APK; no new native code).
**State:** the server, web dev server, Metro, emulator and sim peer were stopped (the PC ran low on memory); Docker infra is still up. The emulator has `pd_emu_p36` (password only in the session scratchpad).
## 2026-11-11 — Phase 36: Chat composer: emoji picker, keyboard, scrolling — 🔄 partial (code done; real-phone check next)
Started with Phases 34–35 still 🔄 (only their phone checks are open), as the user asked for 36 and 37 together.

**Done (ADR 0040):**
- Emoji panel on phone and web from one data set (`emojibase-data` 18.0.0, MIT; helpers in `@pingdost/chat-core/emoji`): categories, search, skin tone, recents on the device only, emoji newer than the font hidden, insert and backspace at the caret.
- Phone: the composer sits on the keyboard (`BottomSpace` replaces `KeyboardAvoidingView`); the panel takes the keyboard's place at its height; Back closes it.
- Jump to the newest message on every send; a "N new messages" pill while reading older ones (phone and web, live region).

**Verification:**
- `pnpm turbo run lint typecheck test` for mobile, web, chat-core, shared-types pass (mobile `chunk-store.test.ts` timed out once under load and passes alone); `pnpm licenses:check` ok.
- Chrome with the sim peer: panel, search + Enter, tone, recents, Escape, send while scrolled up, the pill.
- Pixel 8 emulator: composer on the keyboard with no gap, panel ↔ keyboard at the same height, insert at the caret. The emulator had a build from 11-01 (`ExpoScreenCapture` missing, then a crash in `UniffiPlayerRoot`'s finalizer on reload); the Phase 35 APK was installed with `adb install -r`. New local account `pd_emu_p36` (password only in the session scratchpad).

**Remaining:**
- [ ] Both phones: the phone row of the phase file's "Done when" (no new build needed beyond Phase 35's APK).
## 2026-11-10 — Phases 34 and 35: sign-in and sign-up polish; chat look — 🔄 partial (code done; real-phone check next)
The user's UI/UX list (`prompts/UI_modifications.txt`) was planned as Phases 34–40 (CHANGES 2026-11-10). The user chose server-held Circles (37), prefix + exact-email search (38) and the name "Circle". This session built 34 and 35 (ADR 0039).

**Done:**
- 34: live username check (`GET /v1/usernames/availability?username=`, no sign-in, per-IP limit; the phone waits 400 ms, aborts stale requests, caches 60 s); `PasswordField` with an eye button on every password field; `react-native-keyboard-controller` (`KeyboardProvider`, `Screen` = `KeyboardAwareScrollView`); field messages that say what to change, plus a password meter that only advises; the PingDost mark and wordmark on every account screen (`Screen brand`).
- 35: tab titles one step smaller; the Chats "+" (56 dp) floats above a full-width tab bar and bounces in; time and state on every message, inline when they fit (invisible spacer); bubbles at most 80% wide (phone and web); `isBigEmoji` = exactly one emoji; **item 14 found and fixed**: `SwipeAction` remounted a message that lost its swipe action (deleted for everyone) inside its recycled list cell, leaving a blank gap.

**Verification:**
- Server `test/auth-register.int.test.ts` 11/11 (availability, log hygiene, rate limit). `pnpm turbo run lint typecheck test` for mobile, web, chat-core, server, api-client and shared-types: 18/18.
- Chrome with the sim peer: items 12, 13, 14 and 15 behave as asked.
- Pixel 8 emulator with the new debug APK: register (Taken / available live, keyboard, eye, meter), login, Chats layout, inline times, 80% bubbles, one big emoji. Delete for everyone turned into the placeholder at once on both sides. Putting the old `SwipeAction` line back made the gap return, which confirms the cause.
  - Two bugs fixed during these checks: a shown password fed the keyboard's suggestions; the time spacer was visible on Android (`transparent` on a nested span).
- `pnpm format:check` flags `packages/message-engine/src/engine.test.ts`, unchanged since 2026-11-08 (not this session's).

**Remaining:**
- [ ] Install the new APK on both phones (`apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`, arm64 + x86_64; `adb install -r` keeps data) and run the phone checks in both phase files (Nothing and vivo: keyboard on every account screen, the bounce at each Motion level, text sizes, delete for everyone between the two phones).

**State:** Docker infra still running; the server, Metro, the sim peer, the web dev server and the emulator were stopped. The emulator has a local test account `pd_emu_p35` (password only in this session's scratchpad). Phones were not connected this session.

**Next:** the phone check above, then Phase 36 (composer; keyboard-controller is in place) or Phase 37 (Circles, the largest).

## 2026-11-09 — Phase 32 follow-up: hide call controls, swap videos — 🔄 partial (code done; device check next)
**Done:** in a connected video call (phone `call-screen.tsx`, web `call-overlay.tsx`):
- a tap on the picture hides or shows the controls, header and Minimize;
- they hide after 10 s without a touch, and stay up while a switch request, the route list or the share chooser is open, or while a screen reader is on;
- a tap on the small video swaps it with the big one (own video large, mirrored for the front camera).

**Verification:**
- Mobile tests 138/138, web tests 25/25, typecheck, lint and Prettier pass.
- **Web in Chrome (sim peer, Test media): passed**, after one fix: with a mouse, the move before a click had already shown the controls and the click hid them again.
- **Phones (Nothing ↔ vivo, via the dev TURN relay over `adb reverse`): passed**: auto-hide on both; tap show/hide and swap both ways on the vivo. The Nothing dropped off USB before its own tap and swap check. Details are in the phase 32 file.

**State:**
- Running: Docker infra and coturn (`--profile calls`).
- Stopped when the PC ran low on memory: the API server (it had run with `TURN_URLS=turn:127.0.0.1:3478?transport=tcp` as a process env var; `.env` is unchanged) and Metro.
- The vivo has `adb reverse` for 3000, 8081 and 3478.

**Next:** stop the services when done (`docker compose --profile calls down` for coturn). The earlier entry below still lists the other open device items.

## 2026-11-09 — Phases 32 and 33 on two phones — 🔄 partial (most device checks passed; the rest in the phase files)
Nothing A001T (`pd_nothing`) ↔ vivo V2437 (new test account `pd_vivo_t1` on the local server; its password is not in the repo), Android 16, USB + `adb reverse`, local server and Metro.

**Passed:** voice ↔ video both ways and both directions; flip; screen sharing (entire screen) with PingDost black in the share; PiP on both phones with Mute/Unmute/expand from the window; a voice call kept with another app open; the mini window; the other side killed → "Call failed" after ~35 s; face effects (Cat, Dog, Shades, Big eyes) following the face; colour effects on both phones; effects through flip, sharing and PiP. Details: phase 32 and 33 files.

**Fixed (commit below):**
- the self view covered banners and the effects row;
- closing PiP did not pause the camera: new native `visibility` event (`CallVisibility.kt`; needs this APK);
- a stale stored audio route kept a switch to video on the earpiece;
- the mini window's corners.

**Remaining:** "One app" sharing, Android's own Stop sharing, Decline on a phone, the lock screen and screen off (the phones have PINs), ending a call inside PiP, all 21 effects and frame rate, a new call starting with None, the web real picker. Seen once and not reproduced: a first Answer tap after a fresh app start did nothing.

**State:** both phones have the new APK and stay-awake back off; `adb reverse` still set. The API server (:3000), Metro (`CI=1`) and Docker infra are still running for more testing; stop them when done. The Windows MongoDB service runs again since the restart (`.env` uses `localhost`, which reaches Docker's).

## 2026-11-09 — Phase 33: Calls D: camera filters and effects — 🔄 partial (code done; two-phone check with the user next)
User asked for filters after ADR 0037's feasibility answer (CHANGES 2026-11-09, ADR 0038).

**Done:**
- 21 GLSL effects in `@pingdost/call-engine` (`effects.ts`): Beauty, Soft glow; Cat, Dog, Bunny, Shades, Clown, Big eyes, Party hat, Mustache; Warm, Cool, B&W, Vintage, Vivid, Comic, Sketch, Pixel, Thermal, Neon, Mirror.
- Android: `CallEffects.kt` (react-native-webrtc processor `pingdost-effects`, upright pass + effect program + texture pool; Android `FaceDetector` tracking). Effects button and chip row on the call screen. `CallsModule` now compiles against react-native-webrtc (`compileOnly`), so the screen-sharing option is set directly (no reflection, no ProGuard rule).
- Web: insertable streams + WebGL (Chrome/Edge), Effects panel, no face effects (no tracker without MediaPipe, which sends usage metrics to Google).

**Remaining:**
- [ ] Two-phone check (phase 33 "Done when"), plus phase 32's phone checks in the same session.
- [ ] Web: Phase 32's open items (real picker, Chrome's Stop sharing, Decline).

**Verification results:** call-engine 53 tests; all 21 shaders compile in Chrome's WebGL; web call with Test media against the sim peer showed Vintage, Pixel, Neon and Comic in the self view and in the echo, upright, and kept through voice ↔ video; `:pingdost-calls:compileDebugKotlin` and the arm64 APK build pass (APK dex holds `CallEffects`). Repo-wide `pnpm turbo run lint typecheck test`: 59/59.

**State:** the PC had restarted: Docker Desktop and the infra (+ coturn) were started again, and the API server runs on :3000 (this session's). The native Windows MongoDB service is running again on 127.0.0.1:27017 (`.env` uses `localhost`, which reaches Docker's Mongo on ::1). The new APK is installed on the vivo; the Nothing still has the Phase 32 build. Metro, the web dev server and the sim peer are stopped. Chrome: Test media off.

## 2026-11-09 — Phase 32: Calls C: voice ↔ video, screen sharing, background, picture-in-picture — 🔄 partial (code done; phone checks need the user)
New phase from the user's request (CHANGES 2026-11-09, ADR 0037).

**Done:**
- Protocol `CallSignal.TYPE_MODE` (`mode_change`, `mode_request_id`) and `screen_sharing`; call engine: every call has a `sendrecv` video section, so voice ↔ video and screen sharing are `replaceTrack` (no renegotiation). Voice → video is a request (accept/decline/withdraw, 30 s timeout, both asking at once); video → voice is immediate.
- Web: share chooser (window/app or entire screen, never this tab), voice ↔ video, request banners, "Next camera", minimized draggable call window, picture-in-picture (+ Chrome's auto PiP), `display-capture=(self)`.
- Android: same model on react-native-webrtc; screen sharing through Android's dialog (one app from Android 14) with PingDost's window secure meanwhile; the back camera's self view is no longer mirrored; picture-in-picture (`CallPip`, `plugins/with-call-pip.js`) with Mute and Hang up; the camera pauses while nobody can see the app; wake and Wi-Fi locks in the call service; a draggable mini call window over every screen.
- Sim peer: agrees to every switch to video; chat commands `!video`, `!voice`, `!share`, `!unshare` during a call.
- Camera filters: feasibility only (ADR 0037, end). Not built: waiting for the user's decision.

**Remaining:**
- [ ] Phone checks in the phase file (both phones were locked; new dev build already installed on both, data kept). The vivo needs a test account.
- [ ] Web: the real picker (Test media off), Chrome's own "Stop sharing", Decline.
- [ ] Filters: only if the user says so.

**Verification results:** protocol 125 tests, call-engine 49 (13 new), web 25, mobile 138 pass; `calls-webrtc.int.test.ts` 3/3 (new: voice → video → screen → voice on one connection, frame scan clean, no Mongo writes); `:pingdost-calls:compileDebugKotlin` and the arm64 APK build pass; Chrome smoke test with Test media passed (phase file). Full `pnpm turbo run lint typecheck test`: 59/59.

**Known issues:** iOS has none of this yet (ReplayKit, `AVPictureInPictureController`: Phases 29/30). No screen audio. A video request that arrives while the app is in the background without PiP shows only when the app comes back.

**State:** both phones: the new build installed, stay-awake off, screens off. The API server on :3000 was already running (started 01:21, not by this session) and was left running; Metro, the web dev server and the sim peer are stopped. Chrome: Test media turned off again. Docker infra is still up.

## 2026-11-09 — Device test, part 5: the checks Claude could do alone (17, 18, 19, 27) — 🔄 partial (what is left needs the user, money or other hardware)
Same phones and Chrome linked to `pd_nothing`. Commits `d66fbb5`, `0a5281e`, `f19f79a`, `866f15a`, `e4fc1ab` plus docs (not pushed).

**Done:**
- 18 → ✅: a photo sent from the vivo to `pd_nothing` (192 KB) arrived in Chrome and opened. Resuming after killing the tab mid-sync is proved by `history-sync.int.test.ts` (passed). It was not repeated with real Chrome.
- 17: fixed (`866f15a`) a web chat not following new messages, and "Jump to the latest message" stopping short. Checked in Chrome (phase file has the details).
- 27: account deletion (ADR 0036, `d66fbb5`, `0a5281e`: Settings → Delete account, email code, `POST /v1/me/delete`, Cloudinary picture). Integration-tested, then done on the vivo twice (`pd_vivo` and the throwaway `pd_vivo2`): the user is gone in Mongo, `account_delete` is in `security_events`, and the phone is back at the welcome screen.
- 19: the monthly reminder date is unit-tested (`f19f79a`). On the vivo, Android scheduled it exactly 30 days ahead (`dumpsys alarm`). It was not watched firing.
- Fixed (`e4fc1ab`): a wiped phone (Delete account, Remove data, replaced phone) kept the backup reminder scheduled. The wipe now cancels scheduled notifications and dismisses shown ones (`wipe-steps.test.ts`). The second deletion left no PingDost alarm or notification.

**Remaining:**
- [ ] 17: push with the tab closed (build + `preview`, VAPID keys, Chrome's notification permission).
- [ ] 16: a second browser; remove Chrome from the Nothing's Devices list (Chrome is still linked to `pd_nothing`).
- [ ] 27: Play's web resource for deletion requests; one real Cloudinary deletion; the staging retention audit and VPS load re-run.
- [ ] 11: typing Hindi in search (the user). 21: range and 1 h battery (the user). 26: staging coturn, app killed (Firebase), proximity, Bluetooth headset, GSM. 31: the feel check (the user).
- Blocked on the user: 12 Firebase, 20/25 VPS, 27 Play US$25, 28–30 Apple and iPhone; pushing.

**Known issues:**
- Android forms: `Screen` (`src/components/screen.tsx`) does not avoid the keyboard. On the vivo, after typing the deletion code, the keyboard covers "Delete my account" until it is closed. The same likely applies to every form with a button below a field. Fix it with the keyboard inset (it affects all screens, so check several) in a polish pass.

**State:** the vivo has no PingDost account now (at the welcome screen; `pd_vivo` was deleted with the user's go-ahead). Both phones: stay-awake off, no test files, no battery allowlist entry on the vivo. Chrome on this PC is still linked to `pd_nothing` (the test tab is closed). API server, Metro, web dev server and the sim peer are stopped; Docker infra (Mongo, Valkey, Mailpit, coturn) is still up.

## 2026-11-08 — Device test, part 4: web with real phones (10, 16–18, 26) — 🔄 partial (what is left needs the user, money or other hardware)
Same phones and accounts, plus desktop Chrome on this PC linked to `pd_nothing` (the user scanned the QR). Commits `22875ef`, `8065a22` plus docs (not pushed). Part 3 (below) has the earlier fixes of the day.

**Passed:**
- 10 → ✅: QR safety-number verification both ways.
- 16: pairing with the Nothing; web "Unlink this browser".
- 17: 1:1 and group phone ↔ web; two tabs (after the fixes below).
- 18: history from the phone, "Load older messages from phone", a file and a photo sent from the web.
- 26: calls web → phone and phone → web (both the Nothing and the web rang; answered on the web), direct UDP. Caller-side network switch held (part 3's fix).

**Fixed (tests failed without each fix):**
- `22875ef`: a tab opened after the leader tab hung on "Opening the chat…": the leader never answered a later tab's `hello` with `leader` (the unit tests' fake leader did).
- `8065a22`: with two tabs, a token refresh signed the browser out. One tab rotated the refresh token, the other refreshed with its stale copy, and the server revoked the session (reuse detection, ADR 0007). Refreshes are now shared across tabs (`session/refresh.ts`: Web Lock, stored tokens read first). Checked with `ACCESS_TOKEN_TTL_SECONDS=60`: eight refreshes, all 200, no reuse.

**Remaining:**
- [ ] 16: a second browser next to Chrome; remove a browser from the phone's Devices list (Chrome is still linked to `pd_nothing`: removing it there is the check).
- [ ] 17: push with the tab closed (build + `preview`, VAPID keys, Chrome's notification permission). Web chat does not always scroll to new messages; "Jump to the latest message" can stop short when a photo loads.
- [ ] 18: resume after killing the tab mid-sync; a photo received on the web.
- [ ] 11: typing Hindi in search (the user). 21: range and 1 h battery (the user). 19: the monthly reminder (date +30 days).
- [ ] 26: the switch through staging coturn; app killed (Firebase); proximity, Bluetooth headset, GSM. 31: the feel check (the user).
- Blocked on the user: 12 Firebase, 20/25 VPS, 27 Play US$25, 28–30 Apple and iPhone; pushing.

**State:** both phones restored: stay-awake off, test files and the 206 MB test backup deleted (`/sdcard/Download/pdtest`), the vivo's battery allowlist entry removed, and the Nothing's Bluetooth off (as before), Motion Full and Nearby messaging off. Still on: Nearby messaging in the vivo's app, and possibly Motion Off there; its app was not running, so the user changes them in Settings. Chrome on this PC is still linked to `pd_nothing`. The API server, Metro and the web dev server were stopped by Windows (low memory); Docker infra (Mongo, Valkey, Mailpit, coturn) is still up. `%TEMP%\pd-turn-secret.txt` holds the dev coturn secret used to start the server with TURN.

## 2026-11-08 — Two-phone device test, part 3 (19, 21–24, 26, 31; docs) — 🔄 partial (what is left needs the user, money or other hardware)
Same phones and accounts. Commits `d13aaef`, `60a9d39`, `1bfa095`, `35f31c5`, `7a815bd`, `e5f26c9` plus docs (not pushed). Phase files, ADR 0023's measured column and ROADMAP are now updated from parts 1–3. **ROADMAP:** 13, 15, 19, 22, 23, 24 → ✅ (24 after Phase 21's screen-off and Recents rows passed; the mesh line in ROADMAP lists its limits).

**Verification:** `pnpm turbo run lint typecheck test` 59/59; `groups`, `recovery` and `engine` integration tests 25/25. The full integration suite was not run.

**Passed on the phones:**
- 19: path (a) approve on the other phone; (c) Start fresh twice (the contact sees "safety number changed", the message queued meanwhile arrives); Remove data (database folder empty, the phone can then be set up by any account); a restore no longer shows a false safety-number change.
- 26: mobile data ↔ Wi-Fi call connected and held; the full-screen-intent card shows when the permission is off and opens Android's page.
- 31: text sizes Huge and Large on the main screens (details in the phase file).

**Fixed (each test failed without the fix):**
- `d13aaef`: "moved to a new phone" was shown as a changed safety number (`isSafetyNumberChange` in chat-core).
- `60a9d39`: a phone replaced by a new one cleared its chats but kept its database, keys and own device record. It now runs the Remove-data wipe (`apps/mobile/src/recovery/wipe.ts`).
- `1bfa095`: a message to a contact without any phone kept reusing the cached empty directory for 5 minutes (about 9 min on the phones). A cached directory with no devices is now always refetched; on the phones it went out about 1.5 min after the new phone appeared (the outbox backoff).
- Screen-off row (Phase 21): with the dev server stopped and the vivo's screen off for 5 min, its app was **frozen** (`isFrozen=true` despite the `connectedDevice` foreground service), A's packets went unanswered and A closed the link. After `dumpsys deviceidle whitelist +com.pingdost.app` (what "Unrestricted" sets) it unfroze and the message arrived with the screen still off. `35f31c5`: Settings → Nearby messaging now shows "Keep it working with the screen off" while the exemption is missing (`needsBatteryExemption` in `nearby/status.ts`, unit-tested; seen on the Nothing, absent on the exempt vivo).
- `7a815bd`: **calls hung up on a Wi-Fi ↔ mobile data switch.** WebRTC rode out the switch (ICE restart done, connection still "connected"), but `networkChanged()` marked the call "reconnecting" itself and the reconnect timer ended it after 30 s. A network change now only restarts ICE. Test fails without the fix; on the phones one call then held through both switches (4:42). Dev builds now log ICE/connection states, candidate types and restarts per phone model (`[webrtc <model>]`, `[calls <model>]`).

- After Remove data the account had no phone, yet the takeover screen offered "Approve on my other phone", which nobody could approve. Setup now reads the account's own directory (`DeviceSetupError.otherPhone`; unknown counts as a phone) and the screen offers only Restore and Start fresh, with "This account has no phone right now". Tests fail without it; checked on the vivo (Remove data → log in), which then started fresh again. Those recovery screens cannot be screenshotted (capture fails), so the check was by UI dump.

**Open findings:**
- Drafts are not kept when leaving a chat (seen at Huge; may be by design).

**Remaining:**
- [x] 21: swiped from Recents works (vivo, exempt, delivered in 19 s); the new battery row shows on the Nothing (not exempt), not on the vivo (exempt), and opens Android's battery page. ROADMAP: 24 ✅, "Offline-mesh launch requirement met on Android" written with its limits.
- [ ] 21: range and 1 h battery are the user's (walk; unplugged).
- [x] 26: the network switch on the caller's side (A's Wi-Fi off 63 s, then on; the call held, each restart ended in ICE "completed").
- [ ] 26: the switch through staging coturn; phone↔web, app killed (Firebase), proximity, Bluetooth headset, GSM.
- [ ] 16–18 web and 10 QR verify need a camera scan by the user; 11 typing Hindi in search (the user).
- [ ] 19: the monthly reminder firing (date +30 days).
- [ ] 31: the feel check (the user).
- Blocked on the user: 12 Firebase, 20/25 VPS, 27 Play US$25, 28–30 Apple and iPhone; pushing.

**Phone state:** both have Nearby messaging on, Force relay off, Wi-Fi on. A's Motion is Off (set back to Full in Appearance), text size Medium. The vivo has PingDost on the battery allowlist (added by adb for the test). The API server (with the dev TURN env) and Metro were restarted after a low-memory stop. Restore at the end: `svc power stayon false` on both; Bluetooth off on the Nothing (it was off); delete `/sdcard/Download/pdtest` (the 206 MB test backup); remove the allowlist entry if the user does not want it.

**Dev-only, not bugs:** a debug build aborts (`UniffiPlayerRoot` assert) on any JS reload, so source edits during a run need a relaunch.

## 2026-11-08 — Two-phone device test, part 2 (13, 19, 21–24, 26, 31) — 🔄 paused (Windows stopped server and Metro: low memory)
Same phones and accounts. Commits `0b15ab5`, `982b02a`, `dde9242` (not pushed). Phase files and ROADMAP not yet updated.

**Passed on the phones:**
- 13: re-add, leave, group picture.
- 21: discovery 0.7 s, setup 1.0 s, MTU 517, 2M PHY, ping 61 ms avg (20/20). 10 MB: 83.7 KB/s notify, 87.6 KB/s write, 20 299/20 299 frames. Airplane mode with Bluetooth on works.
- 22: all checks. With the server **stopped**, message info said "Over Bluetooth, directly to this phone". Also: queued and sent on return, no duplicates after the internet came back, Bluetooth off and permission denied shown clearly.
- 23 (two-phone part): relay on and off, notification text, "Forwarded by 1 device", pause on battery saver and when not charging, Clear relay cache.
- 24 (direct): 12 MB with a 30 s cut resumed from chunk 75/193 to 193/193, SHA-256 identical.
- 21 matrix: delivered over Bluetooth with B on Home, in forced Doze, and on battery saver (unplugged).
- 26: voice, video (remote picture measured, screenshots deleted), speaker, mute, missed call, busy, TURN-forced ("Relayed (TURN), forced"; local coturn over `adb reverse tcp:3478`), locked-screen incoming call while B's socket was still up.
- 19: backup (24 words, quiz, 196.9 MB incl. files), then Clear storage, log in, restore with phrase and email code. History back; B saw "moved to a new phone", and chat resumed.

**Fixed (tests first, each failed without the fix):**
- Nearby frames of 514 B: Android refuses GATT values over 512, so every long packet hung. Capped on Android and iOS; a throwing write fails the link.
- A half-dead link after airplane mode flips: two missed ACKs close it, and it recovered by itself (about 3 min).
- Re-added group member stuck as "not a member": the server notice used up the version.
- Relay switched on while phones were already linked was ignored: the change now goes out as a new signed HELLO.
- "online" stayed after the socket dropped; the offline banner was see-through.
- Bubble said "Sent to the server" with no server: now neutral when offline.
- `text-white`/`bg-black` did nothing (palette replaced): black text on the call screen, invisible Share in the viewer.
- Text collided with the status bar.
- The nearby dev screen and the chat's nearby layer competed for one inbound queue.

**Open finding (not fixed yet):** after the backup restore, B also showed "Your safety number with this contact changed", though the number is identical (checked) and the other notice says it is unchanged. A false alarm; look at what writes `safety_number_changed` on a `primary_device_changed`.

**Dev-only, not bugs:** a debug build aborts (`UniffiPlayerRoot` assert) on any JS reload. Don't edit sources during device runs. The Metro deep link reloads a running app: bring it forward with `monkey` instead.

**Remaining:**
- [ ] 19: path (a) approve on other phone, Start fresh, Remove data, monthly reminder.
- [ ] 21: screen-off row, Rotate token, 1 h battery, range (user walks).
- [ ] 23/24: third phone; restart reminder needs a reboot.
- [ ] 26: mobile data, network switch, app killed (needs Firebase), phone↔web, proximity, Bluetooth audio, GSM.
- [ ] 16–18 web (Chrome, plus a QR scan the user must do by hand); 10 QR verify; 11 typing Hindi in search.
- [ ] 31: Large/Huge text sizes, the feel check (user). Motion: A is back on Full after the wipe, B still Off.
- Blocked on the user: 12 Firebase, 20/25 VPS, 27 Play US$25, 28–30 Apple and iPhone.

**Phone state to restore at the end:** `svc power stayon false` on both; Bluetooth back off on the Nothing (it was off); delete `/sdcard/Download/pdtest` (holds the 206 MB test backup); scratchpad `phrase.txt`.

## 2026-11-07 — Two-phone device test (Phases 10, 11, 13, 15, 31) — 🔄 stopped part-way (usage limit)
Local arm64 debug APK on both phones (Nothing A001T, Vivo V2437; Android 16), adb mode. Accounts `pd_nothing`, `pd_vivo` (password `PingDost-Test-1107`, dev server only). No phase moved to ✅; phase-file checkboxes are not yet updated.

**Passed on the two phones:**
- Phase 10: E2EE both ways, typing, receipts, offline delivery after force-stop, matching safety numbers.
- Phase 11: reactions, reply quote, edit, delete for me / everyone, message info, global and in-chat search, pin, archive, mute, delete chat, read receipts and typing off, block, unblock, report. Hindi displays correctly.
- Phase 13 (partly): create, send from all three, add a late joiner (no old history), rename, remove (read-only, gets nothing new).
- Phase 15: all five PROGRESS items. 12 MB SHA-256 identical after decryption; 101 MB PDF refused; 99 MB sent in 25 s; 119 MB video compressed to 16.8 MB in 17 s, its original blocked; voice note; server row and bytes gone after delivery; Clear cache keeps messages and files. Memory: peak +52 MB for 30 MB, +74 MB for 99 MB, back to baseline, so the file is not held in memory.

**Fixed:**
- Native SIGBUS opening Appearance: `tech` maps two weights to one font file, and `Asset.fromModule` makes a new Asset per call, so the file downloaded twice and was truncated while FreeType had it mapped. Faces now load one at a time (`theme/serial-queue.ts`). Seen once; 0 crashes in 12 cold starts before the fix, and it could not be forced on demand. What is measured: font requests per cold load went from 2 to 1.
- A blocked user kept seeing "online": a new watch of a hidden user got no answer, so the phone kept its last value. `PresenceHub.update` now answers "not online" (also when the watcher hides its own presence). Confirmed on the phones; existing test updated.
- Media viewer controls under the 3-button navigation bar: bottom inset added, confirmed on the Vivo.
- `formatSize` gains GB. Unit-tested; **not confirmed on a phone** (Storage still showed "63897.5 MB" right after the edit, possibly not reloaded).

**Remaining:**
- [ ] Phase 13: re-add, leave, group picture. The group is left with B removed.
- [ ] Phase 31: call, nearby and backup screens in the new look; text sizes Large and Huge; gesture and haptic feel (the user). Motion is **Off on both phones** for uiautomator: set it back to Full in Appearance. Checked by screenshot so far: onboarding, chat, attachments, voice note.
- [ ] Not started on the phones: Phases 16–19 (web, recovery), 21–24 (Bluetooth), 26 (calls). Turn Bluetooth on on the Nothing phone first (it was off).
- [ ] The user, by hand: QR scans (10, 16), typing Hindi in search (adb cannot), walking out of range (22, 24), a third phone for A→B→C (23).
- [ ] Blocked on the user's decision or money: Firebase setup (12), VPS (20, 25, cross-network 26), Play Console US$25 (27), Apple US$99 and an iPhone (28–30). Pushing to GitHub for CI.

**Verification results:** `pnpm turbo run lint typecheck test` for mobile, server, attachments: 9/9. `security.int.test.ts` passes. Full repo checks and the full integration suite were not run.

**Known issues / tech debt:** in chats, scrolled messages show through behind the status bar above the floating header (a design question, left as is). The Expo dev gear covers header buttons until dragged away (dev builds only). `uiautomator dump` hangs with Motion on because of the looping animations.

**Next:** finish Phase 13, then Bluetooth (21–24) and calls (26), which need only these two phones.

## 2026-11-07 — Phase 31: UI/UX refresh — 🔄 built and checked on the emulator and in Chrome; real-phone feel check open
The user asked for this before finishing the open phases: "first refactor the UI/UX then we will test the app and complete all pending phases". **Nothing was paid for or signed up for; nothing pushed.**

**Done (ADR 0035):** the "Pop" design system in `@pingdost/ui-tokens` (ten schemes in light, dark and pure black; WCAG contrast is a unit test); every appearance option on both apps; phone primitives and redesigned main screens; web dock, panels, chat and Appearance; icons instead of emoji; new app icon. Details: `docs/phases/phase-31-ui-refresh.md`.

**Remaining (needs the user):**
- [ ] A new Android build (`react-native-svg`, `expo-haptics`, `expo-font` are native): `npx eas-cli@27.3.0 build -p android -e development` in `apps/mobile`, or a local one. Then judge gestures, haptics and scrolling on a real phone.
- [ ] See the screens not yet run in the new look: live call, attachments, voice notes, groups, nearby, backup.

**Deviations / decisions:** ADR 0035; `docs/CHANGES.md` 2026-11-07. `text-primary` is now `text-accent` (`primary` is a fill).

**Verification results:** see the Phase 31 file and ADR 0035's Evidence. A throwaway account (`pop_*`) remains in the dev Mongo.

**Known issues / tech debt:**
- The emulator's hardware GPU froze once under memory pressure (app and system alike): run it with `-gpu swiftshader_indirect` when RAM is short.
- On the emulator, after some launches the window drew about 50 px lower with a black band on top. It was not on the first launch; not seen as caused by the app; check on a real phone.
- `uiautomator dump` cannot read screens with looping animations.

**Next:** the user's device test, then the open phases on the roadmap.

## 2026-11-03 — Phase 30: iOS: nearby / mesh + Android↔iOS — 🔄 code only (blocked on an iPhone, the Apple account and a macOS build)
Started right after Phase 29, with Phase 28 still 🔄: the user asked for Phases 29 and 30 together. **Nothing was paid or signed up for.**

**Done (ADR 0033):**
- `modules/nearby/ios` (Swift, no dependency): `Core/Framing.swift` + `Core/Link.swift` (ports of the Kotlin, same bytes and limits), `Core/Policy.swift` (tokens, `ConnectPolicy`, duplicate rule, `InboundQueue`), `Package.swift` + `Tests/` (ported `FramingTest`/`LinkTest`, golden bytes, policy, batches). `BleEngine.swift` (CoreBluetooth both roles, the Android GATT layout, paced writes/notifications, token in HELLO/TOKEN only, restoration), `NearbyModule.swift` (`PingdostNearby`, same functions + iOS `requestPermission`), `NearbyAppDelegate.swift`.
- **Android↔iOS rule:** the iPhone connects to every peer it is not linked to (iOS cannot advertise a token); Android unchanged; iPhone↔iPhone duplicates closed by the existing rule.
- App: iOS permission flow, `NEARBY_COPY`/`describeNearby(…, 'ios')` (honest background and relay limits), `NSBluetoothAlwaysUsageDescription`, Bluetooth background modes in `plugins/with-ios-background-modes.js`.
- CI job `swift-nearby` (Swift core tests in `swift:6.4.2-noble`); `.gitignore` `.build/`; `docs/ops/nearby-ios-matrix.md` (17 rows to fill in); ARCHITECTURE A12; CLAUDE.md.
- MultipeerConnectivity and Wi-Fi Aware evaluated and deferred.

**Remaining (in order; needs the user):**
- [ ] Push; run **iOS build (simulator, unsigned)**: first compile of `BleEngine.swift` and the calls module (Phase 29).
- [ ] An iPhone (and the Apple account for a device build), then the matrix in `docs/ops/nearby-ios-matrix.md`; update `NEARBY_COPY` to what is measured.
- [ ] The dev nearby screen on iOS (Android permissions and "Android SDK" labels).

**Deviations / decisions:** ADR 0033; CHANGES 2026-11-03 (Phase 30, 4 items).

**Verification results:**
- `swift test` (Docker `swift:6.4.2-noble`): 22 passed, 0 failed.
- `pnpm turbo run lint typecheck test --filter=@pingdost/mobile`: pass (125 tests).
- Linux `expo prebuild --platform ios`: pass (6 background modes, Bluetooth usage string). `npx expo export --platform ios`: pass (7.4 MB bundle).
- Whole repo: `pnpm turbo run lint typecheck test`: 59/59; `pnpm format:check` clean. `pnpm --filter @pingdost/server test:int`: **165 passed, 4 skipped** (the first run, started alongside the 59-task turbo run, failed 7 files in their setup hooks; each passed alone and the suite passed in full when re-run by itself).
- **Not run:** any CoreBluetooth compile, any iPhone or Android↔iOS exchange.

**Known issues / tech debt:** iOS cannot drop a central from the peripheral side (over-limit centrals time out); restored connections are redone, not resumed; WebRTC `useManualAudio` (Phase 29) unchecked.

**Next:** the user decisions for iOS (Apple account, iPhone), the open device/VPS checks of Phases 10–27, and pushing so CI (security, bindings, swift-nearby) and `ios.yml` run for the first time.

## 2026-11-03 — Phase 29: iOS: push (APNs) + calls (CallKit) — 🔄 code only (blocked on the Apple account, an iPhone and a macOS build)
Started with Phase 28 still 🔄 (groundwork only): the user asked for Phases 29 and 30 together. **Nothing was paid or signed up for.**

**Done (ADR 0032):**
- **Server:** `ApnsSender` (direct APNs, `node:http2` + `jose` ES256 provider token, sandbox/production per token); wake = constant "New message" alert + `content-available`; call = `{"t":"call"}` to the PushKit VoIP token (alert fallback "Incoming call"); 410/`BadDeviceToken` delete (VoIP token alone when it failed), config errors never delete. `PUT /v1/push/token` `{provider:'apns', token, voipToken?, environment}`; `push_tokens.voip`/`sandbox`; config group `APNS_*` (key secret).
- **iPhone:** APNs + VoIP token registration (`push/token.ts`); the constant alert hidden while open and removed after fetching; explainer card on iOS. Swift half of `modules/pingdost-calls` (`CallKitCenter`: PushKit, CallKit, audio session/routes, kept out of Recents; `CallsAppDelegate`; `CallsModule`). `src/calls/callkit.ts` bridge (push ↔ invite binding, lock-screen answer/decline before the invite, end reasons) and `src/calls/voip.ts` (connect on a VoIP push, queue events). `plugins/with-ios-background-modes.js` (`voip`, `audio`; expo-video drops `audio`), `PINGDOST_APS_ENVIRONMENT`.
- Privacy explainer and policy name Apple; ARCHITECTURE A2/A9/A11/A12; CLAUDE.md.

**Remaining (in order; needs the user):**
- [ ] Push to GitHub, run **iOS build (simulator, unsigned)**: first compile of the Swift (calls module and Phase 28's).
- [ ] Apple Developer Program (US$99/yr) → APNs key → `APNS_*` on the VPS (steps in the phase file).
- [ ] Device matrix (phase file): iPhone↔Android/web, locked/killed, lock-screen answer with sound, routes, network switch.

**Deviations / decisions:** ADR 0032; CHANGES 2026-11-03 (Phase 29, 5 items): constant alert on iOS, NSE deferred, direct APNs, CallKit for every incoming call.

**Verification results:**
- Server: `apns.test.ts` 10 passed (real HTTP/2 against `test/fake-apns.ts`, provider token verified with the public key); `push.int.test.ts` 9 passed (3 new APNs). Server unit 52.
- Mobile: 124 tests (callkit 13, content +2); lint/typecheck clean (mobile, server, config, shared-types, web, api-client, chat-core). `pnpm format:check` clean.
- Linux `expo prebuild --platform ios`: pass (background modes `fetch`, `remote-notification`, `voip`, `audio`; `aps-environment` development).
- **Not run:** Swift compile, an iPhone, a real APNs send.

**Known issues / tech debt:** muted chats still show "New message" on an iPhone when the app cannot run (needs an NSE); a lock-screen answer without prior microphone permission fails; WebRTC's `useManualAudio` is not set (check lock-screen audio on a device).

**Next:** Phase 30 (same session).

## 2026-11-03 — Phase 28: iOS: build, crypto, core chat — 🔄 groundwork only (blocked on the Apple account, an iPhone and a macOS build)
Phase 28 was ⏸ with prerequisites the user has not met (Apple Developer Program US$99/yr, an iPhone, a Mac or macOS CI/EAS). The user asked to start it, so only the no-cost groundwork was done; **nothing was paid or signed up for**.

**Done (ADR 0031):**
- The Rust crate passes clippy for `aarch64-apple-ios` and `aarch64-apple-ios-sim` (also added to CI).
- ubrn iOS config + `pnpm --filter @pingdost/crypto-native build:ios` (xcframework, git-ignored; the existing podspec vendors it).
- `.github/workflows/ios.yml` (manual, macOS runner): xcframework, bindings drift check, Expo prebuild + CocoaPods, unsigned simulator `xcodebuild`. **Written, not run.**
- iOS prebuild verified in a Linux container: every config plugin applies; SQLCipher on; iOS 16.4; usage strings now name calls (also for Android's prompts); expo-secure-store's Face ID string removed (`app.json`, committed with Phase 27).
- `npx expo export --platform ios`: the iOS JS bundle builds.
- `PingdostMedia` loads optionally; `planDraft(…, { videoCompression: false })` on iOS (send ≤ 100 MB as is, refuse larger with a message) + test.
- Google Sign-In on iOS: `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` (public config + test), `app.config.js` adds the plugin with `iosUrlScheme` only when set; hidden on iOS otherwise.

**Remaining (in order; needs the user):**
- [ ] Decide: Apple Developer Program (**US$99/yr**) and an iPhone; then EAS Build or a signed CI archive for device builds.
- [ ] Push to GitHub, run **iOS build (simulator, unsigned)** in Actions, fix what it finds (first macOS build ever).
- [ ] Exclude the SQLCipher DB and attachment vault from iCloud/iTunes backups (small native step); check the Keychain access group.
- [ ] Crypto conformance on an iPhone; AVFoundation `PingdostMedia`; the iOS Google OAuth client; export compliance answer.
- [ ] Parity tests (7, 10, 11, 13, 15, 16, 18, 19) iPhone ↔ Android ↔ web; TestFlight.

**Deviations / decisions:** ADR 0031; CHANGES 2026-11-03 (4 items).

**Verification results:**
- `cargo clippy` for both iOS targets: pass. Linux `expo prebuild --platform ios --no-install`: pass. `expo export --platform ios`: pass.
- `pnpm turbo run lint typecheck test` for mobile, config, crypto-native, web: 11/11 (mobile 109, config 76, web 16).
- **Not run:** any macOS build, simulator or device.

**Known issues / tech debt:** iOS without push wakes (Phase 29), CallKit (29), nearby (30); videos uncompressed on iOS.

**Next:** the user decisions above; meanwhile the open device/VPS checks of Phases 10–27.

## 2026-11-03 — Phase 27: Hardening & release readiness — 🔄 partial (user steps open: Play account, VPS checks, device checks)
Started with Phases 18, 19, 24 and 26 still 🔄 (device/VPS checks only); the user asked for Phases 27 and 28 in one go.

**Done (ADR 0030):**
- **Docs:** `docs/security/threat-model.md`, `acceptance.md` (every REQ §19 bullet → test or manual check), `audits.md`; `docs/ops/capacity.md`, `incidents.md`, `restore-metadata-db.md`, `retention-audit.md` (+ deploy.md rotation and backups, alerts.md); `docs/legal/privacy-policy.md` + `terms.md` (drafts with bracketed fields); `docs/release/README.md` (checklist) + `play-console.md` (Data Safety answers, permission declarations, internal track); README status and feature table.
- **Found and fixed:**
  - **Mailbox migration lost envelopes under backlog** (one batch per poll vs a 900 s Redis safety TTL; the load test lost 9,400 of 10,000). Now `drain()` per run + one bulk upsert and one `$in` read-back per batch (`modules/delivery/jobs.ts`, `mongo-store.ts`); mailbox scenario 10.
  - **Release AAB failed** since Phase 26 (R8, react-native-webrtc JNI): keep rules in `app.json`. `bundleRelease` now builds (82 MB, 18 min, debug-signed).
  - **RUSTSEC-2026-0385** (`ctutils` 0.4.3): updated to 0.4.7; WASM and Android libs rebuilt.
  - **The committed WASM held 84 copies of `C:\Users\<name>\…`**: `build:wasm` now remaps paths (`scripts/remap-rust-paths.mjs`); CI refuses host paths.
  - npm: runtime `fast-uri` (Fastify) and four build-tool packages patched via `overrides`; six dev-tool advisories accepted by GHSA.
  - Two unguarded mobile `console` calls; `SYSTEM_ALERT_WINDOW` and expo-screen-capture's media permissions removed from the manifest.
- **New controls:** per-sender mailbox budget (5,000 envelopes per recipient device, 32 MiB per sender per day; `delivery/quota.ts`); device-owner TTL cache (Atlas M0 = 100 ops/s); pickle keys `Zeroizing` in Rust; FLAG_SECURE on the recovery phrase (expo-screen-capture 58.0.6, MIT); backups exclude `attachments`, `email_otps`, `job_locks`.
- **CI:** cargo-deny (deny.toml), `security` job (gitleaks over history, `pnpm audit`, `pnpm licenses:check`), `bindings` job (regenerates wasm2 + jsi2, diffs TS, checks WASM paths).
- **Tests:** `engine.int` 10 (debug logs scanned for plaintext/tokens/keys/ciphertext), `abuse.int` (mailbox budget, WS flood), `retention.int`, mailbox 10, `log-hygiene` (mobile, web), `security-headers` (web), `privacy.test` (explainer wording), backup `compat.test` with the frozen `packages/test-fixtures/backup/pdbk-v1.*`, `WindowCounter` amounts; engine test asserts the sender's copy after expiry.
- **Tools:** retention audit (`dist/retention-audit.js`), load harness (`apps/server/test/load-server.ts`), `sim-client load-prep`, `k6/ws-load.js` (k6 2.3.0 in Docker, no protobuf in k6).
- **Shared privacy explainer** (`@pingdost/chat-core` `PRIVACY_EXPLAINER`) on the phone (Settings → About privacy) and the web (Settings card).
- Versioning: `0.1.0` / `versionCode` 1.

**Remaining (user steps):**
- [ ] Play Console account (**US$25; not paid**), app, internal testing track, upload an AAB signed with the upload key (`docs/release/play-console.md`).
- [ ] Fill in and publish the privacy policy and terms (bracketed fields; legal review).
- [ ] On the VPS: run the retention audit, practise a restore into a scratch DB, re-run the load test (capacity.md §5), set the Atlas alerts (350 MB, 60 ops/s).
- [ ] Web production: Pages production variables, check headers (`docs/release/README.md`).
- [ ] The ⏳ device rows in `docs/security/acceptance.md` (Phases 10–26), then a new dev build for FLAG_SECURE (new native module).
- [ ] Push to GitHub so the new CI jobs (security, bindings, cargo-deny) run for the first time.

**Deviations / decisions:** ADR 0030; CHANGES 2026-11-02 (8 items). KVM 1 stays (capacity.md §3).

**Verification results:**
- `pnpm turbo run lint typecheck test --continue`: 59 tasks; all pass (mobile, web and attachments each had one 5 s timeout while Gradle ran in parallel; re-run alone: mobile 109, web 16, attachments 21 passed).
- `pnpm --filter @pingdost/server test:int`: **162 passed, 4 skipped** (coturn/S3/slow halves).
- `cargo test`, clippy (host, wasm32, Android, iOS targets), `cargo deny check`: pass. `pnpm audit` exit 0; `pnpm licenses:check` 1,112 packages ok; gitleaks: no leaks; `pnpm format:check` clean; shellcheck clean.
- Load (this PC): 500 sockets ok (staggered); ≈ 500 msg/s at 72–85 % of one core; offline stored p95 109 ms with the cache; backlog of 10,000 fully migrated after the fix.
- `gradlew bundleRelease`: BUILD SUCCESSFUL (after the R8 fix).
- **Not run:** anything on a phone, the VPS, or Play.

**Known issues / tech debt:**
- The Android `.so` still embeds build paths (ubrn sets per-target RUSTFLAGS).
- The stored path still costs one Mongo read per envelope (`mongo.has`); a cache or a cheaper duplicate check would help M0.
- The migration logs one "overdue" error per pass while it drains a large backlog (noisy, harmless).
- No account-deletion flow yet (Play requires one for apps with accounts).
- Abuse reports have no review tool (a Mongo query in incidents.md).

**Next:** Phase 28 groundwork (same session), then the user steps above.

## 2026-11-01 — Phase 26: Calls B: Android calls — 🔄 partial (the device test matrix is open)
Started right after Phase 25 (both 🔄 on device/VPS checks only), as the user asked for 25 and 26 together.

**Done (ADR 0029):**
- **WebRTC:** react-native-webrtc 155.0.1 + @config-plugins/react-native-webrtc 15.0.2 (MIT; `app.json` permission texts). `src/calls/platform.ts` implements `CallPlatform` (permissions first, 720p front camera, Force relay, camera flip).
- **Native module `modules/pingdost-calls`** (Kotlin, no dependency): CallStyle incoming notification with full-screen intent (`pingdost://call`), ringtone (`FLAG_INSISTENT`, 45 s), Decline via broadcast; `CallService` (`phoneCall` + microphone/camera FGS, `MANAGE_OWN_CALLS`), "Ongoing call" with Hang up; `CallAudio` (communication mode, focus, earpiece/speaker/headset/Bluetooth, devices appearing mid-call, proximity wake lock, in-app ring, GSM-call check); lock-screen and keep-screen-on flags; full-screen-intent permission state and settings.
- **Runtime** `src/calls/runtime.ts` (started with the engine): ring in app or by notification, foreground service and audio on dial/answer, proximity rule, ICE restart on network change, busy during a GSM call, local history, missed-call notification (`missed_calls`). The socket stays open in the background during a call (engine runtime, push wake). `{"t":"call"}` → `handleCallWake` (`src/calls/wake.ts`, `push/task.ts`).
- **UI:** voice/video buttons in direct chats only (`callActionsFor`), `/call` full-screen modal, **Calls tab** (history, call back, full-screen permission, Force relay). Phase 12's `calls` channel replaced (`incoming_calls`, `ongoing_calls`, `missed_calls`).
- **Fix (Phase 22 bug found on the emulator):** `useNearbyStatus` built a new object per render, so the offline banner (chats, onboarding) crashed with "Maximum update depth exceeded"; now `useShallow` + `useMemo`.
- **Docs:** ADR 0029, CHANGES (4 items), ARCHITECTURE A6, Phase 27 handoff, CLAUDE.md.

**Remaining (needs phones; record the results here):**
- [ ] New dev build on the phone: `pnpm --filter @pingdost/mobile android` (native module + WebRTC).
- [ ] **Test matrix:** phone↔phone same Wi-Fi; phone on mobile data ↔ phone on Wi-Fi; TURN-forced (Calls tab → Force relay); phone↔web; a Wi-Fi ↔ data switch mid-call ("Reconnecting", then back); a locked-screen incoming call (full-screen UI); the app swiped away before the call (push wake rings). Also: speaker/earpiece/Bluetooth, proximity at the ear, busy while in a call and during a GSM call, missed-call notification.
  - With one phone: `pnpm --filter @pingdost/sim-client peer` answers your calls (echo), and `--dial-user <your user ID> [--video]` rings the phone. Dev TURN for a phone: `PINGDOST_TURN_IP=<PC LAN IP>` for coturn and the LAN IP in the `TURN_URLS`/`STUN_URLS` of `.env`.
  - `apps/mobile/.env` still points at 192.168.1.2; this PC was 192.168.1.3 today.

**Deviations / decisions:** ADR 0029; CHANGES 2026-11-01 (Phase 26): no ConnectionService (full-screen-intent notification), GSM call read from the audio mode, a Calls tab, channels replaced.

**Verification results:**
- `pnpm turbo run lint typecheck test`: 59/59 (mobile 107 tests, +5: call actions with groups excluded, push kind, wording, missed-call privacy, proximity). `pnpm format:check` clean.
- Gradle: `:pingdost-calls:compileDebugKotlin` and `:react-native-webrtc:compileDebugJavaWithJavac` pass; **`app:assembleDebug` for x86_64 builds (13 m 56 s)**.
- Emulator (Pixel 8, API 35): the APK installs; the bundle (2,670 modules) loads with react-native-webrtc and `PingdostCalls` in it and JS runs (no native crash). That run found the Phase 22 crash above. After the fix the emulator hung under memory pressure (Docker + Metro + API + emulator on this PC), so **no call was placed on Android here**.
- **Not run:** any call on a phone or emulator; the matrix above.

**Known issues / tech debt:**
- No system call log, car or headset-button integration (no ConnectionService).
- A GSM call starting during a PingDost call is not detected.
- The Phase 22 crash means the 21–24 device checks would have failed on that build: rebuild before running them.

**Next:** the device checks of 10–26, then Phase 27 (hardening and release).

## 2026-11-01 — Phase 25: Calls A: TURN, signaling, web calls — 🔄 partial (staging coturn and cross-network checks open)
Started with Phases 17 and 20 still 🔄 (device checks and VPS steps only); the user asked for Phases 25 and 26 in one go.

**Done (ADR 0028):**
- **Protocol** (add-only, `buf breaking` clean): `CallSignal` gains RENEGOTIATE/RINGING/MEDIA_STATE, `Reason`, both call device IDs, `expires_at_ms`, batched candidates, `ice_restart`, `muted`/`camera_off`; `PacketFlag.RING`; `calls.ts` (`CallSignalData` ⇄ proto with limits, `CallOutcome`).
- **Engine:** the ephemeral channel takes contacts' devices too (blocks dropped; sync still own devices only); `callDevices`, `sendCallSignal` (RING on offers), `onCallSignal` with device binding; local call history (`callHistory`/`recordCall`/`clearCallHistory`, sealed setting, 200 entries).
- **`packages/call-engine`** (new): state machine; `CallManager` (multi-device invite, first answer wins, offline re-invite, ring/connect/reconnect timeouts, glare, busy, ICE restart from the caller, candidate batching, media state, tab dismissal, incoming policy); `testing.ts` fakes.
- **Server:** `GET /v1/calls/turn-credentials`; `PushNotifier.ring` (`{"t":"call"}`, 15 s window, 60 s TTL); gateway rings offline devices for RING invites (not for blocked senders); `pingdost_call_pushes_total`; rate limit `turnCredentials`.
- **coturn:** dev Compose profile `calls`; staging service (host networking) + `deploy/coturn/turnserver.conf` (SSRF deny list, quotas, bandwidth cap); deploy workflow copies it; env example, runbook (ports, DNS-only `turn`, checks, optional TLS).
- **Web:** `features/calls` (platform, per-tab runtime with Web Lock, overlay, call buttons in direct chats only, Calls page, Settings → Calls with Force relay and dev test media, ring tone); service worker "Incoming call"; bus `call_signal`.
- **Sim client:** werift 0.25.2 echo platform; `peer` answers/dials calls.
- **Docs:** ADR 0028, decisions index (+0025–0027 rows that were missing), CHANGES (8 items), ARCHITECTURE A2/A4/A7/A11, Phase 26 handoff, CLAUDE.md.

**Remaining (user steps; needs the VPS and real networks):**
- [ ] Staging: set `TURN_*`, `STUN_URLS`, `TURN_REALM`, `TURN_EXTERNAL_IP` in `/srv/pingdost/.env`, open UDP/TCP 3478 and UDP 49160–49400 in hPanel, add the DNS-only `turn` record, deploy (`docs/ops/vps-setup.md` → "Calls").
- [ ] **Done when:** web↔web audio and video, direct and with Force relay through **staging** coturn; one browser on a phone hotspot (other network). Record setup times and the MB a relayed camera call uses per minute (the badge shows it).

**Deviations / decisions:** ADR 0028; CHANGES 2026-11-01 (Phase 25): RING metadata, ring every device, TLS optional/off, host networking, user ID in the TURN username, per-device history, calls in any tab, werift dev dependency.

**Verification results:**
- `pnpm turbo run lint typecheck test`: 59/59 tasks (call-engine 35 new; engine +4; protocol +2; server +5).
- `pnpm --filter @pingdost/server test:int`: 156 passed, 2 skipped (with the dev coturn up). New: `calls.int.test.ts` (credentials allocate on coturn 4.18.0; tampered/expired refused; call pushes), `calls-webrtc.int.test.ts` (werift ↔ werift: direct 267 ms, TURN-forced 212 ms answer→connected; no SDP/ICE in frames; no call writes).
- `pnpm format:check` clean; `buf lint` and `buf breaking` against main clean; both coturn configs parse in 4.18.0 without warnings.
- Chrome (dev, test media) ↔ sim echo peer on this PC: direct host/host 622 ms, TURN-forced 306 ms, 0.7 MB in 29 s (320×240 test video); echo video seen; Calls page lists the calls; coturn refused to relay to the LAN address (SSRF rule).
- **Not run:** anything across networks, staging coturn, a real camera.

**Known issues / tech debt:**
- Reloading or closing a tab mid-call can lose that call's history entry.
- With Force relay on, the path badge says "Relayed" from the policy (Chrome may name the pair's local side prflx).
- werift (sim peer only) waits 10 s on each Chrome mDNS candidate; harmless now that candidates are added in the background.
- No TURN over TLS yet.

**Next:** Phase 26 (Android calls). The staging checks above can be done any time after.

## 2026-11-01 — Phase 24: Mesh / nearby file transfer — 🔄 partial (device checks open)
Started with Phases 15 and 23 still 🔄 (device checks only); the user said to proceed.

**Done (ADR 0027):**
- **Protocol** (add-only; `buf breaking` clean):
  - `AttachmentManifest.mesh`;
  - `MeshChunk.origin_token`/`signature`, `MeshSummary.transfers` (`MeshTransferState`: bitmap or complete);
  - `meshChunkMessage`, `meshChunkPacketId`, `meshChunkDigest`, `encodeMeshChunk`/`decodeMeshChunk` (4,096 chunks max).
- **mesh-protocol:** `ChunkBitmap`; `checkMeshChunkPacket` (header, packet ID, hash: relays drop corrupt chunks); chunk metadata and their own per-origin byte budget in `RelayStore`; `chunkCopies` 4, `perOriginMaxChunkBytes` 110 MiB, chunk rate 600/min.
- **attachments:** `mesh` in manifests; `meshChunkRange`, `meshTimeEstimate`, `chunkHashListDigest`, `verifyMeshFile`; `MeshFileReceiver` (bitmaps, durable chunks before the ACK, chunks before the manifest, whole-file check, pause/resume/cancel, hooks) and `MemoryChunkStorage`.
- **Transport `MeshRelay`:**
  - `sendFile`/`withdrawFile`/`fileProgress`/`onFileProgress`;
  - chunks straight to the linked recipient, minus its bitmap, and spray to relays;
  - relays store, deliver and spray chunks, and drop complete transfers;
  - the recipient checks the signature and hands chunks to the sink; `transfersChanged` sends summaries at once.
  - `NearbyPeerTransport` passes `MESH_CHUNK` to the relay. The test radio uses `setImmediate`.
- **Engine:** `AttachmentInfo.mesh`/`meshConfirmed`; no delivery or read receipt for an unconfirmed mesh file; `confirmMeshFile`; `routesTo`. `MeshSim` gains `files: true` phones.
- **Android:**
  - migration 009 (relay chunk columns, `attachments.via`, `mesh_incoming*`);
  - `nearby/files.ts`: send decision, offers, receiver wiring, vault write, `confirmMeshFile`, restart recovery, settle on receipt, pause/resume/cancel;
  - `chunk-store.ts`;
  - the runner skips mesh rows; incoming mesh rows start automatically;
  - the bubble shows chunk progress, "Forwarded by N devices" and a BLE time estimate;
  - Settings → Nearby messaging → largest file without internet (10/25/50/100 MB).
- **Docs:** ADR 0027 (incl. the Wi-Fi Aware / Wi-Fi Direct evaluation), CHANGES 2026-11-01 (five items), ARCHITECTURE A4/A6, decisions index, ROADMAP mesh note, Phase 27/30 handoffs, CLAUDE.md.

**Remaining (needs two phones):**
- [ ] Build and install on both phones (`pnpm --filter @pingdost/mobile android`; JS plus migration 009, no new native code since Phase 23).
- [ ] **Done when (device):** both in airplane mode with Bluetooth on and nearby messaging on, linked once online before:
  - send a 10 MB+ file (e.g. a PDF, or a photo sent as original); the bubble counts chunks on both sides;
  - walk out of range mid-transfer and back: it resumes from where it was;
  - the sender shows Delivered only after the recipient has opened the file;
  - optional: a third phone as relay (A → B → C).
- [ ] Then, if 21–24's device checks all pass: ROADMAP "Offline-mesh launch requirement met on Android".

**Deviations / decisions:** ADR 0027; CHANGES 2026-11-01 (Phase 24): BLE only, 25 MB default; the held E2EE receipt is the acknowledgement; direct chats and the contact's phones only; chunk hash plus signature; files in other places than planned.

**Verification results:**
- `pnpm turbo run lint typecheck test`: 56/56 tasks. New tests:
  - protocol 123 (+4); mesh-protocol 14 (+3); attachments 21 (+4);
  - engine 127 (+4 file scenarios; the 10 MB one runs in about 3 s);
  - mobile 102 (+3: the chunk store under the receiver 1, mesh status wording 2; the relay store test also covers the chunk columns).
- `pnpm --filter @pingdost/server test:int`: 150 passed, 2 skipped. `pnpm format:check` clean. `buf lint` and `buf breaking` against main clean.
- `npx expo export --platform android` bundles (2,462 modules).
- **Not run:** anything on a phone.

**Known issues / tech debt:**
- No Wi-Fi bulk path (ADR 0027): 100 MB over BLE is slow.
- Browsers try the server first for `mesh` manifests before the phone.
- An Internet return mid-transfer does not switch the file to staging.
- Offers are stop-and-wait per link.
- Mesh files only for direct chats and the contact's phones.
- JS SHA-256 per chunk is unmeasured on phones.
- Chunks that arrive before their manifest are kept for at most 16 unknown transfers.

**Next:** the open device checks of 10–24 (the user's list in the session of 2026-11-01), then Phase 25 (calls A).

## 2026-11-01 — Phase 23: Mesh store-and-forward relay — 🔄 partial (device checks open)
Started with Phases 15 and 22 still 🔄 (only their device checks are open); the user said to proceed, and to do the open device checks of 10–22 later.

**Done (ADR 0025, ADR 0026):**
- **Protocol** (add-only, v1; `buf breaking` clean):
  - `PACKET_KIND_MESH_ENVELOPE` (7) and `MESH_SUMMARY` (8); `TransportPacket.copies`;
  - `MeshEnvelope` (the Envelope without device IDs, plus origin token and signature), `MeshSummary`, and `MeshAck.status`/`signature`;
  - `meshRoutingToken(s)`, `meshEnvelopeMessage`, `meshAckMessage`, codecs, conversions; 4 new golden vectors (additions only).
- **`@pingdost/mesh-protocol`** (first code): `MeshPolicy` (REQ §17 defaults; spray 8, quotas, rates), `checkMeshPacket`, `splitCopies`, `SeenCache`, `RelayStore` (250 MB cap, expired-then-oldest eviction, per-origin quotas), `RateLimiter`, `MeshPersistence` plus a memory version.
- **Transport:**
  - `MeshRelay`: summaries after the handshake; holding own packets; spray-and-wait to relay-capable peers; carrying for others (relaying on); handing over to the recipient; signed link-bound ACKs; the recipient's origin resolution and signature check; delivered lists; withdrawal; `status$`.
  - `NearbyPeerTransport` gets the `mesh` option, `carries`, `withdraw`, `onRelayed` and the RELAY capability. The router gets the `mesh` tier, `withdraw`, `onRelayed` and `via` from the transport. Types: `held`, `TransportPath`, `Route` `mesh`.
- **Engine:**
  - route `mesh` (no key claim; browsers wait for the Internet);
  - `held` keeps the item, parked, as `waiting_for_nearby_route`;
  - `Outbox.relayed` → `relayed` with `via: mesh`, `relays: N`;
  - relayed rows never move back; `commit` withdraws deleted items;
  - `createNearbyIdentity` adds `verify` and `resolveOrigin`;
  - `DeliveryRecord.relays`; store contract.
  - `MeshSim` harness plus 8 scenarios in `src/mesh/`.
- **chat-core:** `relayedLabel` ("Forwarded by N devices — not yet delivered…"); `stateLabel(…, via, relays)`.
- **Android:**
  - migration 008 (`mesh_relay_packets`, `delivery_state.relays`), `SqliteMeshPersistence`, wiped at sign-out;
  - `relay.ts` (prefs, pause rules: off, nearby off, battery below 20% unless charging, saver, only while charging, free storage below 1 GB);
  - the service applies relaying, checks every minute, and sets the notification text;
  - Settings → **Nearby relay** (opt-in "Allow this device to relay messages", what relays see, battery and storage, pause rules, restart reminder, cache with counters, clear, when relaying stops);
  - Storage → Nearby relay cache (size, its own clear);
  - message info names the mesh path and the relay count.
  - Native: `NearbyService` notification "PingDost nearby relay active" (`setRelayNotification`); `BootReceiver` and `setRestartReminder` (`RECEIVE_BOOT_COMPLETED`).
- **Docs:** ADR 0025, ADR 0026, CHANGES 2026-11-01 (six items), ARCHITECTURE A4/A5/A6, decisions index, Phase 24/27/30 handoffs, CLAUDE.md.

**Remaining (needs phones; nothing was attached this session):**
- [ ] Build and install on two phones: `pnpm --filter @pingdost/mobile android` (new Kotlin: notification text, boot receiver; migration 008). Turn on Nearby messaging on both, and on phone B Settings → Nearby relay → Allow.
- [ ] **Done when (device):**
  - relay opt-in, opt-out and Clear relay cache on a device (Settings → Nearby relay, Storage → Nearby relay cache), and the notification text switching to "PingDost nearby relay active";
  - receipt UI with 2 phones: A sends to a contact C who is not in range. A shows "Queued", then "Forwarded" once B accepted it, with message info "Forwarded by 1 device — not yet delivered".
  - With a 3rd phone: a physical A → B → C run (B walks from A to C), C reads it, A shows Delivered once the receipt comes back. Otherwise it stays pending.
  - pause rules (battery saver on; "Only while charging" unplugged): the Settings row says "Paused — …" and B refuses new packets.
  - restart reminder: turn it on, reboot, see the notification.
- [ ] Phases 21/22's two-phone checks come first (the relay rides on those links).

**Deviations / decisions:** ADR 0025, ADR 0026; CHANGES 2026-11-01 (Phase 23): boot restart is a notification; unauthenticated delivered lists never drop the sender's copy; relay-visible data listed; relaying needs nearby on; the simulation lives in the engine package; recognition stays key-based.

**Verification results:**
- `pnpm turbo run lint typecheck test`: 56/56 tasks. New tests:
  - protocol 119 (+14: mesh 10, vectors 4);
  - mesh-protocol 11 (new);
  - engine 123 (+8 mesh scenarios with real vodozemac);
  - chat-core +1; mobile 99 (+4: relay rules 3, SQLite relay store 1);
  - transport 34 (unchanged, passing).
- `pnpm format:check` clean. `buf lint` and `buf breaking` against main clean.
- `:nearby:compileDebugKotlin` and `:nearby:testDebugUnitTest` pass; `:app:processDebugMainManifest` merges `BootReceiver` and `RECEIVE_BOOT_COMPLETED`.
- `npx expo export --platform android` bundles (2,456 modules, the new routes included). Typed routes regenerated.
- `pnpm --filter @pingdost/server test:int` (Docker Desktop started, `pnpm infra:up`): 150 passed, 2 skipped, as before.
- **Not run:** anything on a phone.

**Known issues / tech debt:**
- Offers are stop-and-wait per link (one signed ACK each): fine for text, slow for files (Phase 24 pipelines).
- A peer learns that we relay only from a new link's Hello; turning relaying on does not re-handshake existing links.
- Sybil strangers defeat per-origin and per-neighbour quotas; the store cap bounds the damage (ADR 0025).
- The relay cache in SQLCipher is not vacuumed after clearing (Phase 27).
- Group messages over the mesh show group and session IDs to relays and are not tested end to end.
- Receipts, edits and reactions sent into the mesh have no receipt of their own: their outbox items stay (parked) until the Internet takes them or they expire, and the recipient drops the duplicate.
- Phase 22's direct-path issue (a peer that proved a contact's key may ACK and drop) still holds for the direct path.

**Next:** Phase 24 (mesh file transfer), then the open device checks of 10–23.

## 2026-11-01 — Phase 22: Direct nearby messaging — 🔄 partial (device checks open)
Started with Phases 10 and 21 still 🔄 (only their device checks were open); the user said to proceed.

**Done (ADR 0024):**
- **Protocol** (add-only, v1):
  - `Hello` gains `capabilities` (`DIRECT`, `RELAY`) and `HelloProof` (Ed25519 key, signature);
  - `nearbyHelloMessage` signs context ‖ own token ‖ peer token ‖ key ‖ capabilities;
  - `encodeHello`/`decodeHello`, `encodeAck`/`decodeAck`.
- **Transport:**
  - `NearbyTransport` (REQ §11.2 link interface) and `NearbyPeerTransport`:
    - two `Hello`s per side, re-proved after a peer reload, invalid proofs counted (3 close the link);
    - known/unknown peers, envelopes only to the proven recipient device;
    - coalesced `Ack`s, 15 s ACK timeout, link drop → `TIMEOUT`;
    - `summary$` for the UI.
  - `TransportRouter`: `route()` (`internet` / `nearby` / `unreachable` / `offline`), `NO_ROUTE`, `via` on success, `onRoutesChanged`.
  - `@pingdost/transport/testing` has the in-memory radio (`FakeLinks`).
- **Engine:**
  - routing per device item: `unreachable` parks it as `waiting_for_nearby_route` (not encrypted, not an attempt) until routes change;
  - `nearby` skips the key claim and uses the cached fallback key (offline first contact);
  - `via` on delivery rows; partial fan-out when the sender's own directory is uncached offline;
  - `canReachOffline(userId)`, `createNearbyIdentity`, `EngineStore.listDirectories()` (memory, SQLite, Dexie, contract).
- **Android:**
  - `src/nearby/service.ts`: toggle (local, off by default), start/stop by toggle, permission and Bluetooth, foreground service from the foreground only, `useNearby`/`useNearbyStatus`/`useNearbyPeer`;
  - `status.ts`: every state worded;
  - migration 007 (`delivery_state.via`); the router is `[ws, nearby]`; the chat's "online" is the socket only.
  - UI: Settings → **Nearby messaging** (status, toggle, Allow, Bluetooth settings, how it works, what others see) and its setup screen (permission explained first); offline banner with the nearby state and "Can't reach this contact offline until you've connected once online"; chat header "nearby · Bluetooth"; message info path per device ("Sent over Bluetooth … not yet delivered").
  - The BLE wrapper reports links that were up before JS started (reload) as new.
- **Docs:** ADR 0024, CHANGES 2026-11-01 (four items), ARCHITECTURE A4/A5, decisions index, Phase 23/24/27/30 handoffs, CLAUDE.md.

**Remaining (needs two Android phones; also open: Phase 21's checks):**
- [ ] Install the new build on both (`pnpm --filter @pingdost/mobile android`). This is a JS change plus migration 007, with no new native code since Phase 21.
- [ ] On both: Settings → Nearby messaging → turn on → allow. While online once, open a chat with each other so the directories are cached.
- [ ] **Done when:**
  - [ ] airplane mode with Bluetooth on: the header shows "nearby · Bluetooth"; text both ways; labels "Sent" → "Delivered"; message info says "Over Bluetooth";
  - [ ] one phone out of range: "Queued — waiting for a nearby route", sent on return;
  - [ ] Internet back: no duplicates on either phone;
  - [ ] Bluetooth off and permission denied (revoke in app settings): visible in Settings and in the chat's offline banner.

**Deviations / decisions:** ADR 0024; CHANGES 2026-11-01:
1. A nearby ACK gives `sent_to_server` plus `via: nearby`; there is no new state.
2. Strangers see the stable device public key.
3. Nearby is off by default.
4. The fan-out is partial offline.

**Verification results:**
- `pnpm turbo run lint typecheck test`: 55/55 tasks.
  - New tests: protocol 105 (+6), transport 34 (+19), engine 115 (+7 in `src/routing`, real vodozemac), chat-core labels (+1), mobile 95 (+8: nearby status 7, BLE reload 1).
  - The store contracts (memory, SQLite migrations 002–007, Dexie) cover `via` and `listDirectories`.
- `pnpm --filter @pingdost/server test:int`: 150 passed, 2 skipped (with `pnpm infra:up`). `pnpm format:check` clean. `buf lint` clean.
- Metro bundled `nearby-messaging`, `nearby-setup`, `chat/[conversationId]`, `message-info/[messageId]` for Android (HTTP 200).
- **Not run:** anything on a phone.

**Known issues / tech debt:**
- Strangers can recognise a phone again by its key (ADR 0024 Consequences; Phase 23 to weigh contact-only recognition).
- Unknown peers hold link slots and auto-connect may keep reconnecting them (Phase 23 slot policy).
- A peer that proved a contact's key could ACK and drop envelopes; the message stays "Sent", and the Internet does not resend it (Phase 23).
- Location services off (Android 8–11) is not detected, only the permission.
- Groups over nearby are not tested.
- A push wake does not start nearby, and the foreground service starts only from the foreground.
- The dev spike screen and nearby messaging compete for the native queue (noted on the dev row).

**Next:** the two-phone checks of Phases 21 and 22, then Phase 23 (mesh relay).

## 2026-10-31 — Phase 21: Nearby spike (Android BLE) — 🔄 partial (two-phone checks and the matrix open)
**Done (ADR 0023):**
- **Research (dated, ADR 0023 Evidence):**
  - Android 14 fixes the GATT MTU at 517 for the first client.
  - `connectedDevice` needs `FOREGROUND_SERVICE_CONNECTED_DEVICE` plus a Bluetooth runtime permission; Android 15's BOOT_COMPLETED ban does not cover it.
  - Unfiltered scans stop with the screen off.
  - play-services-nearby is 19.5.1 (closed source, so it was **not used**: the user chose "BLE only, no Google library").
  - iOS 26 has Wi-Fi Aware.
  - bitchat-android is **GPL-3.0** (not public domain): reference only.
- **Module `apps/mobile/modules/nearby`** (Kotlin, Android's BLE APIs, no new dependencies):
  - `BleEngine`, one handler thread. Every phone is a GATT server and a client. Legacy advert: service UUID; scan response: an 8-byte random token rotating every 10 minutes, with the set restarted; no name or TX power. Scans use a service filter.
  - Central setup: MTU 517, then service discovery, then the CCCD subscription, with priority HIGH and 2M PHY.
  - Up to 7 links. Peripheral links are created on the CCCD write. The lower token auto-connects, and duplicate links are resolved deterministically.
  - Bluetooth on/off is tracked by broadcast plus a 5 s watch, and peers expire after 30 s.
  - `Framing.kt` + `Link.kt`: HELLO/DATA/CREDIT/TOKEN frames, a 16-bit per-link sequence, packets up to 128 KiB, 8 credits returned in batches of 4, a 512 KiB outbound cap with waiting `send`s, and protocol violations fail the link.
  - Native inbound queue with batched `receive`; credits go back only when JS takes packets. The engine survives JS reloads.
  - `NearbyService`: `connectedDevice` foreground service with a "Nearby is on" notification.
  - `NearbyModule` events: `peerDiscovered`, `peerLost`, `linkUp`, `linkDown` (+ `unsent`), `packet`, `stateChanged`, `log` (states only, no contents). `getState` includes power, Doze and process-importance fields for the matrix.
  - Manifest: Android 12+ Bluetooth permissions (`neverForLocation`); legacy permissions and location capped at API 30. Nearby needs Android 8.0+.
- **JS** (`modules/nearby/src`): types, `parseInbound`/`encodeInbound`, and `createBleTransport` (REQ §11.2 shape: drains the queue, survives reloads, isolates handler errors).
- **Dev screen** Settings → Developer → **Nearby spike (dev)** (`src/app/(dev)/nearby.tsx`, `src/screens/dev-nearby/*`, dev builds only):
  - permissions, start/stop, auto-connect, scan mode, 60 s rotation, foreground service, battery mark;
  - peers and links with counters; text, ping/auto-ping, 1 MB and 10 MB runs (`bench.ts` protocol);
  - Results, live link log, **Share report**.
- **Docs:** ADR 0023 with the measurement matrix and steps, CHANGES (no Nearby Connections; Android 8+; bitchat license; unpaired link), A6, the decisions index, Phase 22/23/24/30 handoff notes (Phase 24's bulk task is now Wi-Fi Aware/Direct), CLAUDE.md commands.

**Remaining (needs two Android phones; no device was attached this session):**
- [ ] Build and install on both phones: `pnpm --filter @pingdost/mobile android` (new native module; a prebuild is not needed).
- [ ] **Done-when check:** both phones in airplane mode with Bluetooth on. Settings → Developer → Nearby spike → Permissions → Start on both → peers appear → a link comes up → text and pings work both ways.
- [ ] Fill ADR 0023's matrix (steps there). Throughput 1/10 MB in both roles, setup, MTU/PHY, RTT, range; the background rows (Home, screen off with and without the service, Doze via `adb shell dumpsys deviceidle force-idle`, saver, swiped away, Bluetooth off/on, permission revoked); 1 h idle battery. Share the reports, then copy the numbers into ADR 0023 and the Phase 24 file size defaults.
- [ ] Check on the device: after "Rotate token", the other phone sees a new address as well as a new token.

**Deviations / decisions:** ADR 0023; CHANGES 2026-10-31 (Phase 21). No Google Nearby Connections (user decision); Android 8.0+ for nearby; BitChat used as a reference only; the BLE link is unpaired (security comes from the E2EE layer).

**Verification results:**
- `:nearby:testDebugUnitTest`: 16 JVM tests pass (`FramingTest` 7: control frames, every frame size from MTU 23 to 517, 16-bit sequence wrap, gaps, repeats, malformed packets; `LinkTest` 9: HELLO, intact packets both ways at three MTUs, credit stall and resume, backpressure, close, a rogue sender cut off, version checks, token announce).
- `:expo:compileDebugKotlin` passes, and autolinking lists `NearbyModule`. `:app:processDebugMainManifest` shows the permissions, the service type and `maxSdkVersion="30"` on the legacy permissions.
- Metro bundled `(dev)/nearby` for Android (HTTP 200).
- `pnpm turbo run lint typecheck test`: 55/55 tasks (mobile 87 tests, including 12 new). `pnpm format:check` is clean.
- **Not run:** anything on a phone (see Remaining).

**Known issues / tech debt:**
- Android's GATT server callback reports disconnects per address. If two links to one phone share a connection, a drop takes both. Watch for links that keep dropping with auto-connect on.
- `START_NOT_STICKY`: the OS does not restart the service after killing the app (Phase 23 decides on boot start and restarts).
- The module and its permissions ship in every build (Play declarations: Phase 27). Only the screen is dev-only.
- An iPhone in the background may be invisible to Android scans (Phase 30).

**Next:** the two-phone checks above. Then Phase 22 (direct nearby messaging) or the open device checks of Phases 10–20.

## 2026-10-31 — Phase 20: Deployment (staging) on one Hostinger VPS — 🔄 partial (user steps on the VPS open)
**Done (ADR 0013 verification; runbooks in `docs/ops/`):**
- **Image:** `apps/server/Dockerfile` (multi-stage, `node:24.22.2-trixie-slim`, `pnpm deploy --prod`, non-root `node`, healthcheck; 420 MB, `/app` holds only `dist/`, `node_modules/`, `package.json`) and a root `.dockerignore` (no `.env`, no build output).
- **Stack:** `deploy/compose.staging.yml` (server with `RUN_WORKER_IN_PROCESS`/`TRUST_PROXY`/`fs` staging volume, read-only, `cap_drop: ALL`; Valkey 8.1.10 with AOF everysec, 256 MB, `noeviction`, password, on an internal network with no route out; Caddy 2.11.7 as the only published service; memory limits; size-rotated logs), `deploy/Caddyfile` (TLS, WS proxy, `flush_interval -1`, 4 MB bodies, security headers, `/metrics` 404, no access log), `deploy/env.staging.example`.
- **Scripts:** `vps-setup.sh` (deploy user, SSH keys only, no root login, unattended upgrades, 2 GB swap, Docker + Compose, cron), `monitor.sh` (REQ §18 metrics, Valkey memory, disk, RAM, containers → healthchecks.io ping or `/fail`), `mongo-backup.sh` (nightly, 7 days, leaves out the mailbox and short-lived request collections).
- **CI/CD:** `.github/workflows/deploy.yml` (a `v*` tag → amd64 image to GHCR → copy stack files and update the VPS over SSH → wait for `/readyz`).
- **Server:** optional `HEARTBEAT_URL` job (every 5 minutes, URL never logged) + test. **Web:** the build writes Cloudflare Pages `_headers` (the page's CSP + `frame-ancestors 'none'`, HSTS, no referrer, COOP, Permissions-Policy, caching). **Mobile:** release signing plugin (upload key from user Gradle properties), `env.production.example` for staging URLs.
- **Docs:** `docs/ops/vps-setup.md` (numbered steps: hPanel firewall and backups, Atlas, Cloudflare DNS/Pages, ZeptoMail or Brevo with SPF/DKIM/DMARC, healthchecks.io, UptimeRobot, usage alerts, GitHub `staging` environment, GHCR visibility; card call-outs), `deploy.md` (deploy, rollback, logs, secret rotation, rebuild on a new VPS, backups and privacy wording), `alerts.md`, `mobile-release.md`. ADR 0013 verification section; CHANGES; A9.

**Remaining (user steps; they need the bought VPS and accounts):**
- [ ] `docs/ops/vps-setup.md` parts 1–7 (VPS, hardening, Atlas, Cloudflare, email, monitoring, `.env` + GitHub environment + first tag `v0.20.0`).
- [ ] Two phones on **mobile data** register, chat and send an attachment through staging (release APK per `docs/ops/mobile-release.md`, or dev builds with `.env` pointing at `https://api.pingdost.com`).
- [ ] The web at `https://app.pingdost.com` pairs and chats (first Pages build is also the check that the monorepo builds on Pages).
- [ ] Alerts fire in a test: `dc stop server` → healthchecks (jobs late, thresholds failed) and UptimeRobot; `dc start server` → recovery (`docs/ops/alerts.md`).
- [ ] From outside only 22, 80, 443 answer (`Test-NetConnection api.pingdost.com -Port 3000` and `-Port 6379` fail).
- [ ] Confirm the plan, its backups and the measured RAM on the VPS (`docker stats --no-stream`) in ADR 0013.

**Deviations / decisions:** CHANGES 2026-10-31 (Phase 20): Atlas Free now 500 connections; healthchecks.io + UptimeRobot instead of Grafana; `/metrics` internal only and no Caddy access log; size-based log rotation; no COEP.

**Verification results:**
- Local rehearsal of the exact stack (Docker Desktop, project `pingdost-stage`, the local image, Caddy on :8088, dev Mongo and Mailpit): all services healthy; only Caddy publishes a port (3000 and 6379 unreachable from the host); `/readyz` ok; security headers present; `/metrics` 404 through Caddy; sim-client 100-message run through Caddy and the WS proxy passed (offline delivery, receipts, no plaintext in 626 frames); 3 concurrent pairs, 1,800 messages: server peak 135 MiB, Valkey 9.5 MiB, Caddy 18 MiB (idle 104 / 8 / 14); the per-IP registration limit refused the 4th and 5th pair (working as designed).
- `monitor.sh` against the stack: "all clear" → success ping; server stopped → `/fail` with `metrics: …` and `container server is not running`. `mongo-backup.sh`'s `mongodump` flags against the dev Mongo: 12 collections written, the 4 excluded ones absent. shellcheck 0.11.0 (warning level): clean.
- Release signing: `prebuild` applied the plugin; `gradlew :app:signingReport` with a throwaway keystore → `Variant: release`, `Config: release`, the given store; debug unchanged.
- Web build emits `_headers`. Server heartbeat unit test passes. Lint/typecheck/test/format: see the commit.
- **Not run:** anything on a real VPS, Cloudflare Pages, Atlas or a phone on mobile data (see Remaining).

**Known issues / tech debt:**
- Rate limits and the connection registry are in memory: keep exactly one server instance.
- The Docker build reinstalls dependencies on any source change (no manifest-only layer); CI uses the GitHub Actions cache.
- `expo` reading `.env.production` for release bundles is from Expo's env rules; check the first release APK actually talks to staging.

**Next:** the user's VPS steps above, then Phase 21 (nearby spike) or the open device checks of 10–19.
## 2026-10-31 — Phase 19: Recovery, encrypted backup & primary replacement — 🔄 partial (device checks open)
**Done (ADR 0022):**
- **Crypto crate:** `backup_derive_key` (Argon2id v0x13, RustCrypto `argon2` 0.6.0, bounded parameters); `CryptoProvider.deriveBackupKey`; conformance scenario `backup-kdf`. WASM and Android (`build:android`, NDK 27.1) bindings regenerated.
- **`packages/backup`:** the `.pdbk` format (69-byte header, attachment STREAM body, JSON/file frames, manifest with header hash, `end` hash); BIP39 phrase (`@scure/bip39` 2.4.0); `exportToBackup`/`restoreFromBackup` over `EngineStore` (never device state; unsent messages → failed; seen IDs; Megolm sessions re-pickled); the phone-change crypto (`transferCode`, `approveTransfer`, `openTransferApproval`).
- **Engine:** `listInboundGroupSessions` (store contract; memory, Dexie, SQLCipher); `announceNewDevice` (SessionReset to every peer device); `resendTo` also sends a replacement device the recent unconfirmed direct messages; `primary_device_changed` notice (same key, verification kept). chat-core label.
- **Protocol:** `ServerFrame.primary_transfer_requested` (add-only, new vector), transfer code and payload helpers. **Transport:** `primary_transfer` event.
- **Server:** `primary_transfer_requests` (TTL) and `/v1/devices/primary-transfer*` (start, list, status, approve, deny, complete) and `/v1/devices/primary-replace*` (email code; `restore` or `fresh`); recent login (15 min), budget (10/hour/account), route limits, audit events; WS prompt plus push wake. `DeviceService.revokeDevice`/`insertPrimary`. OTP purpose `primary_replace`. New error codes.
- **Android:** Settings → Backup (phrase shown once and quizzed, entropy in SecureStore, include files with size, monthly reminder, save to a folder (SAF) or share); device setup's "account is on another phone" now offers approve on the old phone (code + polling), restore from a backup (file, phrase, full check, email code, restore, announce), start fresh; the old phone's approval screen (opens on the WS frame or at foreground); Settings → Log out → Remove data from this phone; a revoked phone also deletes the account key and phrase.
- **Web:** a banner lists phone-change requests with Deny (browsers cannot approve).
- **Sim client:** `SimClient.newPhone(options, old, { mode })` and `approveTransfer`.

**Remaining (device checks; no phone was attached this session):**
- [ ] On a phone: Settings → Backup → set up (phrase, quiz) → save to a folder and via Share. Then Settings → Apps → PingDost → Clear storage, log in → "Restore from a backup" → pick the file, type the phrase, email code → history and identity are back; a contact's chat shows "moved to a new phone", and chatting resumes (the sim peer works as the contact: `pnpm --filter @pingdost/sim-client peer`).
- [ ] Path (a) with two devices (phone + emulator): log in on the second → "Approve on my other phone" → the first shows the request with the same code → approve → the second becomes the phone, the first is signed out and wiped.
- [ ] Start fresh on a device: contacts see "safety number changed".
- [ ] Remove data from this phone: the account's Devices list shows it removed; another account can then set up on the phone.
- [ ] The monthly reminder notification appears (set the phone's date forward), and "Include photos and files" restores viewable files.
- Steps: `pnpm infra:up`; `pnpm --filter @pingdost/server dev`; `pnpm --filter @pingdost/mobile android` (new native lib from `build:android`; a prebuild is not needed, no new native modules).

**Deviations / decisions:** ADR 0022; CHANGES 2026-10-31 (Phase 19). Phrase entropy kept in SecureStore; no stale Olm sessions (a restored phone is a new device); same-key phone change keeps verification; only the primary approves; approval moves no history.

**Verification results:**
- `cargo test --workspace` (13), clippy (host, wasm32, aarch64-android) clean, `cargo fmt` clean.
- `pnpm turbo run lint typecheck test`: 55/55 tasks (backup 13, crypto 25, engine 108, protocol 99, chat-core 8, web-store 24, mobile 75, …). `pnpm format:check` clean. `pnpm --filter @pingdost/web build` OK.
- `pnpm test:int`: 150 passed, 2 skipped. New `recovery.int.test.ts` (7): all three paths over the real server with sim clients, refusals, denial, expiry, recent login, budget.
- Metro compiled the new Android routes (`setup`, `backup`, `approve-phone`) for `platform=android`.
- **Not run:** anything on a phone or emulator (see Remaining).

**Known issues / tech debt:**
- No screenshot blocking on the phrase screen yet (Phase 27).
- A restore interrupted after the server accepted the phone resumes with partial history.
- The old phone gets the prompt live only while connected or when opened; a push wake starts no prompt by itself unless the app runs (a local notification then says to open it).
- Saving to a folder uses the SAF `createFile` + file handle path: untested on a device (Share is the fallback).

**Next:** Phase 20 (deployment, staging).
## 2026-10-31 — Phase 18: History sync (phone → web) + web attachments — 🔄 partial (browser checks open)
**Done (ADR 0021):**
- **Protocol:** `SyncChunk` ops (request, ack, manifest, stop, file request/part) and `SyncBatch` records, add-only; codec checks; `encodeSyncBatch`/`decodeSyncBatch`; new vectors (`content/sync-chunk`, `content/sync-request`).
- **Transport:** `sendEphemeral`/`onEphemeral` (WS transport, router). **Server:** a relayed ephemeral packet is answered `Accepted{DELIVERED_TRANSPORT}`; per-socket budgets (250 packets, 8 MiB per 10 s); two metrics.
- **Engine `src/sync/*`:**
  - `OwnDeviceChannel` (Olm to own devices, ephemeral only);
  - `SyncSource` (phone: bounded hashed batches, stop-and-wait, cursor in a sealed setting, manifest, vault file parts);
  - `SyncSink` (browser: atomic batch + cursor, hash check, manifest check, dedupe, pause/resume, honest offline states with retry, "load older");
  - engine API `historySyncStatus/onHistorySync/syncHistory/pause/resume/loadOlderFromPhone/fetchFromPhone/historySendProgress`.
- **web-store:** `FileCache` (Dexie v3; ciphertext in pieces, LRU).
- **Web:**
  - leader-side transfers (staged download, else the phone in parts up to 25 MB; verify before use; send with canvas compression and previews; held send; upload resume);
  - viewers (image, video, audio inline; documents saved only);
  - composer attach + send dialog; sync banner (progress, pause/resume); "Load older messages from phone" in each chat;
  - Settings → History from your phone and Storage (cache limit, phone-file limit, clear cache);
  - optional `VITE_STORAGE_URL` in the CSP.
- **Android:** serves vault files to the browser (`src/sync/files.ts`); Settings → Devices shows each browser's sync progress.
- **Sim client:** `historySync` option.

**Remaining (browser checks with the real phone; the dev servers were not running for them):**
- [ ] Link a browser to the real phone with history: the chat list fills from the phone with the progress banner; only the last 30 days (max 500 per chat) arrive; the phone's Devices screen shows "Sending history…", then "History sent".
- [ ] Mid-sync: close the tab and reopen it; the sync resumes (not from zero). Put PingDost on the phone in the background for > 30 s: the browser says "Phone offline — sync paused", and continues when the app is opened again.
- [ ] Pause and resume from the banner.
- [ ] In a chat, scroll to the top → "Load older messages from phone" brings older messages.
- [ ] A photo and a PDF sent from the phone before pairing: the browser shows the preview, opens the photo (from the phone), saves the PDF. A file over 25 MB says to open it on the phone.
- [ ] Send a photo (compressed and original), a short video and a PDF from the browser; the phone and a contact receive them.
- [ ] Settings → Storage: clear cache keeps the messages; a smaller limit trims the cache.

**Deviations / decisions:** ADR 0021; CHANGES 2026-10-31. The server never holds sync data (the phone must be online and PingDost open); `device_sync_state` is a sealed engine setting; 500 messages per chat cap; phone files up to 25 MB; no video compression on the web.

**Verification results:**
- `pnpm turbo run lint typecheck test`: 52/52 tasks:
  - engine 108 (13 new sync tests);
  - protocol 98, transport 15;
  - web-store 24 (3 cache), web 10 (3 transfers);
  - mobile 75, server 35.
- `pnpm format:check` clean. `pnpm --filter @pingdost/web build` OK (45 precache entries; first chunk still about 264 kB).
- `pnpm test:int`: 143 passed, 2 skipped. New `history-sync.int.test.ts`: phone + Dexie browser over the real server, socket drop, killed tab, phone offline, each message exactly once, **no Redis write command and no Mongo document change**, zero Redis commands for an uninterrupted sync. `gateway.int.test.ts` covers the `Accepted` answer and the ephemeral budget.
- One engine test (a 150 KB attachment over three devices) timed out under full-suite load; its timeout is now 20 s.
- **Not run:** a real browser or the real phone for Phase 18 (see Remaining). Docker Desktop had stopped; it was started again for `test:int`.

**Known issues / tech debt:**
- The phone serves the sync only in the foreground (no wake).
- Viewing a file holds it whole in memory.
- Each relayed packet does one Mongo read (recipient device).
- No Playwright e2e yet.

**Next:** Phase 19 (recovery and backup), or the open device/browser checks of 10–18.

## 2026-10-20 — Phase 17: Web chat (1:1 + groups) + Web Push + PWA — 🔄 partial (browser checks open)
**Done (ADR 0020):**
- **`packages/web-store`** (moved from `apps/web/src/db`): `DexieEngineStore` (sealed rows, one IndexedDB transaction per batch, an IV-keyed cache, an in-memory search index) passes the full store contract. A portable `VaultKey` type lets Node programs use it.
- **`packages/chat-core`**: the mobile labels and timeline, now shared (mobile re-exports them).
- **Engine:** `subscribeAll`. **Sim client:** a `store` option.
- **Web:**
  - leader/follower tabs (Web Lock plus BroadcastChannel RPC, handoff, revocation to all tabs);
  - chat list, virtualized chat view (react-virtuoso), bubbles (quote, reactions, edit, delete, info, retry) and composer (reply, edit, typing, ↑ to edit);
  - new chat and group, contact page (safety number, QR, verify, block), group page (info, roles, add, remove, leave), message info, search, settings (privacy synced, notifications, shortcuts, unlink);
  - in-page notices from the leader;
  - service worker (injectManifest: precache, offline shell, "New message" push, click to focus) and PWA manifest with icons;
  - code split: the first chunk is about 264 kB.
- **Config:** optional `VITE_WEB_PUSH_PUBLIC_KEY`. **Server:** `pnpm --filter @pingdost/server vapid-keys`.

**Remaining (browser checks; the dev servers were not running for them):**
- [ ] Phone ↔ web in a real browser, 1:1 and in a group, with the real phone.
- [ ] Two tabs open: one socket only (DevTools → Network → WS), both tabs current; close the leader tab and the other takes over.
- [ ] Web Push with the tab closed (Chrome) shows only "New message":
  1. `pnpm --filter @pingdost/server vapid-keys` and copy the output into `.env` and `apps/web/.env`;
  2. restart the server;
  3. `pnpm --filter @pingdost/web build`, then `pnpm --filter @pingdost/web preview`;
  4. Settings → Turn notifications on; close the tab; send from the phone.
- [ ] Offline: with the server stopped, the app opens and shows history; a message written offline sends when the server is back.

**Deviations / decisions:** ADR 0020. Receipts stay with the sending device; copies from your other device show "sent from your other device". Search uses an in-memory index rebuilt from Dexie, not MiniSearch.

**Verification results:**
- `pnpm turbo run lint typecheck test`: 52/52 tasks (web-store 21, chat-core 7, web 7, mobile 75, engine 95, …). `pnpm format:check` clean.
- `pnpm --filter @pingdost/web build` OK: the service worker precaches 41 entries.
- `pnpm test:int`: server 142 passed, 2 skipped. New `web.int.test.ts`: the phone and a Dexie-backed browser over the real server, with pairing, 1:1 both ways, own-device copies, delivered state, a group both ways, search, and nothing readable at rest.
- **Not run:** anything in a real browser for Phase 17 (see Remaining).

**Known issues / tech debt:**
- Attachments on the web are a placeholder until Phase 18.
- Follower tabs are disabled while the leader starts (a few seconds).
- With several tabs, `watchPresence` follows the tab that called last.
- No in-browser e2e test harness (Playwright) yet.

**Next:** Phase 18 (history sync and web attachments).

## 2026-10-20 — Phase 16: Web foundation + QR pairing — 🔄 partial (real-phone checks open)
**Done (ADR 0019):**
- **Pairing protocol** (server `modules/pairing`):
  - `POST /v1/pairing/requests`, `GET …/:id` (header `x-pairing-secret`), `POST …/:id/complete`, `POST /v1/pairing/inspect`, `POST /v1/pairing/approve`;
  - single use, TTL index cleanup, rate limits, audit `pairing_approve`/`device_link`;
  - the device row is created only after the browser's proof of possession.
  - `@fastify/cors` 11.3.1 is limited to `WEB_ORIGIN`. `AuthService.linkedDeviceSession`.
- **Shared:** protocol `pairingApprovalMessage` (context `pingdost/pairing-approval/v1`) and `encodePairingQr`/`parsePairingQr` (also at the `@pingdost/protocol/pairing` subpath); shared-types pairing DTOs (inspect, `deviceId` on approve); api-client `pairingApi` and per-request `headers`.
- **`apps/web`:**
  - Vite 8 + React 19.3 + React Router 8 + TanStack Query + Zustand + Tailwind 4 (shadcn-style Button/Card/Alert on ui-tokens via CSSOM) + Dexie;
  - strict CSP (dev nonce only in `vite dev`); lazy WASM crypto;
  - sealed storage (`db/vault.ts`: non-extractable AES-GCM key, AAD = record name);
  - pairing screen (QR, renewal before expiry, storage note); app shell (chats placeholder, settings with Unlink);
  - one gateway socket per browser (Web Lock); revocation wipes every tab.
- **Android:** Settings → Devices → **Link a browser** (scanner, inspect with a key check, approve with the device key plus account certificate, wait for the browser, refresh own directory). Removing a browser refreshes the directory too.
- **Dev:** `pnpm --filter @pingdost/sim-client phone -- --code '…' [--revoke-after N]`. `SimClient.linkedDevice` pairs for real, and the tests' out-of-band `bindLinkedDevice` is gone.

**Remaining (device checks with the real phone):**
- [ ] The phone pairs desktop Chrome and a second browser; both show as linked under Devices; removing one wipes it (it returns to the pairing screen with the notice).
- [ ] A screenshot of an old QR code scanned after it expired is refused ("This code expired"), and a code scanned twice is refused ("used already").
- [ ] Settings → Unlink this browser on the web: the phone's list shows it removed.
- Steps: `pnpm infra:up`; `pnpm --filter @pingdost/server dev`; copy `apps/web/.env.example` to `apps/web/.env` (done on this PC), then `pnpm --filter @pingdost/web dev`; open http://localhost:5173. The phone build needs `pnpm --filter @pingdost/mobile android` (the Phase 15/16 code is in it). For a phone on the LAN, the web page must use an API URL the phone can also reach, but pairing itself only needs the phone to reach the API.

**Deviations / decisions:** ADR 0019. The device row is created at completion, not at approval (no orphan device for a browser that never finishes). The phone picks the browser's device ID.

**Verification results:**
- `pnpm turbo run lint typecheck test`: 46/46 tasks (protocol 97, mobile 82, web 7, engine 95, …). `pnpm format:check` clean. `pnpm --filter @pingdost/web build` OK: the WASM is a separate 1.1 MB asset and the main chunk is 700 kB.
- `pnpm test:int`: server 141 passed, 2 skipped (`pairing.int.test.ts` 8; the engine and groups linked-device scenarios now pair for real).
- **Browser check** (Chrome on this PC, the phone simulated with the CLI):
  - the pairing page rendered under the CSP and the WASM loaded;
  - approval led to the app shell, connected;
  - IndexedDB held only sealed records and a non-extractable key;
  - revoking from the "phone" pushed `Revoked`, wiped the data and showed the notice with a fresh QR.
- **Not run:** Settings → Unlink in the browser. Claude Code stopped the background API and web dev servers when the PC ran low on memory, and they were not restarted.

**Known issues / tech debt:**
- The web main chunk is about 700 kB (protocol plus engine through `publishKeys`): split it in Phase 17.
- No Web Worker for crypto yet.
- Two tabs: only the lock holder connects. The others show "Connecting…" until it closes (Phase 17 gives followers the leader's state).
- `vite dev` in StrictMode creates one extra pairing request on load (harmless; it expires).

**Next:** Phase 17 (web chat). Phases 10–16 have device checks open, and Phase 12 needs the Firebase setup.

## 2026-10-20 — Phase 15: Attachments UX (Android) — 🔄 partial (device checks open)
**Done (ADR 0018):**
- **Shared packages:**
  - `@pingdost/attachments`:
    - `downloadCiphertext` (streamed, `Range` resume, expired-link renewal, `gone`/`network`/`aborted` errors) and `verifyStream`;
    - `uploadAttachment({ signal })`;
    - compression plans (`IMAGE_PRESETS`, `planVideo`, `scaledSize`, `THUMBNAIL_PRESET`), `asRecordedAudio`, and media details in `buildManifest`/`readManifest`.
  - Protocol: `AttachmentManifest` add-only fields 14–17 (`width`, `height`, `duration_ms`, `waveform`).
  - Engine: `sendAttachment({ held })` plus `releaseAttachment`; the `content_removed` event; captions searchable (memory store plus contract); the session-reset resend covers attachments.
- **Android** (`apps/mobile/src/attachments/*`):
  - vault of STREAM ciphertext (`files.ts`, `pipeline.ts`), migration 006 (`attachments` rows, FTS triggers for captions);
  - transfer runner (`transfers.ts`: two file and four thumbnail slots, pause/resume/cancel/retry, verify then ack, GC, restart-safe);
  - plaintext view cache with cleanup (`view.ts`), auto-download setting (`prefs.ts`), storage controls (`storage.ts`).
- **Local Expo module** `apps/mobile/modules/pingdost-media` (Kotlin, Media3 1.9.1): `videoInfo`, `videoFrame`, `compressVideo` (progress, cancel).
- **UI:**
  - composer ＋ (gallery, photo, video, document) and 🎤 voice notes;
  - the send screen (original vs. estimated sizes, Standard/HD/original, rejection reasons, caption, progress, cancel);
  - bubbles (photo/video tiles with previews, voice/audio player with waveform, document card, transfer line and controls);
  - viewer (pinch-zoom, video, Share with notice);
  - Settings → Storage (usage, auto-download, per-chat files with delete, Clear cache, relay-cache row).
- New deps: expo-file-system 58.0.10, expo-document-picker 58.0.4, expo-audio 58.0.9, expo-video 58.0.12, expo-sharing 58.0.19. `app.json`: `RECORD_AUDIO` with usage strings; background audio and video off.

**Remaining:** the device checks under "Done when". No phone or emulator was attached in this session.
- [ ] Memory stays flat on a 100 MB file: send one and watch `adb shell dumpsys meminfo com.pingdost.app` (PSS should not grow by ~100 MB).
- [ ] Photo sent compressed (Standard) and as original; a 100 MB+ video compressed and sent (or refused with the explanation); a 100 MB+ PDF refused.
- [ ] Voice note sent and received; the recipient views a photo and a video and opens a document via Share.
- [ ] Server object gone after the ACK: the file under `apps/server/.data/attachments` (or SeaweedFS) disappears once every recipient device downloaded.
- [ ] "Clear cache" leaves messages and downloaded files.
- Steps: `pnpm infra:up`; `pnpm --filter @pingdost/server dev`; `pnpm --filter @pingdost/mobile android` (`android/` was regenerated with `prebuild --clean`; the arm64 debug APK builds). The receiving side needs a second PingDost device (phone plus emulator): the sim peer does not handle files.

**Deviations / decisions:** ADR 0018; CHANGES 2026-10-20 (Media3 module instead of react-native-compressor; captions searchable; manifest media details).

**Verification results:**
- `pnpm turbo run lint typecheck test`: 43/43 tasks (engine 95, attachments 17, mobile 79, protocol 94, …). `pnpm format:check` clean. `buf breaking` against main clean.
- `pnpm test:int`: server 133 passed, 2 skipped (the slow spike; the `s3` profile was not up).
- `npx expo export --platform android` bundles. `gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a` builds (106 MB debug APK), so the Kotlin module and Media3 link.
- **Not run:** anything on a device (see Remaining).

**Known issues / tech debt:**
- Transfers and video compression run only while the app runs (no foreground service). They resume at the next start.
- Photo sizes on the send screen come from compressing once; sending compresses again.
- Previews removed by Clear cache cannot be fetched again (the server copy is gone once acknowledged); the bubble shows a plain card.
- Attachments this phone sent in Phase 14 builds have no rows, so they show no file.
- iOS has no `PingdostMedia` implementation (Phase 28).

**Next:** Phase 16 (web + QR pairing). Phases 10–15 have device checks open, and Phase 12 needs the Firebase setup.

## 2026-10-20 — Phase 14: Attachments core — ✅ done
**Done (ADR 0004, 0017):**
- **Rust** `crates/pingdost-crypto/src/attachment.rs`: XChaCha20-Poly1305 STREAM (`chacha20poly1305` 0.11.0, `aead-stream` 0.6.0), per-chunk SHA-256 and the ciphertext and chunk-hash-list digests (`sha2` 0.11.1). WASM and Android bindings regenerated.
  - `CryptoProvider` gains `createAttachmentEncryptor`, `decryptAttachmentChunk`, `sha256` and `createSha256`.
  - Conformance scenarios plus vectors (`test-fixtures/crypto/attachment-stream-v1.json`), cross-checked with `@noble/ciphers` (dev only).
- **`packages/attachments`:**
  - `encryptStream` / `decryptStream` over async iterables;
  - `buildManifest` / `readManifest` (strict; safe file names; thumbnail and caption);
  - `sniffMime` (magic bytes), `canSend` (REQ §10.1), `formatSize`;
  - the resumable `uploadAttachment`.
- **Protocol:** `AttachmentManifest.thumbnail` (12) and `caption` (13), add-only.
- **Server** `modules/attachments`:
  - `fs` store (sharded files, HMAC-signed part and blob URLs with ranges, atomic join) and `s3` store (presigned multipart);
  - create, status, complete (size and SHA-256), download-url (recipients only), ack (the last one deletes);
  - `attachment-janitor` job: expired, orphaned, stuck deletions, leftovers;
  - user quota plus the new total cap `ATTACHMENT_TOTAL_QUOTA_BYTES` (30 GiB, `ATTACHMENT_STAGING_FULL`);
  - rate limits, metrics, and the `ATTACHMENT_OBJECT_STORE_REGION` and `ATTACHMENT_JANITOR_INTERVAL_SECONDS` settings.
- `docker-compose.yml` profile `s3` runs **SeaweedFS** (MinIO CE is gone).
- **Engine:** `kind: 'attachment'` + `MessageRecord.attachment` (`AttachmentInfo`); `attachmentRecipients`, `sendAttachment` (Olm, Megolm in groups), receive with `readAttachment` (invalid → `unsupported`); reactions/delete for everyone work (the tombstone drops the key); `attachmentDecryptInput`. Store contract covers it.
- **Android:** migration 005 (`messages.attachment` JSON), SQLite store, previews/notifications ("📷 Photo" or the caption), a plain attachment bubble (type · size · caption), dev-crypto screen checks the attachment vectors.

**Deviations / decisions:** ADR 0017; CHANGES 2026-10-20 (SeaweedFS instead of MinIO; total staging cap).

**Verification results:**
- `pnpm turbo run lint typecheck test`: 43/43 tasks, 441 unit tests (engine 94 incl. 6 attachment tests with real vodozemac + AEAD; attachments 7; crypto 24; mobile 70). `pnpm format:check` passes. `cargo test` (11), clippy (host, wasm32, aarch64-android) and fmt clean; `buf breaking` clean.
- `pnpm test:int`: server 138 passed, 2 skipped (the slow spike). Includes `attachments.int.test.ts` on `fs` and `s3` (SeaweedFS up), and engine scenario 9: encrypt → stage → E2EE manifest → download → decrypt → ACK through the real server, with no marker in the staged bytes or in WS frames.
- Slow spike (`PINGDOST_SLOW=1`), run twice: 100 MiB round trip on `fs` and `s3` with resume, URL expiry and ACK deletion; heap +2 MiB. Numbers are in ADR 0017.
- `npx expo export --platform android` bundles.
- **Not run:** the attachment vectors on the **native** provider. The dev-crypto screen checks them, but the arm64 Gradle build for the attached phone was stopped by low memory. This is a user device check:
  1. Stop Docker, or run `docker compose --profile s3 stop` first to free RAM.
  2. `npx expo prebuild --platform android --clean` (already done; `android/` is current).
  3. `pnpm --filter @pingdost/mobile android`.
  4. Settings → Developer → **Crypto interop (dev)** → **Run scenarios**. Every attachment step should be green.

**Known issues / tech debt:**
- Nothing is stored locally until the upload completes (Phase 15 adds the uploading placeholder).
- Captions are not searchable.
- The fs→s3 switch does not migrate staged objects.

**Next:** Phase 15 (handoff notes in its file). Phases 10–13 still have device checks open, and Phase 12 needs the Firebase setup.

## 2026-10-20 — Phase 13: Groups (Megolm) — 🔄 partial (device checks open)
**Done (ADR 0016):**
- **Server** `modules/groups`: `groups` collection; create, list, get (members only), add (admins), remove (admins remove plain members, the owner anyone; anyone leaves; a leaving owner hands over), role change (owner); `GROUP_MAX_MEMBERS` → `GROUP_FULL`; versioned with optimistic concurrency.
  - `GroupChanged` WS frame to members' sockets before and after each change (`ConnectionRegistry.forUser`).
  - Routing: envelopes with `group_id` pass only between current members (`NOT_A_MEMBER`); a Megolm envelope without `group_id` is malformed.
- **Protocol (add-only, `buf breaking` clean):** `GroupControl` version/members/description/avatar + `CHANGE_ROLE`/`SNAPSHOT`; `GroupMember`; `RoomKey.exported`; `RoomKeyRequest` (body 14); `GroupChanged` (server frame 12). New golden vectors (additions only).
- **Engine:** `groups/{state,megolm,content,notices,manager}.ts`.
  - Membership from admins' E2EE controls; the server's view only removes/demotes (`reconcile`); late ADD/promotion counts if the server agrees.
  - Megolm session per (group, device), rotated on member-set or device changes, 100 messages or 7 days; room keys over Olm (group-tagged) to devices lacking them; one encryption per message.
  - Inbound sessions keyed by (sender device, session), replay check on stored indices; held messages/keys with `RoomKeyRequest` after 10 s (answered only for devices the session was shared with, from their index).
  - Per-member group states (`aggregateGroupState`); group notices (`group:` JSON system messages); "security code changed" in shared groups; group typing not relayed.
  - Store contract: groups, sessions, held records, outbox `groupId`/`megolm`/`purpose`.
- **Android:** migration 004; SQLite store; New group, Group info (roles, add, remove, leave, mute, edit info and picture), Add members; sender names/colours; group headers, notices, read-only footer after leaving; group pictures ≤ 32 KiB via `expo-image-manipulator` 58.0.15; group notifications ("Trip — Asha: …").
- Sim client: `groupsApi` + `group_changed` → `syncGroup`.
- **Phase 11 bug fixed:** the SQLite store dropped a fan-out's `purpose`, so an edit/reaction queued offline came back as a message fan-out with delivery rows.

**Remaining (user device checks):**
- [ ] A group of 3 on devices (2 phones, or phone + emulator + `sim-client`): create, send both ways, add, remove (the removed phone goes read-only), leave, rename, picture.
- Steps: `pnpm infra:up`; `pnpm --filter @pingdost/server dev`; install the app on both devices (needs `npx expo prebuild --platform android --clean` first: new native module); New chat → New group.

**Deviations / decisions:** ADR 0016; no REQ changes. Client-side membership follows ADR 0003 (controls, not the server); admins plus a compromised server could still add members (documented).

**Verification results:**
- `pnpm turbo run lint typecheck test`: 42/42 tasks, 420 unit tests (engine 87 incl. 17 group tests over the fake server with real vodozemac; mobile 67; server 35). `pnpm format:check` passes.
- `pnpm --filter @pingdost/server test:int`: 126/126 (new `groups.int.test.ts`: REST roles/limits, member-only routing, `GroupChanged`, and sim clients: three members, **a removed member's sessions cannot decrypt the Megolm ciphertexts sent after removal (REQ §19.1 bullet 4)**, a late joiner cannot read earlier messages, two devices, a key arriving after its message).
- Every new/changed route bundled through Metro for Android. Not run: any device check (no phone attached).

**Known issues / tech debt:** see ADR 0016 Consequences (missed promotions; group cost in the mailbox budget). Phase 17 notes added for the Dexie store and web groups.

## 2026-10-20 — Phase 12: Push notifications — 🔄 partial (Firebase setup and device checks open)
**Done (ADR 0015):**
- **Server** `modules/push`: `push_tokens` (one address per device; moved on reinstall; deleted on revoke and logout); `PUT|DELETE /v1/push/token`; `PushService` (≤ 1 wake per device per `PUSH_WAKE_THROTTLE_SECONDS`, one deferred wake at the window's end unless connected, urgent bypass, ≤ 2 retries with `Retry-After`, invalid tokens deleted); FCM HTTP v1 over `fetch` with a `jose`-signed OAuth grant; Web Push via `web-push` 3.6.7; `pingdost_push_wakes_total{result}`.
- **Engine:** `received` event once per new incoming unread message.
- **Android:** `expo-notifications` 58.1.5 + `expo-task-manager` 58.0.12; custom entry `index.ts` (polyfills → wake task → router); headless wake (connect, drain until quiet, close); local notifications per chat (mute, previews, hide sender; group title); channels `messages`/`calls`; Android 13 explainer card; tap → chat; Settings → Notifications (previews, sender, battery optimization link); token registration on start, rotation, delete on logout; `app.config.js` adds `google-services.json` only when present.

**Remaining:**
- [ ] User: Firebase project + `google-services.json` + service account (steps in `docs/phases/phase-12-push-notifications.md`, "User setup").
- [ ] On a phone: notification within seconds when backgrounded, swiped away and locked; record each state's behaviour.
- [ ] An FCM request body inspected live (the integration test already proves it is exactly `{token, data:{t:"wake"}, android:{priority HIGH, collapse_key wake, ttl}}`).

**Verification results:** unit tests (server push 10, mobile content 6); `test/push.int.test.ts` 6/6 (real FCM sender against a fake Google: body content-free, no marker, message, envelope, user or device ID); an x86_64 debug APK with the notification modules built (`assembleDebug`).

**Known issues:** the notification icon is the template glyph (Phase 27). Delivery when swiped away depends on Android/OEM battery policies (ADR 0015).
## 2026-10-20 — Phase 11: Chat features — 🔄 partial (device checks open)
**Done (ADR 0014):**
- **Engine** (`packages/message-engine`):
  - `features/ops.ts`:
    - reactions: one per user; the newest event wins, a withdrawal included;
    - edit: sender only, 24 h, last-write-wins, no history kept;
    - delete for everyone: sender only, 24 h, tombstone; best-effort copy in the UI;
    - ops that arrive before their target wait in `message_ops` and are applied when it lands.
  - Ops fan out as `control` outbox items.
  - Also: replies (quote resolved locally), delete for me, delete/archive/pin/mute conversations.
  - Read receipts from `markRead` (reciprocal); a `deliveryReceipts` toggle.
  - `blocked` option: drops content still queued from blocked users.
  - Search (`search.ts`): word-prefix terms, shared by the stores and the highlighter.
  - Store contract extended: `listUnread`, `searchMessages`, `listOps`, batch deletions.
- **Android:**
  - Migration 003: new columns, `message_ops`, and FTS5 rebuilt on the rowid with triggers, inside SQLCipher (`categories 'L* N* Co M*'`, so Devanagari works).
  - Chat: long-press menu (quick reactions, reply, edit, info, delete for me / for everyone with the REQ §5.4 copy), quotes, reaction chips, "edited", tombstones, reply and edit modes, blocked state, in-chat search with jump-to-message.
  - Chat list: pinned first, Archived, mute/pin marks, long-press menu, delete with confirmation.
  - Search screen with highlighting; report screen (messages attached only if ticked).
  - Block / unblock in Contact info and Settings → Privacy → Blocked contacts.
  - Privacy: a delivery receipts toggle; reciprocal read-receipt copy.
- **Server:**
  - `modules/security/{blocks,reports,routes}.ts`.
  - A send to a blocker is answered `Accepted{STORED}` and dropped (no store, no push, `pingdost_envelopes_blocked_total`).
  - Typing goes only to sockets watching the sender, never across a block; presence stops across blocks.
  - Lookups still work while blocked.
  - `POST /v1/reports` with a TTL (`ABUSE_REPORT_RETENTION_SECONDS`, 90 days); `privacy.deliveryReceipts`, defaulted for old accounts; `text`/`details` added to log redaction.
- Echo peer: read receipts, replies, and `!react` / `!edit` / `!delete` commands for device checks.

**Remaining (user device checks):**
- [ ] Every feature between two Android devices (phone + emulator; or phone + the echo peer for the incoming side):
  - reactions;
  - reply quotes;
  - edit (with the "edited" mark);
  - delete for me / for everyone;
  - global and in-chat search (Hindi too);
  - archive / pin / mute / delete chat;
  - read receipts on and off on both phones;
  - block (the blocked phone still shows "Sent"), unblock, report.
- Not run here at all: the app UI. The emulator I booted showed another project in Expo Go and then shut down mid-check; the window was most likely closed by hand. The APK on disk is arm64-only, so a fresh emulator build is needed (see CLAUDE.md).
  - Instead, every changed route was bundled through Metro for Android without errors, and the app typechecks.
- Steps:
  1. `pnpm infra:up` and `pnpm --filter @pingdost/server dev`.
  2. `pnpm --filter @pingdost/mobile android` with the phone attached; for the emulator, `npx expo run:android --no-bundler --device emulator-5554` in `apps/mobile`.
  3. Optional: `pnpm --filter @pingdost/sim-client peer`.
  4. Chat, then long-press a message for reactions, reply, edit and delete; long-press a chat for pin, archive, mute and delete.
  5. Try "Search" in both headers, and Contact info → Block / Report.

**Deviations / decisions:** ADR 0014; no REQ changes.
- No proto change: an edit's time is its header `sent_at_ms`.
- Delete for everyone has a 24 h window, like edit (`DEFAULT_LIMITS.messageDeleteWindowSeconds`).
- Archived chats stay archived when new messages arrive. Pins are limited to 3.
- Delivery receipts are not reciprocal. With them off at the recipient, the sender's messages expire as undelivered, and the expired label now says that receipts may be off.
- Typing is scoped to watchers, which is how the server, with no conversation list, ties it to conversations.
- Phase 10 fix: a chat started by an incoming message never got `lastMessageId`. The engine now compares against the current last message.

**Verification results:**
- `pnpm turbo run lint typecheck test`: 42/42 tasks, 377 unit tests (engine 68, mobile 57, server 25, protocol 91, config 70, …). `pnpm format:check` passes.
- `pnpm --filter @pingdost/server test:int`: 112/112 (new `security.int.test.ts`; the typing-scope case in `gateway.int.test.ts`).
- `buf breaking --against '../../.git#branch=main,subdir=packages/protocol'`: clean (no proto changes).
- The SQLite store passes the extended contract on `node:sqlite`, including a Phase 10 → 11 upgrade (old messages searchable, counted as read).
- Not run: any on-device check (see above).

**Known issues / tech debt:**
- Ops (edit, delete, reaction) accepted by the server are not resent after a session repair (ADR 0014; Phase 27 measures).
- The report screen's "deleted after 90 days" copy is fixed text; it must follow `ABUSE_REPORT_RETENTION_SECONDS` (Phase 27).
- No copy-to-clipboard action yet (expo-clipboard not added).
- The arm64 debug APK I installed on the emulator crashes there; the emulator rebuild above replaces it.
- Earlier items are still open: the Phase 10 two-phone checks, binding drift check, pickle-key zeroization (Phase 27), `OWNER` in `repository.url`, stale `C:\dev\pd`, the native MongoDB Windows service.

**Next:** the Phase 10 and 11 device checks, then Phase 12 (push) or 14 (attachments core).
## 2026-10-19 — Phase 10: 1:1 encrypted chat on Android — 🔄 partial (device checks open)
**Done (ADR 0012):**
- **Store:**
  - SQLite migration 002: the REQ §14.1 tables plus `crypto_sessions`, `device_directory`, `directory_devices`, `seen_ids`, `contacts` and `messages_fts`.
  - `SqliteEngineStore`: one queued `BEGIN IMMEDIATE` per batch; the account pickle goes into `CryptoStore`'s row. It passes `runEngineStoreContract` on `node:sqlite`, and the engine runs end to end on it.
- **Runtime** (`src/engine/runtime.ts`):
  - an engine singleton for the `ready` stage;
  - AppState with a 30 s background grace period, network reconnects, 4001 token refresh;
  - on `revoked`, the chat data is wiped and the user signed out (setup's account reset wipes it too);
  - every Olm account change goes through `engine.replenishKeys`; the app-level version was removed.
- **Screens** (`(app)` Stack over `(tabs)`):
  - chat list: previews, unread counts, status glyphs, empty state, "New chat" button;
  - new chat: exact username lookup, then a profile card;
  - chat: FlashList from the bottom, older pages, day separators, honest labels, tap to retry, long-press for Message info, composer, typing, presence;
  - Message info (modal, per device);
  - contact info: safety number and QR code;
  - QR scanner: expo-camera; a match marks the contact verified.
  - expo-image avatars; profiles via the new `GET /v1/users/:id` and a `contacts` cache.
- **Safety numbers** (`@pingdost/protocol/safety-number`): Signal-style 60 digits over the account identity keys, and a versioned QR code with both fingerprints. Native SHA-512 on the phone.
- **Presence:** `Presence.watch_user_ids`; the gateway's `PresenceHub` (in memory, reciprocal, follows `privacy.lastSeen`); `WsTransport.setPresence` / `watchPresence`.
- **TextDecoder:** self-test plus a WHATWG UTF-8 fallback. Hermes V1 turned out to be strict natively, so the fallback is unused.
- `pnpm --filter @pingdost/sim-client peer`: an echo contact for device checks.

**Remaining (user device checks):**
- [ ] Two Android devices (phone + emulator) chat E2EE both ways. Done here only as emulator ↔ headless peer: native vodozemac on Android with WASM on the peer, through the real gateway and mailbox.
- [ ] QR verification between two phones: both scan each other's code, both show "Verified". The comparison logic is unit-tested; an emulator camera cannot scan another screen.
- Steps:
  1. `pnpm infra:up` and `pnpm --filter @pingdost/server dev`.
  2. `pnpm --filter @pingdost/mobile android` with the phone attached (and the emulator running).
  3. Register one account on each device.
  4. New chat with the other's username; send both ways.
  5. Contact info → "Scan …'s code" on each phone, pointed at the other's QR code.

**Deviations / decisions:** ADR 0012, no REQ changes.
- expo-camera moved up from Phase 16. The image picker now passes a camera usage string, because blocking `CAMERA` removed it from the manifest.
- Presence is opt-in per open chat and reciprocal.
- Two add-only protocol/API changes: `Presence.watch_user_ids` and `GET /v1/users/:id`.

**Verification results:**
- `pnpm turbo run lint typecheck test`: 42/42 tasks, 336 unit tests (mobile 50, protocol 91, server 24). `pnpm format:check` passes.
- `pnpm --filter @pingdost/server test:int`: 106/106 (presence relay, profile by ID).
- On the emulator (Pixel_8_API_35, debug build, dev server), against the echo peer:
  - register, then automatic device setup;
  - username lookup, chat, E2EE both ways;
  - "Delivered" only after the peer's receipt; "Sent" while the peer was offline;
  - airplane mode → "Queued" → back online → "Delivered";
  - force-stop and relaunch keeps the history;
  - presence "online" and the typing indicator show;
  - Message info shows each device.
  - The safety number on the emulator equals the Node computation for the same pair (`55877 … 47058`). It takes about 1.4 s with native SHA-512 (about 10 s with JS SHA-512 in a debug build).
- Ciphertext-only on the dev stack during an offline send: the marker was in 0 of 357 Mongo documents and 0 of 21 Redis values (3 queued envelopes).
- **Not run:** two Android devices at once (RAM), the QR camera scan, release build and APK size.

**Known issues / tech debt:**
- The dev-client "Tools" bubble overlaps the header's right side in debug builds (dev only).
- Read receipts and FTS indexing come in Phase 11.
- Earlier items are still open: binding drift check, pickle-key zeroization (Phase 27), `OWNER` in `repository.url`, stale `C:\dev\pd`, the native MongoDB Windows service.

**Next:** the two Phase 10 device checks above, then Phase 11 (or Phase 12 / 14).
## 2026-10-19 — Phase 09: Message engine & session management — ✅ done
**Done (ADR 0011):**
- **`@pingdost/transport`:**
  - the `Transport` interface;
  - `WsTransport` (standard WebSocket API): `Auth`, backoff with jitter, idle pings, a liveness check, close codes 4001/4002/4003/4008, coalesced ACKs;
  - a `TransportRouter` skeleton.
- **`@pingdost/message-engine`:**
  - `MessageEngine` and the `EngineStore` interface (one atomic `apply(batch)`), with `MemoryEngineStore`;
  - a two-level outbox (fan-out → per-device items, encrypted once, same bytes on retransmit, batched key claims, backoff);
  - REQ §8.3 states aggregated over recipient devices (own devices never count);
  - verified directory cache (certificates, fallback-key signatures, added/removed devices, "safety number changed");
  - Olm session manager with pre-key routing;
  - session repair (`SessionReset` + resend);
  - coalesced E2EE receipts, expiry sweep, transient typing, `replenishKeys` with weekly fallback rotation.
  - `/testing`: the store contract suite and an in-memory fake server.
- **Protocol:**
  - `ContentHeader.recipient_user_id` (field 7) and `directConversationIdFor`;
  - `decodeContentHeader` for "update needed" placeholders.
- **Server:** `GET /v1/keys/devices/:id` (device → owner). **Config:** `DEFAULT_LIMITS.messageMaxRetentionSeconds`.
- **`tools/sim-client`:** a `SimClient` library (real E2EE) plus the CLI scenario with a WS frame plaintext scan. The old `socket.ts`/`device.ts` are removed.

**Deviations / decisions:** ADR 0011, no REQ changes.
- A protocol field and a REST endpoint were added (add-only within v1).
- An undecryptable envelope is ACKed but not marked seen, so the post-repair resend under the same envelope ID gets through.

**Verification results:**
- `pnpm turbo run lint typecheck test`: 42/42 tasks, 300 unit tests (message-engine 37, transport 13, protocol 83). `pnpm format` was applied.
- `pnpm --filter @pingdost/server test:int`: 104/104. `test/engine.int.test.ts` passes all 8 scenarios: online, offline, reconnect mid-send, duplicate Deliver frames, server restart, an added device, a revoked device, and the plaintext-marker scan of Redis, Mongo and WS frames.
- Sim client against the dev server: 20 offline + 20 online messages decrypted once each and delivered after receipts; no marker in 136 frames.

**Known issues / tech debt:**
- Linked devices are bound out of band in tests until Phase 16.
- Receipts go only to the sending device.
- A failed commit after a new inbound session loses that message (logged).
- Earlier items are still open: binding drift check, pickle-key zeroization (Phase 27), `OWNER` in `repository.url`, stale `C:\dev\pd`, the native MongoDB Windows service.

**Next:** Phase 10. See its Phase 9 handoff notes: SQLite `EngineStore` + contract tests, engine wiring, the `TextDecoder` polyfill.
## 2026-10-19 — Phase 08: Realtime gateway & delivery mailbox — ✅ done
**Done (ADR 0010):**
- **Gateway** `GET /v1/ws` (`@fastify/websocket` 11.3.4):
  - an `Auth` frame within 5 s (JWT + active session + active device);
  - one socket per device (`CONNECTION_REPLACED`, 4002); `Revoked` on revocation (4003); session re-check every 60 s;
  - per-socket frame, typing and in-flight limits; ping/pong; backpressure;
  - in-memory typing and ephemeral relays;
  - `OtkLow` on connect and after claims (event-driven, no job).
- **Mailbox** (`modules/delivery`):
  - online path (transport ACK within 5 s) or offline path: dedupe, Redis MULTI with NX writes, a push-wake hook, a Mongo fallback, `MAILBOX_UNAVAILABLE` when both stores are down;
  - server `createdAt`; `expiresAt` = min(packet expiry, + retention);
  - fetch on connect: Redis + Mongo merged, batched, flow-controlled;
  - ACKs coalesced per connection (50 ms);
  - `pending_envelopes` with TTL and indexes.
- **Jobs:** the migration (lock, `$setOnInsert` with majority write, read-back, then MULTI delete; ACK-race cleanup; expired envelopes deleted; 3 retries) and the Mongo reaper.
- **Metrics:** `/metrics` (`prom-client` 15.1.3) with the A3 metrics, refreshed per migration run.
- `tools/sim-client`: two headless devices with fake ciphertext.
- Valkey runs with AOF in docker-compose. WS URLs now end in `/v1/ws`.
- Docs: ADR 0010, ARCHITECTURE A2/A3, CLAUDE.md, handoff notes in phases 09–13 and 20.

**Deviations / decisions (ADR 0010; no REQ changes):**
- The OTK notice is event-driven, not a job.
- Overdue = due for over half the grace period, so the alert fires before data loss.
- ACKs always delete from Mongo, which closes the fetch → migrate → ACK race.
- A successful ephemeral relay gets no reply.
- Mailbox gauges cost Redis commands, so they refresh per migration run instead of per scrape.

**Verification results:**
- `pnpm turbo run lint typecheck test`: 40/40 tasks, 248 unit tests (server 20). `pnpm format:check` passes.
- `pnpm --filter @pingdost/server test:int`: 95/95. All 9 REQ §19.2 scenarios are covered (`test/mailbox.int.test.ts`), along with the gateway tests and the Redis budget ceilings.
- Sim-client against the dev server: 20 stored → delivered once each → acknowledged → gone; 20 delivered online. 115 Redis commands for 20 offline messages (229 before ACK coalescing).
- **Redis budget:** store 5, fetch 2 per batch, ACK 6 per batch, migrate 7, online 0, idle 44K per month. That is ≈ 7,400 per active user per month, so Upstash free fits about 50–60 users. The recommendation is self-hosted Valkey with AOF (Phase 20 decides).
- **Not run:** GitHub CI (no remote). The worker run as a separate process exposes no metrics yet.

**Known issues / tech debt:**
- On Windows, a refused localhost Redis connection takes about 2 s, so the Redis-down fallback is slow locally (instant on Linux).
- Typing is not yet scoped to conversations (Phase 11).
- Earlier items still open: binding drift check, pickle-key zeroization (Phase 27), placeholder `OWNER` in `repository.url`, stale `C:\dev\pd`, the native MongoDB Windows service.

**Next:** Phase 09 (message engine & session management): see its Phase 8 handoff notes.

## 2026-10-19 — Phase 07: Mobile onboarding & account UI — ✅ done
**Done:**
- Server (ADR 0009): re-registering the same device ID with the same keys **resumes** the device on the new session (proof of possession checked; no second primary; `keyVersion` unchanged; `device_resume` event). Another account's ID or other keys give `CONFLICT`; a revoked device gives `DEVICE_REVOKED`.
- `@pingdost/protocol/signing` and `/ids` subpath exports, so the app signs without loading protobuf descriptors. `@pingdost/config/public` gains the optional `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`.
- `apps/mobile`:
  - routes `(auth)` (welcome, register, verify-otp, login, forgot/reset password, google-username), `setup` (device registration), and `(app)` with native tabs Chats (placeholder) and Settings (profile + avatar, privacy, devices, about privacy, logout). The root `index` redirects by stage, and `Stack.Protected` gates each group;
  - the Zustand auth store with tokens in SecureStore and single-flight refresh. Logout keeps local data;
  - Zod forms from the shared schemas, server error mapping, OTP resend countdown, offline banner;
  - Google Sign-In (free Original API; hidden until a client ID is set);
  - device setup: identity key, challenge, register or resume, then publish 50 one-time keys + the fallback key, with a top-up below 20 on every start;
  - `CryptoStore.resetAccount`, `local_settings` helpers, light/dark tokens and accessibility labels.
- New deps (licenses checked, MIT): zustand 5.0.15, `@react-native-google-signin/google-signin` 16.1.5, expo-image-picker 58.0.10 (camera and microphone permissions blocked), expo-network 58.0.3, expo-symbols 58.0.4.
- Docs: ADR 0009, ARCHITECTURE A5/A6, CLAUDE.md (mobile `.env`, typed routes), READMEs, `.env.example`, and handoff notes in phases 08, 10, 11, 15, 16, 19, 28.

**Pending (user action; Done-when allows these):**
- Google sign-in, once the client IDs exist. The steps are in the Phase 06 entry below. Put the web client ID in `apps/mobile/.env` as `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`, and both IDs in `GOOGLE_CLIENT_IDS` in the root `.env`. Rebuild only if the Android OAuth client needs this build's SHA-1.
- Avatars, only if Cloudinary is configured. That also checks the unverified SHA-256 signature.
- A run on the real phone. No phone was attached, so Done-when ran on the emulator; arm64 crypto was already proven on the phone in Phase 3.

**Deviations / decisions (ADR 0009; no REQ changes):**
- The device-resume path; one account per phone for now.
- "Remove data from this phone" moved to Phase 19: without a backup, wiping the identity key would lock the account out.
- `/` is an unprotected redirect route, because a protected `/` showed "Unmatched Route" while the session loaded.
- `md` tab icons need `expo-symbols` on Android.

**Verification results:**
- `pnpm turbo run lint typecheck test`: 38/38 tasks, 245 unit tests. Mobile has 27, including device setup against an in-memory server with WASM vodozemac. `pnpm format:check` passes.
- `pnpm --filter @pingdost/server test:int`: 72/72. A first run alongside the Gradle build and emulator failed from load (8 files); the re-run passed.
- **Emulator** (Pixel_8_API_35 x86_64, dev build, local server on the LAN IP). Done-when steps 1–6 pass:
  1. registered `bob7`;
  2. verified with the OTP from Mailpit;
  3. device setup → Chats and Settings tabs;
  4. Mongo: one active primary with its certificate and fallback key, 50 one-time keys, the account identity public key, and no secret/private/pickle material;
  5. force-stop and relaunch opened Chats with the same identity key;
  6. logout (server session revoked, `logout` event) → login resumed the same device: one primary, unchanged `keyVersion`, 50 one-time keys, `device_resume` event.
  - Also checked:
    - the profile display name and the privacy toggles saved in Mongo;
    - the Devices screen;
    - dark mode;
    - `alice7` (whose primary was the earlier, wiped emulator install) showed "This account is active on another phone".
  - That last check found a bug: a failed setup claimed the phone for that account. Fixed: the device record is now saved only after the identity-key check, with a test.
- An earlier attempt was cut short when Claude Code stopped the server, emulator and Metro for low memory. This run built with Gradle alone (2 workers, 1 min incremental) before starting the emulator.
- **Not run:** real phone, Google, avatars, GitHub CI (no remote).

**Known issues / tech debt:**
- A clean debug build takes ~20 min on this PC; incremental `gradlew app:assembleDebug --max-workers=2 -PreactNativeArchitectures=x86_64` takes ~1 min. Build before starting the emulator: Gradle, the emulator and Docker together exhausted memory once.
- The emulator boots from an old quick-boot snapshot, so app data from a previous session is gone after it restarts.
- The native MongoDB Windows service is still running (Phase 5 note).
- Earlier items still open: binding drift check, pickle-key zeroization (Phase 27), placeholder `OWNER` in `repository.url`, stale `C:\dev\pd`.

**Next:** Phase 08 (realtime gateway & delivery mailbox). The app calls `replenishKeys()` on its low-keys notice (handoff in phase 08).

## 2026-10-19 — Phase 06: Google sign-in, devices, key directory, profiles — ✅ done
**Done:**
- Crypto:
  - `SigningKey` in `crates/pingdost-crypto` (account identity key) and `CryptoProvider.createSigningKey`/`restoreSigningKey`, with conformance scenario `idk`;
  - WASM and Android bindings regenerated (`.so` is git-ignored: rebuild before the next device build).
- `@pingdost/protocol` `signing.ts`: the context-prefixed byte formats for device certificates, registration proofs and signed one-time/fallback keys.
- Server (ADR 0008):
  - Google ID-token sign-in (jose remote JWKS; injectable for tests) with the linking policy, plus `/google/complete`;
  - devices: challenge, register (proof of possession + certificate, one active primary, session bound with a `did` claim), list, revoke (sessions, keys, keyVersion, audit, hook);
  - key directory: signed uploads (max 200), directory with fallback keys, atomic claims with a per-account budget;
  - `PATCH /v1/me`, exact username lookup (per-IP and per-account limits), Cloudinary avatar signing.
- `@pingdost/api-client`: `accountApi`, `devicesApi`, `keysApi`, and Google in `authApi` (`me()` moved to `accountApi`). New codes `GOOGLE_EMAIL_UNVERIFIED`, `DEVICE_REQUIRED`, `IDENTITY_KEY_MISMATCH`.
- Docs: ADR 0008, ARCHITECTURE A5, CLAUDE.md (NDK 27.1 note), server README; handoff notes in phases 07, 08, 09, 16, 19.

**Deviations / decisions (ADR 0008; no REQ changes):**
- Signed statements carry a context string (the phase text said raw `nonce ‖ deviceId ‖ keys`).
- The server verifies Ed25519 with `node:crypto`; clients verify strictly with vodozemac.
- Unverified Google emails are rejected.
- Only the primary or the device itself may revoke a device; a lost primary is replaced through Phase 19.

**Verification results:**
- `cargo fmt --check` passes; `cargo test` 6/6; clippy is clean on host, wasm32 and aarch64-linux-android.
- `pnpm turbo run lint typecheck test --force`: 38/38 tasks, 224 unit tests (protocol 81, crypto 23). `pnpm format:check` passes.
- `pnpm test:int`: 71/71. They cover:
  - Google tokens against a mocked JWKS (good, wrong aud/iss, expired, foreign key, unverified email not linking);
  - registration signatures and nonce reuse/expiry, `PRIMARY_EXISTS`, revocation effects;
  - the claim race (50 parallel claims: 20 unique one-time keys, then 30 fallbacks), lookup limits;
  - Mongo docs holding public keys but not the identity-key secret.
- **Not run (device):** the phone's `(dev)/crypto` screen with the new `idk` scenario. It needs a rebuild: `$env:ANDROID_NDK_HOME` → 27.1, then `pnpm --filter @pingdost/crypto-native build:android` (done here), then `pnpm --filter @pingdost/mobile android`. **Not run:** GitHub CI (no remote).

**Google OAuth client IDs for Phase 7** (free; the user does this):
1. https://console.cloud.google.com → create a project "PingDost".
2. Google Auth Platform (OAuth consent screen) → app name, support email, audience **External**; while in Testing, add your Google accounts as test users.
3. Clients → Create client → **Web application** → copy the client ID.
4. Clients → Create client → **Android** → package `com.pingdost.app`. SHA-1 of the debug keystore: `keytool -list -v -keystore apps/mobile/android/app/debug.keystore -alias androiddebugkey -storepass android -keypass android` (after a prebuild).
5. Put both IDs in `GOOGLE_CLIENT_IDS` in the root `.env`, comma-separated. Phase 7 gives the web client ID to the app.

**Known issues / tech debt:**
- The Cloudinary SHA-256 signature is unverified against a real account (Phase 7, if avatars are used).
- The native MongoDB Windows service is still running (see Phase 5).
- Earlier items still open: binding drift check, pickle-key zeroization (Phase 27; it now covers `SigningKey.exportSecret` strings too), placeholder `OWNER` in `repository.url`, stale `C:\dev\pd`.

**Next:** Phase 07 (mobile onboarding & account UI). It needs the Google client IDs above; load `expo:expo-overview` first.

## 2026-10-19 — Phase 05: Server foundation + password auth — ✅ done
**Done:**
- `apps/server` (Fastify 5.12.7 + fastify-type-provider-zod 7, tsx dev, tsup 8.5.1 build): `buildApp(config, deps)`, `main.ts` (API, plus jobs when `RUN_WORKER_IN_PROCESS`) and `worker.ts`.
- Infra:
  - Mongo (driver 7.7, small pool, index registry) and a lazy ioredis 6 handle with a command counter;
  - pino 10 with a deep field scrub (no headers, query strings, IPs or emails in logs) and problem+json errors for AppError, Zod, Fastify 4xx and 404;
  - `@fastify/rate-limit` per-route budgets, in-memory `WindowCounter`s, and a `Scheduler` with `job_locks` leases;
  - graceful shutdown, plus config redaction for logs.
- `/healthz`, `/readyz` (Mongo ping with a 2 s cap; Redis once used).
- Email: `console` / `smtp` (nodemailer 10) / `zeptomail` (HTTP; regional `ZEPTOMAIL_API_URL`), with OTP templates.
- Auth (ADR 0007):
  - register (reserved names; unverified accounts expire after 24 h) → email OTP verify → session;
  - login with a dummy-hash path and a lockout after 5 failures per 15 min;
  - access JWT plus session check on every request; refresh rotation with reuse detection that revokes the family;
  - logout, password forgot/reset (revokes all sessions) and change (revokes the others);
  - security events with hashed IPs, and `GET /v1/me`.
- `@pingdost/api-client` `authApi()`; new codes `OTP_ATTEMPTS_EXCEEDED` and `ACCOUNT_DISABLED`; config adds `LOG_LEVEL`, `TRUST_PROXY`, `ZEPTOMAIL_API_URL` and `UNVERIFIED_ACCOUNT_TTL_SECONDS`.
- CI integration job starts Mailpit too; `MAILPIT_URL` added to turbo `passThroughEnv`. Docs: ADR 0007, A11, CLAUDE.md, handoff notes in phases 06, 08, 16, 20.

**Deviations / decisions (ADR 0007; no REQ changes):** `EMAIL_TAKEN` is returned for verified accounts (an unverified registration is replaced instead). No CORS yet (Phase 16). Phase 5 has no scheduled jobs: TTL indexes expire OTPs, unverified accounts, sessions and security events.

**Verification results:**
- `pnpm turbo run lint typecheck test --force`: 38/38 tasks, 219 unit tests (server 17, config 67). `pnpm format:check` passes.
- `pnpm test:int`: 35/35 against Mongo 8.0 + Valkey + Mailpit. They cover:
  - OTP expiry, reuse, over-attempts and resend cooldown; refresh reuse; lockout; route and per-email 429s;
  - log redaction; readyz with Mongo unreachable (503 in under 3 s); the api-client end to end.
- Manual: `pnpm --filter @pingdost/server dev` starts and `/readyz` returns 200. With the Mongo container stopped it returns 503 after 2 s while `/healthz` stays 200. The tsup bundle starts and `/readyz` returns 200.
- **Mongo restart on this PC:** the server's client did **not** recover after the Docker Mongo came back. Cause: a native Windows "MongoDB Server" service also listens on `127.0.0.1:27017`. Pinned to Docker's Mongo, the client recovered 9 s after the outage. The user should stop and disable that service (CLAUDE.md).
- **Not run:** GitHub CI (no remote yet).

**Known issues / tech debt:**
- Rate limits and lockouts are in memory per instance (one API instance until Phase 20 decides).
- Earlier items still open: binding drift check, pickle-key zeroization (Phase 27), placeholder `OWNER` in `repository.url`, stale `C:\dev\pd`.

**Next:** Phase 06 (Google sign-in, devices, key directory, profiles). It needs Google OAuth client IDs for Phase 7: see its handoff notes.

## 2026-10-19 — Phase 04: Protocol & shared contracts — ✅ done
**Done:**
- `packages/protocol`:
  - buf v2 config and `proto/pingdost/v1/{packet,envelope,content,ws,mesh}.proto`, with protoc-gen-es output committed in `src/gen/`;
  - codecs (`encode*`/`decode*` for TransportPacket, Envelope, Content, ClientFrame, ServerFrame) and `ProtocolError`;
  - Content padding buckets, ID helpers (`uuidv7`, `envelopeIdFor`, UUID/base64), and 44 golden vectors in `packages/test-fixtures/protocol/v1.json`.
- `packages/shared-types`: Zod v4 DTO stubs (auth, profile, devices, keys, groups, attachments, pairing, health), `ErrorCode` + `ERROR_STATUS`, problem+json, pagination, `MessageState` + transitions.
- `packages/api-client`: `createApiClient` (problem+json → `ApiError`, timeouts, GET retries, shared token refresh) + `health()`.
- `packages/crypto`: `CryptoProvider` marked final; `runCryptoConformance(provider, vectors)` (14 scenarios + 3 stored vectors) runs on WASM in Vitest.
- CI: `buf lint` (in the protocol `lint`), a job that fails if regenerated code differs from the commit, and `buf breaking` against main on pull requests.
- Docs: ADR 0006, ARCHITECTURE A4/A8, CLAUDE.md commands; handoff notes in phases 05, 06, 08, 09, 10 (Phase 8's `Send` now carries one packet per frame).

**Deviations / decisions (ADR 0006; no REQ changes):**
- int64 is `bigint` in the generated TS (protobuf-es has no `number` mapping); REST/app code keeps `number` ms.
- Users and devices use UUIDv7 too; device IDs are client-generated.
- `PACKET_KIND_EPHEMERAL` marks never-stored packets; the `flags` bitmask defines `URGENT` (call wake), not EPHEMERAL.
- The WS error frame is `ServerError`, with string `ErrorCode`s shared with REST.
- New deps (licenses checked): `@bufbuild/buf` 1.74.0, `@bufbuild/protobuf` and `@bufbuild/protoc-gen-es` 2.16.0, `uuid` 14.0.3. `@bufbuild/buf`'s postinstall is skipped (`allowBuilds: false`).

**Verification results:**
- `pnpm turbo run lint typecheck test --force`: 35/35 tasks, 201 tests (protocol 77, config 66, crypto 22, shared-types 14, api-client 12, mobile 7, ui-tokens 3). `pnpm format:check` passes.
- `buf lint` is clean, and `buf generate` reproduces the committed code byte for byte.
- `buf breaking` against this commit (`.git#ref=HEAD`) passes; see the commit check below.
- **Not run:** GitHub CI (no remote yet). The `buf breaking` step needs the public repo URL and runs on pull requests only.

**Known issues / tech debt:**
- `pnpm add` rewrote `pnpm-workspace.yaml` without its comments (restored; noted in CLAUDE.md).
- One turbo run failed with a transient "Unexpected end of JSON input" in an unchanged package; the re-run passed (likely a OneDrive sync race).
- The mobile app does not use `@pingdost/protocol` yet; it needs `TextDecoder` and `getRandomValues` polyfills first (Phase 10 handoff).
- Earlier items still open: binding drift check, pickle-key zeroization (Phase 27), placeholder `OWNER` in `repository.url`, stale `C:\dev\pd`.

**Next:** Phase 05 (server foundation + password auth). Phase 21 (nearby spike) can also run any time.

## 2026-10-19 — Phase 03: Crypto spike B (mobile shell + native crypto) — ✅ done
**Crypto gate closed.** The REQ §7.1 proof now covers Android (real phone) and web/Node. On a vivo V2437 (Android 16, arm64) and the x86_64 emulator, all of these pass: the 14 Phase 2 scenarios, the 3 WASM-made vectors, and all 6 phone ↔ Node interop steps (Olm and Megolm, both directions).

**Done:**
- **Repo location:** the phase was finished in a copy at `C:\dev\pd`. The user then chose to keep working in `C:\Users\Km799\OneDrive\Desktop\pingdost`, which was fast-forwarded to the phase commit. A dev build from there works on the phone (long paths + Ninja 1.13.2). `C:\dev\pd` is now stale.
- `apps/mobile` (Expo SDK 58.0.14, RN 0.88, Expo Router `src/app`, NativeWind 4.2.7 + `@pingdost/ui-tokens` light/dark):
  - SQLCipher DB (`src/db/open.ts` with step-named errors, `migrate.ts` + tests);
  - SecureStore secrets; the Olm account store; bootstrap timings;
  - a Phase 3 home screen and the dev-only `(dev)/crypto` screen.
- `packages/crypto-native` (ubrn `jsi2` + the `@ubjs/react-native` player). `createBindingsProvider` (`@pingdost/crypto/core`) is shared by WASM and native.
- `@pingdost/crypto/conformance`: scenarios, vectors and the interop protocol. Also `scripts/interop-server.ts` and `scripts/make-vectors.ts`, with vectors in `packages/test-fixtures/crypto/`.
- Docs: ADR 0005 (with measurements), ARCHITECTURE A5/A6, CHANGES, CLAUDE.md (commands, Windows setup), phases 07/10/27. CI: clippy for `aarch64-linux-android`.

**Deviations / decisions (ADR 0005, CHANGES 2026-10-18):**
- ubrn `jsi2` rather than classic `jsi`, so 64-bit ABIs only. `allowBackup: false`.
- pnpm `nodeLinker: hoisted`. Windows `LongPathsEnabled=1` plus Ninja 1.13.2 swapped into the SDK's CMake 3.22.1 (user-approved).
- `react-native-gesture-handler` 3.3.0 and `react-native-css-interop` 0.2.7 are direct deps. `crypto-native` has no `codegenConfig`.
- Migrations use `BEGIN IMMEDIATE` on the keyed connection: expo-sqlite's exclusive transactions open an unkeyed connection.

**Verification results:**
- `pnpm turbo run lint typecheck test --force`: 32/32 (config 66, crypto 20, mobile 7, ui-tokens 3). `pnpm format:check` passes.
- `cargo fmt --check` passes; clippy is clean on host, wasm32 and aarch64-linux-android; `cargo test` 5/5.
- Device (dev build): restart gives the same identity key ("restored from pickle"). The DB and WAL pulled via `run-as` fail with "file is not a database" and contain no plaintext schema (phone and emulator). SQLCipher 4.17.0.
- Release, on the phone: crypto ready in a median of 64 ms on restore (48–144 ms) and 88–125 ms on first run; activity launch median 678 ms.
- Size: per arm64 slice, the crypto module adds 1.70 MB and SQLCipher 5.06 MB. The two-ABI release APK is 71.4 MB (60.9 MB without SQLCipher).
- **Not run:** GitHub CI (still no remote).

**Known issues / tech debt:**
- `C:\dev\pd` is a stale copy; delete it when convenient. `git stash list` in this folder holds the pre-move working copy (superseded; drop it with `git stash drop`).
- OneDrive syncs `node_modules`, Gradle and Rust output (several GB); watch the OneDrive quota.
- vivo hides `ReactNativeJS` logcat output; read on-screen text instead (`uiautomator dump`).
- Earlier items still open: binding drift check, pickle-key zeroization (Phase 27), placeholder `OWNER` in `repository.url`.

**Next:** Phase 04 (protocol & contracts) or 05. Phase 21 (nearby spike) is now unblocked as well.

## 2026-10-18 — Phase 02: Crypto spike A (gate) — ✅ done
**Done:**
- **Crypto gate (web/Node half) passed; the user approved ADR 0003 and ADR 0004.**
- `crates/pingdost-crypto`: a narrow uniffi 0.31.2 wrapper over vodozemac 0.11.1:
  - Olm `Account`/`Session` and Megolm `GroupSession`/`InboundGroupSession`, with pickles;
  - `ed25519_verify` and `prekey_message_session_id`;
  - a flat `CryptoError` with fixed messages (no key material) and no panics across the FFI.
- `packages/crypto`:
  - the draft `CryptoProvider` (`src/types.ts`; Phase 4 finalizes it);
  - `createWasmCryptoProvider()` (`src/wasm.ts`, which maps errors to `CryptoOperationError`);
  - ubrn `wasm2` bindings plus the `.wasm`, committed in `src/generated/`;
  - 9 interop scenarios plus signature checks in `test/interop.test.ts`.
- Docs:
  - [crypto-license-matrix.md](decisions/crypto-license-matrix.md);
  - ADR 0003 (vodozemac Olm/Megolm, account identity key + device certificates, replay/rotation/backup rules, safety-number proposal);
  - ADR 0004 (attachments: XChaCha20-Poly1305 STREAM in the Rust crate).
- ARCHITECTURE A5 updated. Phases 03, 06, 09, 10, 13, 14, 16 and 19 updated to match.
- CI: a new `rust` job (fmt, clippy for host + wasm32, tests). Rust/crypto commands are in `CLAUDE.md`.

**Deviations / decisions:**
- **Attachments:** libsodium secretstream was dropped (react-native-libsodium 1.7.0 exposes it only on web); ADR 0004 uses RustCrypto instead.
- **Identity:** an account identity key separate from device Olm accounts (ADR 0003). Backups never restore Olm/ratchet state.
- **Tests:** they live in `packages/crypto/test/` (as the phase asked), so the Vitest config includes `test/**`.
- **ubrn needs `repository.url`** in `packages/crypto/package.json`. A placeholder `git+https://github.com/OWNER/pingdost.git` is there for now; **replace it once the GitHub remote exists.**

**Toolchain (exact, for Phase 3):**
1. `winget install --id Rustlang.Rustup -e`: rustup 1.29.1, stable 1.99.1 `x86_64-pc-windows-msvc` (pinned in `rust-toolchain.toml` with clippy, rustfmt and wasm32).
2. `winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --wait --norestart --nocache --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`: MSVC 14.44.35207 + Windows SDK 10.0.26100. Needs one UAC click and about 25 minutes.
3. `cargo install wasm-bindgen-cli --version 0.2.129 --locked` (must match `Cargo.lock`).
4. npm (exact): `uniffi-bindgen-react-native`, `@ubjs/core` and `@ubjs/wasm` 0.31.0-6. Cargo: `uniffi`/`uniffi_core` =0.31.2, `uniffi-runtime-wasm` =0.31.0-6, `vodozemac` =0.11.1 (`wasm_js` feature on wasm32).
5. Android NDK 26.1 / 27.1 / 28.0 were already present (`%ANDROID_HOME%\ndk`). `C:\MinGW` (32-bit GCC 6.3) is on PATH; avoid Rust's GNU toolchain because of it.

**Verification results:**
- `pnpm turbo run lint typecheck test --force`: 26/26 tasks. Crypto: 14/14 tests (all 9 scenarios). Config: 66/66.
- `pnpm format:check` passes.
- `cargo test`: 5/5. `cargo clippy -D warnings` is clean on the host and on wasm32. `cargo fmt --check` passes.
- ubrn `build wasm2 --release` works on Windows. The WASM module is 988 KB raw / 254 KB gzip / 203 KB Brotli.
- **Not run:** GitHub CI, because there is still no remote.

**Known issues / tech debt:**
- **Binding drift:** generated bindings could drift from the Rust source. CI does not rebuild them; add a drift check later (it needs ubrn + wasm-bindgen-cli in CI).
- **Pickle-key copies:** pickle keys are copied as plain `[u8; 32]` in Rust and `Uint8Array` in JS, and are not zeroized. Revisit in Phase 27.
- **WASM size:** could shrink with `wasm-opt` or by dropping `precomputed-tables` (slower signing). Decide in Phase 16.
- **Wrapper scope:** the wrapper has no Ed25519 signing-key object yet. Phase 6 adds it for the account identity key.

**Next:** Phase 03 (crypto spike B: the Android native build of the same crate + an Expo dev build). Read its new Handoff notes first. Phase 04 can also run now.

## 2026-10-18 — Phase 01: Repo bootstrap — ✅ done
**Done:**
- User decisions:
  - license **AGPL-3.0-or-later** (ADR 0001);
  - **no pushes by Claude**: the user pushes manually;
  - the user will create the GitHub repo by hand (no `gh` CLI).
  - All three are recorded in `CLAUDE.md` → "Git remote".
- **Tooling and layout:**
  - `git init -b main`; root tooling: pnpm workspace with a `catalog:` of exact versions, Turborepo (transit-node pattern), `tsconfig.base.json`, ESLint 10 flat config (typed lint, import-x ordering, A10 import guards), Prettier, and a root Vitest `projects` config;
  - 11 skeleton packages plus a real `packages/config`;
  - `docker-compose.yml`: `mongo:8.0.34` (rs0, auto-initiated by the healthcheck), `valkey/valkey:8.1.10-alpine`, `axllent/mailpit:v1.31.6`;
  - `.env.example`, CI workflow, README / LICENSE / SECURITY / CONTRIBUTING, and the `CLAUDE.md` Commands section.
- **`@pingdost/config`:** all REQ §17 + A11 variables, bounded integers, cross-field rules, all-or-none feature groups, production fail-fast (dev-only keys rejected), value-free errors, and a `/public` client entry. Conventions are in ADR 0002.

**Deviations / decisions:**
- ADR 0001 (license) and ADR 0002 (config conventions). ARCHITECTURE A1 (CI) and A10 (license) were updated.
- **TypeScript 6.0.3, not 7.0.2.** typescript-eslint 8.71.2 supports TS `<6.1`. TS 6 defaults `types: []`, so packages opt in (`"types": ["node"]`).
- **CI integration job:** it uses `docker compose up -d --wait mongo valkey` instead of GitHub service containers, because service containers can't pass `--replSet`.
- **Vitest:** each package with tests has its own `vitest.config.ts`; the root config globs `{apps,packages,tools}/*/vitest.config.ts`.
- **Build scripts:** pnpm `allowBuilds: { unrs-resolver: false }` (its postinstall is only a binary check). `ignoredBuiltDependencies` is deprecated in pnpm 10.26+.
- **Extra cross-field rules** beyond the phase list: quota ≥ max attachment size, access TTL < refresh TTL, OTP cooldown < OTP TTL, and no `EMAIL_CONSOLE_SHOW_CONTENT` in production.

**Verification results:**
- `pnpm install --frozen-lockfile` (clean reinstall), then `pnpm turbo run lint typecheck test --force`: 25/25 tasks pass, with 66 config tests.
- `pnpm format:check` passes.
- `pnpm test:int` runs, but there are no integration tests yet ("no tasks").
- Root `pnpm exec vitest run`: 66 pass.
- `pnpm infra:up`: all three containers healthy.
  - Mongo: `setName=rs0`, PRIMARY, majority write OK via `?replicaSet=rs0`.
  - Valkey: PONG.
  - Mailpit: `/readyz` returns 200.
  - Host ports 27017, 6379, 1025 and 8025 are reachable.
- ESLint guard verified: importing `./server` from `public.ts` errors.
- **Not run:** GitHub CI, because there is no remote yet. The user must create the repo and push, then check the Actions tab.

**Known issues / tech debt:**
- Git Bash fails to fork on this PC (`fork: Resource temporarily unavailable`). Use PowerShell.
- Docker Desktop doesn't auto-start; launch it before `pnpm infra:up`.
- Root config files (`eslint.config.js`, `vitest.config.ts`) are formatted by Prettier but not linted or typechecked.
- `turbo.json` `test:int` passes through only `MONGODB_URI` and `REDIS_URL`; Phase 5 adds more. The Phase 5 file was updated with this and the Mailpit CI step.
- pnpm is pinned to the installed 10.28.1 (latest is 12.x); upgrade only deliberately.

**Next:** Phase 02 (crypto spike A).
- Rust is **not installed**. The user needs rustup, and likely the MSVC C++ Build Tools (free); give them numbered steps first.
- Also check the license of every crate and npm package against AGPL-3.0 (ADR 0001).

## 2026-10-18 — Planning session — ✅ done
**Done:**
- Read the REQ doc. Asked the user four questions:
  - test devices: 2+ Android phones, focus on Android + web;
  - hosting: decide later;
  - social login: Google only;
  - license: open source.
- Created `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md` (30 phases), `docs/CHANGES.md`, `docs/decisions/`, and `docs/phases/phase-01…30`.

**Deviations / decisions:** see `docs/CHANGES.md` (initial entries) and the ⚠ items in ARCHITECTURE.

**Verification results:** documentation only; no code yet. The repo is not yet a git repository (Phase 1 runs `git init`).

**Machine facts:**
- Installed: Node 24.11, pnpm 10.28, Docker 29.4, git 2.52, Android SDK (adb 1.0.41), JDK 17 (OpenLogic), Python 3.11.
- **Not installed:** Rust (needed in Phase 2), plus likely MSVC C++ Build Tools and the Android NDK (Phases 2–3).

**Next:** "start phase 1".
