# Phase 35 — Chat look: titles, new-chat button, message times, bubbles, deleted messages, big emoji

**Goal:** chats read cleanly: smaller screen titles, a floating "+" above a full-width tab bar, a time and state on every message, bubbles at most 80% wide with the time beside short text, "This message was deleted" at once, and a single emoji shown large.

**Depends on:** 11, 17, 31 (🔄: the code this phase changes is in place; their open items are device checks). User request 2026-11-10 (CHANGES; items 6, 7, 12–15 of `prompts/UI_modifications.txt`).

**Read first:** ADR 0035, ADR 0014 (edit and delete ops); ARCHITECTURE A10 (message states). Code: `apps/mobile/src/screens/chats/` (chat screen, bubbles), the tab layout `src/app/(app)/(tabs)/_layout.tsx`, web `features/chats/bubble.tsx` and `chat-view.tsx`.

## Tasks
- [x] **Titles (item 6):** `TabHeader` (Chats, Calls, Settings) from `text-4xl` to `text-3xl` (36 → 30 dp before the text-size setting). Sub-screens keep their native header titles; the web's headers were already small.
- [x] **"+" button (item 7):** on Chats it floats above the tab bar at the bottom right (inside the bar's container, so Android still delivers its taps), and the bar spans the full width on every tab. 56 dp (was 64). It bounces in each time Chats is shown (keyframes 0.3 → 1.14 → 0.94 → 1.03 → 1; a fade under Calm, nothing under Off) and keeps the press scale and haptic. The chat list's bottom padding grew by the button (`useTabBarInset({ newButton })`).
- [x] **Time and state on every message (item 12):** phone and web; runs of messages still merge corners and names, never times or states.
- [x] **Bubble layout (item 13):** at most 80% of the screen (phone, `mx-3 max-w-[80%]`) or the message column (web). Time, "edited", unusual states and the tick sit at the bottom right, on the last line when they fit, otherwise on their own line below (ADR 0039: an invisible spacer, no measuring). `text-xs` and muted as before. Right-to-left text, a big emoji and media without a caption put the time under the content; the time is not drawn over pictures (left for later).
- [x] **Deleted at once (item 14):** the engine emits the tombstone as a `message` event and both apps merge it, so the data was right. On the phone, `SwipeAction` switched to a different tree when the row lost its swipe action (a deleted message cannot be replied to); the bubble mounted again inside its recycled FlashList cell and stayed empty until the chat was reopened. It now keeps the same tree. **Confirmed on the emulator:** with the old line put back, a message deleted for everyone left an empty gap; with the fix it turned into "You deleted this message" at once. The web was not affected (checked in Chrome).
- [x] **Big single emoji (item 15):** `isBigEmoji` in `chat-core` now matches exactly one emoji (flags, keycaps, skin tones, tag flags, ZWJ sequences); two or more show at normal size in a bubble. Tests; both apps use it; the large size follows the text-size setting.
- [x] **Web:** items 12, 13 and 15 (the web shares `isBigEmoji`).

## Done when
- [x] chat-core, mobile and web unit tests, lint and typecheck pass (ui-tokens unchanged).
- [ ] On a phone with the sim peer (`!delete` makes it delete its echo for everyone): times and states on every message; short and long messages; delete for everyone from both sides while the chat is open; one emoji and two emoji; the "+" bounce with Motion On, Calm and Off; text sizes Large and Huge.
  - 2026-11-10, **emulator** (Pixel 8, Android 15) with the sim peer: passed:
    - Chats title one step smaller; the "+" above a full-width tab bar, its menu's close button exactly over it;
    - a time on every message, "hi 2:52 AM ✓✓" on one line, long messages with the time at the end of the last line; bubbles 80% of the screen;
    - the peer's echo deleted for everyone and the user's own message deleted for everyone both turned into the placeholder at once (the second also confirmed the cause, above);
    - one 😂 large with the time and ticks under it.
  - Fixed during the check: the spacer showed as visible text on Android, because a nested span's colour `transparent` (0) counts as unset under Fabric; it is now `#FFFFFF01`.
  - **Open:** the two real phones; several emoji in one message on the phone (unit-tested, seen on the web); the bounce at each Motion level; text sizes Large and Huge.
- [x] Web in Chrome (against the sim peer): every message with its time; "hi" with the time beside it; a long message with the time at the end of its last line; bubbles 80% of the column; 🔥 large with the time under it; 😂😂😂 normal size in a bubble; the peer's `!delete` turned its echo into "This message was deleted" at once, and the chat list preview followed.

## Handoff notes
- Times are not drawn over pictures yet (the time sits under media without a caption).
- The tick room on the phone is six no-break spaces at the time's size, an approximation; with a very large text size the time may sit a little left of the spacer's end, never over the text.
