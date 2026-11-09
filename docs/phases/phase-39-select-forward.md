# Phase 39 — Select several messages and forward them

**Goal:** long-press a message to select it, tap more, then copy, delete (for me or for everyone) or forward them together. Forward to up to five chats at once, marked "Forwarded" when the message was someone else's.

**Depends on:** 35 (bubbles), 37 (forward targets are circle members and groups). User request 2026-11-10 (CHANGES; items 20–21 of `prompts/UI_modifications.txt`).

**Read first:** ADR 0006 (protocol), ADR 0014 (ops, delete windows), ADR 0017 and 0018 (attachments); ARCHITECTURE A10.

## Tasks
- [ ] **Selection mode (item 20), phone:** a long-press selects the message and enters the mode (haptic); taps add or remove messages; the header shows the count and the actions; Back, ✕ or deselecting the last message leaves. With one message selected, the current single-message actions (react, reply, edit, info) stay reachable, so nothing is lost.
- [ ] **Actions:**
  - Copy: one message copies its text; several copy one line each, with sender and time.
  - Delete for me.
  - Delete for everyone: only when every selected message is the user's own and inside the 24 h window; otherwise the option is absent or says why. Several deletes go out as one batch of ops.
  - Forward.
- [ ] **Forwarded flag (item 21):** an optional `forwarded` field in the E2EE message Content (an additive protocol change: proto, `gen`, codec tests; vectors only if the wire tests need them). Set only when the original sender is someone else; forwarding one's own message sends it as a new message. Both apps show "Forwarded" with an icon above the text; older apps ignore the field.
- [ ] **Forward sheet:** pick up to 5 targets (circle members and groups; recent chats first; search), then Send. Text goes as is. An attachment goes from the local encrypted copy as a new attachment (new key, new upload), since the server's copy may be gone (ADR 0017). Messages whose file is not on the device are skipped with a notice.
- [ ] **Web:** a checkbox appears on hover and stays once selecting has started; the same actions and forward dialog.

## Done when
- [ ] Protocol, message-engine, chat-core, mobile and web tests (selection reducer, copy formatting, forward fan-out, flag rules), lint and typecheck pass.
- [ ] Phone with the sim peer and a second chat: select three messages; copy; delete for me; delete for everyone (own messages only); forward a text, a photo and one of the peer's messages to two and to five chats. "Forwarded" shows only on the peer's message. Web in Chrome: the same.

## Handoff notes
-
