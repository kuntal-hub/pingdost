# Phase 39 — Select several messages and forward them

**Goal:** long-press a message to select it, tap more, then copy, delete (for me or for everyone) or forward them together. Forward to up to five chats at once, marked "Forwarded" when the message was someone else's.

**Depends on:** 35 (bubbles), 37 (forward targets are circle members and groups). User request 2026-11-10 (CHANGES; items 20–21 of `prompts/UI_modifications.txt`).

**Read first:** ADR 0006 (protocol), ADR 0014 (ops, delete windows), ADR 0017 and 0018 (attachments); ARCHITECTURE A10.

## Tasks
- [x] **Selection mode (item 20), phone:** a long-press selects the message and enters the mode (haptic); taps add or remove messages; the header shows the count and the actions; Back, ✕ or deselecting the last message leaves. With one message selected, the current single-message actions (react, reply, edit, info) stay reachable, so nothing is lost. *(Reply in the header; React, Edit, Info under More.)*
- [x] **Actions:**
  - Copy: one message copies its text; several copy one line each, with sender and time.
  - Delete for me.
  - Delete for everyone: only when every selected message is the user's own and inside the 24 h window; otherwise the option is absent or says why. Several deletes go out as one batch of ops. *(`deleteManyForEveryone`; the reason is shown above the options.)*
  - Forward.
- [x] **Forwarded flag (item 21):** an optional `forwarded` field in the E2EE message Content (an additive protocol change: proto, `gen`, codec tests; vectors only if the wire tests need them). Set only when the original sender is someone else; forwarding one's own message sends it as a new message. Both apps show "Forwarded" with an icon above the text; older apps ignore the field. *(`ContentHeader.forwarded = 8`; no vector change needed.)*
- [x] **Forward sheet:** pick up to 5 targets (circle members and groups; recent chats first; search), then Send. Text goes as is. An attachment goes from the local encrypted copy as a new attachment (new key, new upload), since the server's copy may be gone (ADR 0017). Messages whose file is not on the device are skipped with a notice.
- [x] **Web:** a checkbox appears on hover and stays once selecting has started; the same actions and forward dialog. *(Hover shows a Select button in the message toolbar; once selecting, every row has a checkbox and a click anywhere selects. CHANGES 2026-11-11.)*

## Done when
- [x] Protocol, message-engine, chat-core, mobile and web tests (selection reducer, copy formatting, forward fan-out, flag rules), lint and typecheck pass.
- [ ] Phone with the sim peer and a second chat: select three messages; copy; delete for me; delete for everyone (own messages only); forward a text, a photo and one of the peer's messages to two and to five chats. "Forwarded" shows only on the peer's message. Web in Chrome: the same. *(Web done 2026-11-11; the emulator did selection, Forward of text to two chats and the "Forwarded" mark. Open: a real phone with a **new build** for Copy (`expo-clipboard`), a photo forward, five targets.)*

## Handoff notes
- Copy on the phone needs a new APK (`expo-clipboard` is native). Build one before the phone check (EAS: `npx eas-cli@27.3.0 build -p android -e development` in `apps/mobile`, or a local `pnpm --filter @pingdost/mobile android`).
- The emulator's Expo dev-menu button covers the header's Delete icon; move it aside (drag) when testing Delete there.
- Forwarding a file uploads it once per target chat (each has its own key).
