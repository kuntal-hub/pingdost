# 0040 — Chat composer: emoji panel, keyboard space, new-message pill

- **Status:** Accepted
- **Date:** 2026-11-11
- **Phase:** 36
- **Approved by user:** n.a.

## Context
Items 16–19 of the user's UI list (CHANGES 2026-11-10): an emoji picker, the composer directly on the keyboard, a jump to the newest message on send, and a "new messages" pill. ADR 0039 put `react-native-keyboard-controller` 1.22.7 in the app; the chat screen still used React Native's `KeyboardAvoidingView`, and the composer added the navigation bar's inset under itself. On the Pixel 8 emulator that left about 60 px between the composer and the keyboard.

## Options considered
| Option | Pros | Cons | License | Cost |
|---|---|---|---|---|
| `rn-emoji-keyboard` 1.7.0 | Ready-made picker | Phone only (the web would need another picker and data); its own modal sheet, not a panel of the keyboard's height; last release 2024-05 | MIT | Free |
| **`emojibase-data` 18.0.0 + our own grid** | One data set for both apps; Emoji 18 names and keywords; we control layout, version filtering and recents | We write the grid, search and tones | MIT (`emojibase` 18.0.0 for its types, dev only) | Free |
| Keep `KeyboardAvoidingView`, remove the bottom inset | Small change | Two measures of the keyboard still disagree on edge-to-edge Android; no way to hold the space while the emoji panel replaces the keyboard | — | — |
| `KeyboardChatScrollView` + `KeyboardStickyView` | The library's chat layout | Replaces FlashList's scroll view (start-from-bottom, older pages) | MIT | Free |
| **One bottom space driven by the keyboard's height** | One measure: `max(nav bar, keyboard, panel)`; the panel keeps the space while the keyboard goes and comes | Our own code (small) | — | — |

## Decision
- **Emoji data:** `emojibase-data` 18.0.0 `en/data.json` (0.8 MB), loaded on first use with a dynamic import. Shared helpers in `@pingdost/chat-core/emoji`: categories (emojibase groups; components and loose regional letters left out), search (exact name, whole name words, name prefix, word prefixes, then keywords; shorter names first among equals), single skin tones, `insertAt`, `deleteBefore` (a whole emoji with its joins, tones and flag pairs; `Intl.Segmenter` where it exists, a code-point walk on Hermes), recents ordering.
- **Emoji newer than the font are hidden.** Android: by API level (React Native's text uses the system font, no EmojiCompat): 36 → Emoji 16, 35 → 15.1, 34 → 15, 33 → 14, 31–32 → 13.1, 30 → 13. The web tests one emoji of each version on a canvas: colour pixels, and a joined sequence no wider than 1.6 emoji.
- **Recents and the skin tone stay on the device:** `emoji.json` in the phone's documents (deleted with the rest by `wipe.ts`), `pd.emoji.v1` in the browser's localStorage (deleted when the browser is unlinked). At most 32 recents.
- **Phone layout:** the chat no longer uses `KeyboardAvoidingView`. Under the composer sits one space of height `max(navigation bar, keyboard, panel reserve)`, from `useKeyboardHandler` (the keyboard's height from the screen's edge, since `KeyboardProvider` runs edge to edge). The emoji panel takes the last keyboard height seen (else 36% of the window, 260–380 dp, plus the navigation bar). Keyboard → panel: `KeyboardController.dismiss({ keepFocus: true })` with the space held. Panel → keyboard: blur and focus the field, with the space held until `keyboardDidShow`. Search shrinks the panel to a strip above the keyboard. Back closes search, then the panel.
- **Web:** the same data in a panel above the composer, opened by the button beside the field; Escape or a click outside closes it and puts the caret back. Arrow keys move through the grid (one tab stop).
- **Scrolling:** "at the end" is within 20% of the viewport on the phone (where FlashList itself follows new rows) and 40 px on the web. Leaving the end remembers the newest message; incoming messages after it (not one's own, not notices) are the pill's count. Sending jumps to the end, also once the sent row is in the list. The pill is a live region on both.

## Consequences
- No native dependency: no new build is needed for Phase 36.
- Enter-to-send on a phone's hardware keyboard was not added: Android cannot tell it from the soft keyboard's Enter, which must stay a new line. Every send, however made, jumps to the end.
- Item 40 (voice notes by gesture) builds on this composer.

## Evidence
- `npm view` on 2026-11-10: `emojibase-data` 18.0.0 (MIT, published 2026-10-16), `emojibase` 18.0.0 (MIT), `rn-emoji-keyboard` 1.7.0 (MIT, 2024-05-09). `pnpm licenses:check` passes.
- Pixel 8 emulator (Android 15, gesture navigation), 2026-11-11: the composer sits on the keyboard with only its own 6 dp padding; the emoji panel replaces the keyboard at the same height without moving the composer; emoji go in at the caret.
- Chrome, 2026-11-10: panel, search with Enter, skin tone, recents, category tabs, Escape; send while scrolled up jumps to the end; the pill showed "1 new message" and cleared on tap.
