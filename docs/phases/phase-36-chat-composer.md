# Phase 36 — Chat composer: emoji picker, keyboard, scrolling

**Goal:** typing a message is comfortable: the composer sits right on the keyboard, an emoji picker is one tap away, sending jumps to the newest message, and a "new messages" pill appears while reading older ones.

**Depends on:** 34 (the keyboard library decision), 35 (the bubble and list changes). User request 2026-11-10 (CHANGES; items 16–19 of `prompts/UI_modifications.txt`).

**Read first:** ADR 0035. Code: the chat screen and composer (`apps/mobile/src/screens/chats/chat.tsx`, `src/app/(app)/chat/[conversationId].tsx`), web `features/chats/chat-view.tsx`.

## Tasks
- [x] **Composer on the keyboard (item 19), first, since the rest builds on the layout:** no gap between the composer and the keyboard, on both phone models, with gesture and three-button navigation. The likely cause is a double inset (the edge-to-edge window resize plus a `KeyboardAvoidingView` or a bottom safe-area pad). Use the library chosen in Phase 34. The reply bar, attachment bar and voice recorder move with the composer.
- [x] **Emoji picker (item 16):** an emoji button in the composer switches between the keyboard and an emoji panel of the keyboard's height: categories, search, skin tone, and recents kept on the device only. Inserts at the cursor. Check candidates' license and current version first (for example `rn-emoji-keyboard`, or `emojibase-data` with our own grid); hide emoji newer than the system font can draw. Web: the same panel from the same data, opened by a button beside the input; Escape closes it.
- [x] **Jump on send (item 17):** sending (the button, or Enter on the web or a hardware keyboard) scrolls to the newest message, even when the user was reading older ones.
- [x] **New-message pill (item 18):** while scrolled away from the newest message, incoming messages show a pill above the composer ("2 new messages" with a down arrow, announced to screen readers). A tap scrolls down and clears it; reaching the bottom clears it too. At the bottom, new messages keep scrolling into view as now.
- [x] **Web:** items 16–18.

## Done when
- [x] Mobile and web unit tests (pure helpers for "at the bottom" and the pill count have tests), lint and typecheck pass.
- [ ] On both phones (a new build if a native dependency was added): the composer on the keyboard (with a reply open, text size Huge); emoji panel ↔ keyboard; send while scrolled up; the pill with the sim peer's echoes.
- [x] Web in Chrome: the emoji panel, Enter to send while scrolled up, the pill.

## Handoff notes
- From Phases 34–35: `react-native-keyboard-controller` 1.22.7 is installed and `KeyboardProvider` wraps the app (ADR 0039). It also offers `KeyboardChatScrollView` and `KeyboardStickyView` for the composer. The chat screen still uses React Native's `KeyboardAvoidingView` (`chat.tsx`).
- On the Pixel 8 emulator (Android 15, gesture navigation) with the new build, the composer sat about 60 px above the keyboard: close, not the large gap seen on the user's phones. Compare on both real phones before changing it.
- 2026-11-11 (ADR 0040): built without a native dependency (no new build needed). `emojibase-data` 18.0.0 drives both pickers through `@pingdost/chat-core/emoji`; scroll helpers are in `@pingdost/chat-core` (`isAtEnd`, `newestMark`, `unseenCount`, `unseenLabel`).
  - Phone: `KeyboardAvoidingView` is gone; `BottomSpace` in `chat.tsx` is `max(nav bar, keyboard, panel reserve)`. The panel is `src/screens/chats/emoji-panel.tsx`, recents in `src/emoji/store.ts`.
  - Web: `features/chats/emoji-panel.tsx` and `emoji-data.ts`.
  - Pixel 8 emulator (Android 15, gesture navigation): no gap above the keyboard; the panel replaces the keyboard at the same height; emoji go in at the caret. Not checked there: Keyboard ↔ panel back (Gboard on the emulator switched to its hardware-keyboard toolbar; the switch now blurs and refocuses the field), the pill (the test chat was too short), three-button navigation, text size Huge, a reply open.
  - Open: the phone row of "Done when" on the Nothing and the vivo.
  - Enter-to-send on a phone's hardware keyboard was not added (ADR 0040).
