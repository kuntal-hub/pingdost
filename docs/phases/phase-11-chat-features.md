# Phase 11 — Chat features

**Depends on:** 10 · **Platforms:** shared engine + Android (+ server block/report)

## Goal
Complete the REQ §8.1 feature set with clearly defined sync semantics, plus the local storage controls and the basic abuse controls.

## Read first
- REQ §8.1, §14.3, §15 (Security/abuse)
- ARCHITECTURE A2, A4

## Tasks
- [ ] **Reactions:** a `Reaction` content type (add/remove, one emoji per user per message), aggregated in the UI.
- [ ] **Reply/quote:** `reply_to`, with the quoted snippet resolved locally (or "Original message not available").
- [ ] **Edit** (`Edit{target, newText, editedAt}`):
  - only the original sender may edit;
  - within a configurable window (default 24 h, in public config);
  - last-write-wins by `editedAt`;
  - an "edited" label;
  - edit history is not kept on the recipient (doc the semantics in the code and the UI help).
- [ ] **Delete:**
  - "Delete for me" is local only;
  - "Delete for everyone" sends a `Delete` tombstone. It is best-effort, and the UI copy states that copies, screenshots and exports cannot be guaranteed erased (REQ §5.4, §14.3).
- [ ] **Local search:** FTS5 over decrypted text, kept inside the SQLCipher DB. Global search and in-chat search, with result highlighting.
- [ ] **Conversations:** delete a conversation (local messages + local attachments, with a confirm dialog); archive; pin; mute (local).
- [ ] **Receipts:** delivery and read receipt toggles, sent as E2EE `Receipt` content. If read receipts are off, neither send nor show them (reciprocal).
- [ ] **Block user** (server `blocks` collection):
  - the gateway drops envelopes from blocked senders, and the sender still sees `sent_to_server`;
  - lookups by the blocked user still work;
  - local UI to block/unblock.
- [ ] **Report user:** `POST /v1/reports {reportedUserId, reason, optional user-selected messages}`. Messages are included **only if the user explicitly attaches them** (plaintext the user chooses to disclose). The privacy copy explains this. Reports have a documented retention (env).
- [ ] **Tests:** engine unit tests per feature (edit conflicts, out-of-order edit/delete, reactions toggling, tombstone of an unknown message); server tests for blocks and reports.

## Key files
`packages/message-engine/src/features/*`, `packages/protocol/proto/pingdost/v1/content.proto` (field additions only), `apps/mobile/app/(app)/chats/*`, `apps/server/src/modules/security/{blocks,reports}.ts`

## Out of scope
Group-specific semantics (13); media (15).

## Done when
- The unit and integration tests pass.
- Every feature works between two Android devices.
- `buf breaking` reports no breaking proto changes.
- `pnpm lint typecheck test` passes.

## Handoff notes
**From Phase 7 (ADR 0009):** privacy prefs (`readReceipts`, `typingIndicators`, `lastSeen`) are edited in Settings → Privacy, stored on the server and cached in `local_settings` (`privacy`). Read them with `useAccount` or `cachedPrivacy()` from `apps/mobile/src/settings/account.ts` to decide what to send.
