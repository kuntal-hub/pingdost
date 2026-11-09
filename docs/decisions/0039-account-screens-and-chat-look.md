# 0039 — Account screens and chat look: live username check, keyboard handling, message times

- **Status:** Accepted
- **Date:** 2026-11-10
- **Phase:** 34, 35
- **Approved by user:** n.a. (from the user's list, CHANGES 2026-11-10; no gate)

## Context
The user's UI/UX list (CHANGES 2026-11-10, items 1–7 and 12–15) asked for a live username check, a password eye, fields the keyboard never covers, errors that say how to fix them, branding on the account screens, smaller titles, the Chats "+" above a full-width tab bar, a time and state on every message, bubbles at most 80% wide with the time inline, "This message was deleted" at once, and only a single emoji shown large. REQ §6.1 (throttling), §8.1, §8.3; ARCHITECTURE A2, A10.

## Options considered
| Option | Pros | Cons | License | Cost |
|---|---|---|---|---|
| Keyboard: `react-native-keyboard-controller` 1.22.7 (Expo SDK 58's pinned version) | Works with Android edge-to-edge (the window no longer resizes); `KeyboardAwareScrollView` scrolls the focused field into view; `KeyboardChatScrollView` and `KeyboardStickyView` for the composer (Phase 36) | A native module: a new build | MIT | free |
| Keyboard: React Native's `KeyboardAvoidingView` + manual scrolling | No native change | Unreliable under edge-to-edge (the composer's gap, item 19, is this); hand-written measuring | MIT | free |
| Username check as a path parameter | REST-like | Request logs keep paths: everything people type would be logged | — | — |
| Username check as a query parameter | Request logs drop query strings (`logger.ts`) | — | — | — |
| Inline time by measuring text lines (`onTextLayout`) | Exact | A second layout pass per bubble | — | — |
| Inline time by an invisible spacer | No measuring; wraps naturally | Width of no-break spaces approximates the tick on the phone | — | — |

## Decision
1. **Keyboard handling:** `react-native-keyboard-controller` 1.22.7, with `KeyboardProvider preserveEdgeToEdge` at the root. `Screen` is a `KeyboardAwareScrollView` (96 dp kept below the focused field, so the button after a form's last field stays visible), registered with NativeWind like React Native's ScrollView.
2. **`GET /v1/usernames/availability?username=`**, no sign-in, per-IP limit 120 per 15 min. It answers what registration would: `invalid` (schema), `reserved`, `taken` (any account holding the name, including an unverified sign-up until it expires), else available. It reveals nothing `by-username` does not already reveal to a signed-in user. The phone checks after a 400 ms pause, aborts older requests, reuses an answer for 60 s, and shows local rule problems without asking the server.
3. **Field messages** name the rule that failed and what to change (`apps/mobile/src/forms/messages.ts`), from the shared schemas' real rules. A failed sign-in still never says which part was wrong.
4. **The password meter is advice only.** The rule stays the length (10–128, `PasswordSchema`); the meter (`password-strength.ts`) rates length, kinds of characters, common words, runs and the user's own name or email, and suggests numbers or symbols. Nothing leaves the phone.
5. **Message times:** every message shows its time, "edited", unusual states and its tick. An invisible copy at the end of the text (no-break spaces at the time's size on the phone, a hidden copy of the label on the web) reserves the room; the visible time sits over it at the bottom right. Right-to-left text, a big emoji and media without a caption put the time on its own line. Bubbles are at most 80% of the screen (phone) or the message column (web).
6. **Big emoji** (`isBigEmoji` in `chat-core`) now means exactly one emoji: a flag, a keycap, or one pictograph with its variation selector, skin tone, tag characters and zero-width-joined parts. Two or more emoji show at normal size in a bubble.

## Consequences
- A new native Android build is required (keyboard-controller). Older builds cannot run this JS.
- Phase 36 builds the composer on the same library (item 19's gap comes from the double inset).
- `SwipeAction` keeps the same tree when a row loses its actions, so a message deleted for everyone is updated in place instead of mounted again (Phase 35, item 14).
- The availability endpoint is the first one that tells strangers anything about usernames without signing in; its rate limit and the unchanged exact-match lookup (A2) keep that small. Phase 38 revisits discovery.

## Evidence
- `npm view react-native-keyboard-controller@1.22.7`: MIT; dependency `react-native-is-edge-to-edge` (MIT); latest 1.23.0, Expo SDK 58's `bundledNativeModules.json` pins 1.22.7 (checked 2026-11-10).
- `apps/server/test/auth-register.int.test.ts` "username availability": answers, the name absent from request logs, the per-IP limit.
