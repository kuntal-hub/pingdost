# 0043 — Selecting several messages and forwarding them

- **Status:** Accepted
- **Date:** 2026-11-11
- **Phase:** 39
- **Approved by user:** yes (items 20–21 of the UI list, CHANGES 2026-11-10)

## Context
Items 20–21 of the user's UI list: select several messages to copy, delete (for me or for everyone) or forward them together, and forward to several chats at once, marked "Forwarded" when the message was someone else's. Until now every action worked on one message from its long-press sheet (phone) or hover menu (web). Forwarding did not exist. A file's server copy is deleted once every recipient device has it (ADR 0017), so a forward cannot point at the old upload.

## Options considered
| Option | Pros | Cons | License | Cost |
|---|---|---|---|---|
| Forward a file by re-sending its key and server copy | No re-upload | The server copy may be gone; one key shared across chats | — | — |
| **Forward a file as a new attachment from the local encrypted copy** | Works whenever this device has the file; a new key per chat | One upload per target chat; a file not on the device cannot be forwarded | — | — |
| Mark "Forwarded" in plaintext metadata | — | The server would learn it; violates A10 | — | — |
| **`forwarded` flag inside the E2EE Content header** | Only the recipients see it; older apps ignore it | One more protobuf field | — | — |

## Decision
- **Wire:** `ContentHeader.forwarded = 8` (optional bool), inside the E2EE content. Set only when the original sender is someone else; forwarding one's own message sends it as a plain new message. Older apps ignore the field. No vector change was needed (the field is absent unless set).
- **Engine (`@pingdost/message-engine`):**
  - `forwardText(messageId, conversationIds)`: at most `MAX_FORWARD_TARGETS` (5) chats, else `invalid`; one new message per chat.
  - `sendText` / `sendAttachment` take `forwarded`; `MessageRecord.forwarded` is stored (phone SQLite migration 010, web sealed rows, memory store; the store contract checks it).
  - `deleteManyForEveryone(messageIds)`: one batch of delete ops under one lock and one commit, all or nothing (`not_allowed` if any message is someone else's or outside the 24 h window).
- **Shared rules (`@pingdost/chat-core` `selection.ts`):** `toggleSelected`, `selectedMessages` (oldest first; deleted ones drop out), `copyText` (one message: its own text; several: one line each, `[time] Sender: text`, with the date when they span days), `deleteForEveryoneCheck` (allowed, or the reason shown), `forwardable` (text and files), `forwardTargets` (recent chats first, then circle members without a chat; search like people search), `pickTarget` (limit 5), `forwardNotice`.
- **Files:** the phone decrypts its vault copy into the work folder, sends it again per chat through the normal send path (new key, new upload or mesh, caption kept, voice notes stay voice notes), then deletes the plaintext. The web decrypts its cached ciphertext in the leader tab and calls `sendFile` per chat. A file not on this device (not downloaded, or removed) is skipped and the notice says how many.
- **Phone UI:** a long press selects (haptic) and starts selection mode; taps add or remove; Back, ✕ or unselecting the last one stops. The header shows the count and Reply (one message), Copy, Forward, Delete, and More (one message: the old sheet with reactions, Edit, Message info). Incoming bubbles move aside for the check mark. Forward opens a full-screen picker with chips and Send (keyboard-sticky footer).
- **Web UI:** a Select button in each message's hover toolbar starts selection; then a click anywhere on a row selects it (the hover toolbar still works), Esc or ✕ stops. The same bar and a Forward dialog.
- **Copy on the phone** uses `expo-clipboard` 58.0.4 (MIT), a native module: it needs a new build. On an older build the app checks with `requireOptionalNativeModule('ExpoClipboard')` and says copying needs the latest build instead of failing.

## Consequences
- Forwarding a large file to five chats uploads it five times (each chat has its own key); the sending device needs the file.
- The phone's Copy works only after a new APK (EAS dev build or local Gradle build); everything else is JS.
- The `forwarded` mark is a hint the sender's app sets; a modified client could omit it, as any messenger's could.

## Evidence
- `packages/message-engine/src/forward.test.ts` (3 tests: the mark end to end and only on others' messages, fan-out to 5 and refusal of 6, the batch delete on both sides and its all-or-nothing refusal), `content.test.ts` (codec), store contract (forwarded kept), mobile SQLite contract and migration 010.
- `packages/chat-core/src/selection.test.ts` (12 tests).
- Chrome, 2026-11-11: three selected, the reason for no "for everyone" with the peer's message included, two own messages deleted for everyone in one batch (the peer logged both removals), the peer's message forwarded to its chat and a group with "Forwarded", an own message forwarded without it, a photo forwarded to a group as a new upload with its caption, Copy of two messages as two lines.
- Emulator (Phase 35 APK + Metro), 2026-11-11: long press starts selection, a tap adds the peer's message, the header shows 2 with Copy/Forward/Delete, Copy on this older build reports it needs the latest build, Forward to the open chat and a circle member without a chat (the chat is opened): the own message arrives unmarked, the peer's marked "Forwarded".
