# 0046 — Chats from memory, a colored "read" tick, and calls with no direct path

- **Status:** Accepted
- **Date:** 2026-11-17
- **Phase:** none (fixes after Phase 40, reported by the user)
- **Approved by user:** n.a. (bug fixes the user asked for)

## Context
The user reported:
1. A chat still took 1–1.5 s to open, although its messages are cached.
2. "Delivered" and "read" ticks were too alike: on a light brand fill, delivered was a faded dark gray and read a solid dark gray. On the web they were identical.
3. Every video call between the web and the phone failed ("The connection could not be made or was lost"), with Force relay off and on.
4. What "Force relay" is for.

Findings:
- **(1)** A dev-only log (`[chat-open]` in Metro) shows the cached chat's messages in its **first** render. The time after that is navigation and drawing (dev builds, the emulator under load: first render about 1 s after the tap). Two costs were real: the chat re-read its page from the store while opening and replaced every message with a new object, so every bubble rendered twice; and the cache filled only once the chat list rendered.
- **Found while checking (2):** a chat opened from memory never marked its messages read. `markRead` ran only when the message count changed, and a cached chat already has its count on the first frame (since ADR 0045). The sender then never saw "read". Seen on the emulator: "1 unread" after opening the chat.
- **(3)** The failed calls (web call history, 2026-11-17 21:48–21:59) were between Chrome on the PC and the user's account on the vivo V2437. That vivo **is the hotspot** the PC uses (its `ap0` 10.195.224.91 is the PC's gateway). WebRTC on Android gathers only on networks Android lists for apps (mobile data here), not on the hotspot interface, so the two sides have no direct path. The dev server had no TURN (`TURN_URLS` empty), so there was no relay either, and Force relay could never connect. The same failure shows on the emulator (behind its own NAT) against Chrome with Test media: "Connecting…", then failed.

## Options considered
| Option | Pros | Cons | License | Cost |
|---|---|---|---|---|
| Read tick: a darker or bolder shade of the same color | no new tokens | the reported problem | — | 0 |
| **Read tick: a color of its own per scheme (`read`, `on-primary-read`), checked in tests** | read at a glance in every scheme; contrast and difference are tested | two more tokens | — | 0 |
| Signal-style filled circles for read | no color needed | new icons, a new look | ISC (Lucide) | 0 |
| Calls: patch WebRTC to gather on the hotspot interface | direct calls on a hotspot | a native fork of libwebrtc | BSD | 0 |
| **Calls: relay through TURN when there is no direct path (dev coturn over `adb reverse`), and say why a call failed** | works today; production already has TURN on the VPS | dev needs coturn and a cable for a phone that is the hotspot | coturn BSD | 0 |

## Decision
1. **Chats from memory** (`apps/mobile/src/engine/hooks.ts`, `page-merge.ts`):
   - `warmChats` reads the recent chats (up to 64, unread first) as soon as the signed-in app renders (`(app)/_layout.tsx`), not in a headless push wake.
   - The chat list's conversation records are kept too, so the header has its name on the first frame.
   - A chat opened from a complete cached page checks the store 600 ms later instead of during its first frames. `mergeStorePage` keeps unchanged records as the same objects (memoized bubbles do not redraw) and returns the shown map itself when nothing changed.
   - `openTiming` logs `[chat-open] render / mounted / store read / list drawn` with times since the tap (dev builds only).
   - **Drawing (follow-up the same night):** the user still saw one message, then the rest 0.5–1 s later. A screen recording of the vivo (dev build), split into frames, showed why: every message was in memory from the first render, but FlashList 2.3.2 put its first render window at the **newest item's top** for a bottom-anchored list (`startRenderingFromBottom`). So it drew only that item, and drew the rest only after the clamped scroll event came back. Changes:
     - A pnpm patch (`patches/@shopify__flash-list@2.3.2.patch`, listed in `pnpm-workspace.yaml`) starts that window at the last screenful, clamped as the scroll view clamps it. `overrideProps.initialDrawBatchSize` 50 draws it in one pass instead of 2 items per pass. Drop the patch when upgrading FlashList.
     - The chat's first frame holds only the newest 8 timeline items; the rest of the page follows two frames later, prepended above them. Older pages are not loaded until then.
     - `SwipeAction` (bubbles and chat rows) is a plain `PanResponder` with RN `Animated`, and its action icon exists only during a swipe. A per-row gesture-handler pan with Reanimated styles was most of a bubble's cost: about 40 ms each in the dev build.
     - Vivo dev build, tap → content (10 fps recordings): before, the newest message at ~0.6 s and the rest at ~2 s. With the patch alone, nothing until 1.7 s. Now, the newest 8 at 0.6 s and the full page at 1.1–1.2 s. Bare text boxes in place of bubbles give 0.6 s / 0.9 s, so the rest is the screen itself (header, composer) in a dev build.
2. **Mark read on focus** (`chat.tsx`): `markSeen` runs when the chat gains focus and for each new message while it has focus.
3. **Read tick colors** (`@pingdost/ui-tokens`):
   - `on-primary-read` per scheme and mode: a blue on light fills, a bright cyan on dark fills, a deep color of another hue on mid-tone fills (Lagoon violet, Grape and Galaxy dark green, Cherry dark navy).
   - `read` on backgrounds: `#0A63D8` light, `#38BDF8` dark.
   - `DELIVERED_TICK_ALPHA` (0.55) is the faded `on-primary` of the other ticks; `mix` and `colorDistance` (CIE76 ΔE) are new helpers.
   - Tests: every scheme in every mode keeps the read tick ≥ 3:1 on both gradient ends and on the backgrounds, and ≥ 30 ΔE from the delivered tick.
   - Phone `StateTick`, web bubble and both Appearance previews use them.
4. **Call failures** (`@pingdost/call-engine`):
   - `offersRelay(iceServers)` tells a TURN server from STUN.
   - A call that never connects without an offered relay fails with `no_route` (not `connection`).
   - Force relay with no relay offered fails at once with `no_relay`, without opening media.
   - Phone and web show what each means. The Force relay descriptions now say what it does and that it needs a relay.
5. **Dev relay:** the root `.env` sets `TURN_URLS=turn:127.0.0.1:3478?transport=tcp` and the dev secret. Run coturn with `docker compose --profile calls up -d --wait`, and run `adb reverse tcp:3478 tcp:3478` for a phone on USB. Steps are in `docs/ops/run-on-devices.md` ("Calls").

## Consequences
- The chat page cache holds up to 64 chats × 50 messages in memory (about 3 MB).
- A phone that is its own hotspot can call the PC only through the relay. In production, the VPS coturn (ADR 0013) is reachable over mobile data, so this case is covered there.
- Calls that fail without a relay now say why. With a relay offered, a failure stays `connection`.
- Open: the opening time on the user's phones in a release build (`android:release`); dev builds and the loaded emulator here are much slower.
- Measuring a phone without logs: `adb shell screenrecord`, then `docker run --rm -v <dir>:/w linuxserver/ffmpeg:7.1.1 -i /w/rec.mp4 -vf fps=10 /w/f_%03d.png`. `screencap` in a loop is too heavy and slows the app it measures. The vivo stopped writing `ReactNativeJS` lines to logcat partway through.

## Evidence
- `pnpm turbo run typecheck lint test` for call-engine, mobile, web, server, sim-client and ui-tokens: 17/17 tasks. ui-tokens: 770 tests, including the new read-tick checks. call-engine: 3 new manager tests. mobile: `page-merge.test.ts`.
- Emulator dev build (`@pd_emu_p36`) ↔ Chrome (`@pd_nothing`, Test media), 2026-11-17:
  - With no TURN, the call answered and then hung on "Connecting…", the same failure.
  - With the dev relay, the video call connected both ways; the web showed "Relayed (TURN) · relay/relay · tcp · 2.2 MB" at 0:52.
  - Opening a cached chat: `render +987 ms items=5`, `mounted +1952 ms cached=true`, `list drawn +3892 ms`.
  - "1 unread" after opening before the focus fix; cleared after it, and the web's tick turned blue.
- The vivo's interfaces (`ip -4 addr`): `ccmni3` 100.125.195.108 (mobile data) and `ap0` 10.195.224.91 (hotspot), the PC's default gateway. The dev Mongo shows that account's active device as "vivo V2437".
