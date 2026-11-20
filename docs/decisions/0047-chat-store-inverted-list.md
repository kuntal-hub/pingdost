# 0047 — Every chat in an in-memory store, an inverted FlatList, lighter bubbles; calls set up by themselves in dev

- **Status:** Accepted
- **Date:** 2026-11-20
- **Phase:** none (fixes after Phase 40, reported by the user)
- **Approved by user:** n.a. (the user asked for the store and suggested FlatList)

## Context
The user reported, after ADR 0046:
1. A chat still took a second or more to open in the dev build. The newest messages showed at once and the rest a moment later, so the app felt stuck. They asked for a Redux-like store: read every chat from the local database when the app opens and render chats from it, perhaps with FlatList.
2. Video calls between the web (Chrome on the PC) and the vivo (dev build, on USB) still failed.

Findings (vivo V2437, dev build unless noted):
- **(1)** The messages were already in memory on the first render (ADR 0046's cache). React's `Profiler` on the chat screen showed the time went into drawing:
  - FlashList drew a chat in three passes of 70–80 ms each after the screen mounted;
  - the composer took ~65 ms to mount;
  - three or four later updates redrew every bubble (60–110 ms each), mostly because `people` (group names) changed identity after opening;
  - a chat of 9 items took ~730 ms from tap to drawn, so message count was not the cause.
  - Inside a bubble: the SVG state tick ~5 ms, each `Text` 2–3 ms, each NativeWind `className` element 1–2 ms. Plain rows in place of bubbles mounted a screenful in ~70 ms against ~350 ms.
- **(2)** With coturn running and `adb reverse tcp:3478`, a video call from a headless peer on the PC to the vivo connected in 218 ms through the relay ("Relayed (TURN), forced"). The vivo has Force relay on, and it is the PC's hotspot, so every call needs the relay. When the user called, Docker (and so coturn) was not running and the port was not forwarded. Both were manual steps.

## Options considered
| Option | Pros | Cons | License | Cost |
|---|---|---|---|---|
| Redux Toolkit store | what the user named | a new dependency; the app already uses Zustand for its stores | MIT | 0 |
| **Zustand store (already used)** | same model (one store, selectors); no new dependency | — | MIT | 0 |
| Keep FlashList (patched, staged first frame) | virtualized | three layout passes; partial first frame; a patch to maintain | MIT | 0 |
| **Inverted FlatList** | the newest screenful in the screen's first frame; no measuring passes; no patch | renders a fixed number of items first | MIT | 0 |
| Bubbles keep `className` and `@/components/text` | one styling path | their per-element work is most of a bubble's cost | — | 0 |
| **Bubbles draw with precomputed styles and RN `Text`; ticks as views** | several times cheaper | a second styling path inside the bubble; the tick is drawn, not Lucide's SVG | — | 0 |
| Dev calls: document the steps (as in 0046) | nothing to build | forgotten, as happened | — | 0 |
| **Dev calls: `infra:up` starts coturn; Metro's start runs `adb reverse`** | works without remembering | coturn runs in every dev session | coturn BSD | 0 |

## Decision
1. **Chat store** (`apps/mobile/src/engine/chat-store.ts`, Zustand):
   - When the signed-in app opens (`(app)/_layout.tsx`), it reads the chat list, then every chat's newest page (50 messages), six chats per step with frames in between, unread chats first.
   - The engine's events keep it current: `subscribeAll` (messages, deletions, typing) and `onConversationListChanged` (the list, re-read, with unchanged rows kept as the same objects).
   - A chat deleted from the phone leaves the store with its conversation. Sign-out clears it.
   - Screens render from it: the chat list (`useConversations`), the chat (`useConversation`, `useConversationRecord`) and Forward. There is no read of the database when a chat opens. A chat the background read has not reached yet is read as the finger lands on its row (`ensureThread`).
   - Older pages load on scrolling up and are dropped when the chat is left (`releaseThread`).
   - Thread changes are pure functions in `thread.ts`, unit-tested: newest first, unchanged records kept, no gaps (an event for a message older than the loaded page is left for that page).
   - Replaces ADR 0046's page cache (`warmChats`, `page-merge.ts`) and its re-read 600 ms after opening.
2. **Chat list** (`chat.tsx`): an inverted `FlatList`.
   - `initialNumToRender` 14, so the screen's first frame already has a screenful of the newest messages; the rest follow in batches of 8.
   - Scroll position: `maintainVisibleContentPosition` keeps a reader's place, and within 160 px of the newest message a new one scrolls into view. Older pages load on `onEndReached`.
   - The empty state is drawn over the list. A jump to an undrawn message retries via `onScrollToIndexFailed`.
   - ADR 0046's FlashList patch and the "newest 8 first" staging are removed.
3. **Bubbles:**
   - The usual text bubble draws with styles made once per screen (`useBubbleLook`, with fonts from `useTextStyles` in `@/components/text`, so the user's font and text size still apply) and React Native's `Text`.
   - Only a message that just arrived uses an animated view.
   - Names (`people`, `names`) count for a bubble's redraw only where it shows them.
   - Deleted, big-emoji, forwarded and group-sender parts keep the shared components.
4. **State ticks** (`state-tick.tsx`): sent, delivered and read are drawn as the borders of turned views in the shapes of Lucide's `check` and `check-check`, colors unchanged (ADR 0046). Pending, failed and expired keep their Lucide icons.
5. **Dev calls:**
   - `pnpm infra:up` / `infra:down` include the `calls` profile (coturn); CI starts its services explicitly and is unchanged.
   - `pnpm --filter @pingdost/mobile start` and `android` first run `scripts/adb-reverse.mjs`: `adb reverse` for 3000, 8081 and 3478 on every attached device.
   - The local `apps/mobile/.env` points at `127.0.0.1`, so a USB phone keeps working when the PC's Wi-Fi address changes.

### Follow-up the same day: opening the screen itself
The user found messages instant, but a chat still took about a second to open. The store already held every chat; what remained was the screen and its transition. Changes:
- **Transition:** pushed screens use `animation: 'ios_from_right'` (200 ms, Android's short animation time). Android 13+'s default stack transition is 450 ms and starts only after the first frame. Modals and the call screen keep the default.
- **No second render before the first frame:** `useFocusEffect` redraws its caller once navigation settles after a push, which drew the whole chat a second time (~55 ms in dev). The chat's three focus effects now live in `FocusEffect` children. `ChatScreen` and `Composer` are `memo`.
- **`router` instead of `useRouter()`** in the chat, its bubbles and the chat list: expo-router's routing-queue context gives every `useRouter()` user a new value when a navigation starts or ends, so each tap redrew every chat row.
- **Header height:** starts at its measured value (top inset + 64), not a guess, so measuring it no longer redraws the screen.
- **Time labels:** `timeLabel` / `dayLabel` (`@pingdost/chat-core`) reuse `Intl.DateTimeFormat`s. `toLocaleTimeString` cost ~1 ms per call on the vivo, twice per bubble; a reused formatter costs 0.08 ms.
- **Measured but not worth changing:** `SwipeAction`'s animated view and `Tap`'s Reanimated pressable (no measurable gain without them).
- **Look (the user's request), phone and web:**
  - phone: 4 px between messages in a run, 10 px where the sender changes (was 2 / 8); web: 4 px in a run (2 px compact; was 2 / 1), 12 px where the sender changes as before;
  - 16 px under the newest message (phone was 8; web had none: a Virtuoso `Footer`);
  - message times one step smaller: a new `2xs` type step (11/14) in `typeScale`, for bubble times only; on the web `--text-2xs` in `styles.css` (rem, so it follows the text size setting).
  - First done on the phone only; the user asked for every UI change on both platforms.

## Consequences
- Memory: every chat's newest page. About 50 KB per chat: ~5 MB for 100 chats.
- Opening the app reads every chat once, in the background.
- Inside the bubble, styles live in `bubbleLayout` / `useBubbleLook`, not class names. Keep them in step with the design tokens (`spacing`, the palette) when the bubble's look changes.
- The drawn ticks have square ends where Lucide's are round; at 14 px this does not show.
- Dev builds stay several times slower than release: React's dev checks and Hermes compiling from source. Judge speed with a release build or `expo start --no-dev --minify`.

## Evidence
Vivo V2437, `[chat-open]` timings from tap (2026-11-19/20):
- Before (FlashList, staged): screen mounted at +264 ms with no messages; messages drawn by +730 ms (9 items); later updates redrew every bubble.
- FlatList, bubbles unchanged: list mount ~350 ms for 14 bubbles; content at ~690 ms.
- FlatList + lighter bubbles, dev build: content at ~600–620 ms. Production bundle on the same dev client (`--no-dev --minify`): drawn at **250–310 ms** (830 ms for the first chat after launch, while Hermes compiles the screen from source; a release build ships bytecode).
- After the follow-up: dev build drawn at ~495–550 ms. Production bundle **185–255 ms**, 600 ms for the first chat after launch. Then a 200 ms slide instead of 450 ms.
- Unit tests: `thread.test.ts` (8). Mobile: 30 files, 203 tests; typecheck and lint clean.
- Call: headless peer (werift, on the PC) → vivo video call, connected 218 ms after answering, "Relayed (TURN), forced".
