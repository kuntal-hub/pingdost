# Phase 31 — UI/UX refresh: "Pop" design system, configurable appearance

**Goal:** the whole UI of the phone and web apps, redone for Gen Z and Gen Alpha, away from the WhatsApp look: light and dark, several color schemes, user-configurable, animated, following standard guidelines, with icons instead of emoji.

**Depends on:** nothing pending. The user asked for this before finishing the open phases ("first refactor the UI/UX, then we will test the app and complete all pending phases").

**Read first:** ADR 0035, `CLAUDE.md` → "Design system".

## Tasks
- [x] `@pingdost/ui-tokens`: ten schemes (light, dark, pure black), appearance prefs and options, surfaces, bubble corners, wallpapers, type and motion scales; contrast tests.
- [x] `chat-core`: `attachmentType().kind` and `stateLabel().icon` in place of emoji and glyphs; `isBigEmoji`.
- [x] Phone foundation: appearance store, fonts, motion and haptics, `ThemeRoot`, themed `Text`/`TextInput`, Lucide `Icon`.
- [x] Phone primitives: `Tap`, `Button`, `IconButton`, `ListRow`, `ActionSheet` (drag to dismiss), `Toggle`, `Segmented`, `Chip`, `SwipeAction`, `Wallpaper`, `EmptyState`, `SkeletonRows`, `TypingDots`, `FloatingTabBar`, `BrandMark`.
- [x] Phone screens: welcome (with a theme picker), chat list (pinned strip, filters, swipe to pin or archive), chat (floating header and composer, grouped bubbles, swipe to reply, double tap heart, mic/send morph, typing dots, jump to latest, big emoji), attachments, voice recorder, calls, settings, Appearance. Other screens follow through the primitives.
- [x] Web: theme store and CSS variables, CSS motion with Calm and Off, primitives, floating dock, chat list, chat view, bubble toolbar, settings, Appearance, pairing.
- [x] New app icon, favicon and splash colors.
- [x] Licenses: allow `OFL-1.1`.
- [x] ADR 0035; CHANGES; ROADMAP; CLAUDE.md.

## Done when
- [x] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format:check`, `pnpm licenses:check` pass; `pnpm --filter @pingdost/web build` passes.
- [x] Light and dark, a scheme change, a look change and restart persistence checked on the emulator and in Chrome; no CSP violation on the web.
- [ ] **On a real Android phone (the user):** a new build is required. Feel of the swipe gestures, haptics, scroll smoothness with long chats on the slowest phone; text sizes Large and Huge on every main screen.
  - Text sizes done 2026-11-08 on the Nothing A001T by screenshot: Huge on Appearance, Settings, the chat list, a chat with a long bubble and a three-line composer, Calls, Devices, Backup and the new-chat menu; Large on Appearance, Settings and a chat. Nothing clipped or overlapped. Not covered at Huge: group screens and the live call screen. **Still the user's:** the feel of gestures, haptics and scrolling.
- [x] Not yet seen on any device: the call screen in a live call, attachments, voice notes, groups, nearby and backup screens in the new look. They use the same primitives but were restyled without a live run.
  - All seen on the two phones 2026-11-07/08. Fixed there: black text on the call screen and an invisible Share button in the viewer (`text-white`/`bg-black` did nothing after the palette change), viewer controls under the navigation bar, text under the status bar.

## Handoff notes
- `input swipe` on the emulator needs screenshot coordinates on animated screens (ADR 0035).
- iOS: Swift is unchanged and JS should work, but nothing here has run on iOS (Phases 28–30 are still open).
