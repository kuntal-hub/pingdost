# 0014 — Chat features: edit/delete/reaction sync, receipts, search, blocks and reports

- **Status:** Accepted
- **Date:** 2026-10-19
- **Phase:** 11
- **Approved by user:** n.a.

## Context
REQ §8.1 asks for reactions, reply/quote, edit/delete "with clearly defined sync semantics", local search and optional delivery/read receipts. REQ §14.3 covers local deletion and best-effort "delete for everyone". REQ §15 asks for blocks and reporting inputs; REQ §5.4 limits what deletion may promise.

Constraints: the server sees only ciphertext (ARCHITECTURE A4, A10), keeps no conversation list, and must not store chat content. Messages reach a user's devices (and their own other devices) in any order: several Olm sessions, mailbox batches, and resends after a session repair (ADR 0011).

## Options considered
| Topic | Option | Pros | Cons |
|---|---|---|---|
| Edit/delete/reaction order | Apply in arrival order | Simple | Devices disagree when ops arrive in different orders |
| | **Last-write-wins on (header time, op ID), ops before their target kept pending** | Every device converges; no server state | Sender clocks decide ties (the sender controls its own messages anyway) |
| Edit timestamp | New `Edit.edited_at` field | Explicit | Duplicates the header's `sent_at_ms`, two clocks to reconcile |
| | **The op's `ContentHeader.sent_at_ms`** | No proto change | Documented in code only |
| Ops delivery | Same path as messages, with delivery rows | Resent after repair | Ops get message states nobody shows |
| | **Fan-out as `control` items, no delivery rows** | Reuses the outbox; no fake states | An op the server accepted is not resent after a repair |
| Search | Scan decrypted rows in JS | No schema | O(n) per query |
| | **SQLite FTS5 inside SQLCipher, kept by triggers** | Fast, encrypted at rest with the rest | Tokenizer classes must be mirrored for highlighting |
| Blocked send answer | `FORBIDDEN` error | Honest to the sender's app | Reveals the block |
| | **`Accepted{STORED}` and drop** | Sender learns nothing; sees "sent" | The blocked sender's messages expire as undelivered after 14 days |
| Typing scope | Any listed device (Phase 8) | — | Anyone could ping any online device |
| | **Only sockets watching the sender (`Presence.watch_user_ids`), never across a block** | Scoped to the open chat with no server-side contact list | Typing shows only in an open chat (already the UI) |

## Decision
**Ops (edit, delete for everyone, reaction)** are E2EE Contents (`Edit`, `Delete`, `Reaction`, field numbers unchanged). They are applied by `features/ops.ts` with the same rules on every device:
- **Edit:** only the original sender, within `messageEditWindowSeconds` (24 h, public config `DEFAULT_LIMITS`) of the message's `sent_at`, measured with the op's header time. The newest edit wins: higher header time, then higher op ID. The new text replaces the old on every device; no edit history is kept anywhere. The UI shows "edited".
- **Delete for everyone:** only the original sender, within `messageDeleteWindowSeconds` (24 h). The target becomes a tombstone (`kind: 'deleted'`, text and reactions dropped, `deletedAt`), and nothing changes it afterwards. The copy says it cannot reach copies, screenshots, exports or notifications (REQ §5.4).
- **Reaction:** either participant, one emoji per user (≤ 32 UTF-16 units, no whitespace). The newest event per user wins; a withdrawal is kept (`emoji: null`), so an older event cannot revive the reaction.
- **Pending ops:** an op whose target is not stored yet goes to `message_ops`. It is applied when the target arrives (oldest first), so a message deleted before it arrived is stored as a tombstone and its text is never written. Pending ops are pruned after max retention plus one day.
- **Sending:** an op is applied locally first, then fanned out like a message (the peer's devices and the sender's own) as `purpose: 'control'` outbox items, with no delivery rows or state. Once the server has accepted an op, it is not resent after a session repair (accepted risk).
- **Delete for me** removes local rows (and any unsent outbox items for them). **Delete conversation** removes its messages, deliveries, pending ops and queued sends; a later message starts a fresh conversation.
- Pin, archive and mute are local conversation fields. Archived chats stay archived when new messages arrive. Mute (`mutedUntil`, `MUTED_FOREVER`) is honoured by notifications from Phase 12.

**Receipts:**
- `privacy.deliveryReceipts` (new, default true) and `privacy.readReceipts` gate what this device sends.
- Read receipts go out from `markRead` for incoming messages with no `readAt`, coalesced per device.
- They are reciprocal: with read receipts off, an incoming read receipt counts only as delivery, and stored "read" states display as delivered.
- Delivery receipts are not reciprocal. A recipient with them off makes the sender's messages stay "Sent", then expire as undelivered; the expired label says so.

**Search:**
- FTS5 table `messages_fts(body)`, keyed by the `messages` rowid, inside the SQLCipher file.
- Tokenizer: `unicode61 remove_diacritics 2 categories 'L* N* Co M*'`, so combining marks such as Devanagari vowel signs stay inside words.
- Triggers keep the index in step with every insert, update and delete. Messages are therefore upserted (`ON CONFLICT DO UPDATE`), never `INSERT OR REPLACE`.
- Queries are built only from quoted prefix phrases (`"term"*`), so user input is never FTS syntax.
- Semantics, shared with the memory store and the UI highlighter (`search.ts`): every whitespace-separated term matches as a word prefix, case- and Latin-accent-blind.

**Blocks** (server `blocks` collection, `_id = blocker:blocked`, at most `MAX_BLOCKS` = 1000 per user; `GET /v1/blocks`, `PUT`/`DELETE /v1/blocks/:userId`):
- A send to a blocker's device is answered `Accepted{STORED}` and dropped: not stored, no push. It is counted in `pingdost_envelopes_blocked_total`.
- An ephemeral packet is answered `RECIPIENT_OFFLINE`.
- Typing and presence stop both ways; `PresenceHub.blocksChanged` re-announces.
- Username and ID lookups still work.
- The app caches the list in `local_settings` and the engine drops content from blocked users that was queued before the block (decrypting it so the session stays in step).

**Reports** (`POST /v1/reports`, collection `abuse_reports` with a TTL of `ABUSE_REPORT_RETENTION_SECONDS`, default 90 days):
- A report holds the reason, optional details, and only the messages the reporter ticked (≤ 20). Those are plaintext the reporter chose to disclose, and must be from the two users' chat.
- The log redaction list now covers `text` and `details`.

## Consequences
- The engine and store gained `listUnread`, `searchMessages`, `listOps` and batch deletions (store contract extended). The web store (Phase 17) must implement them, FTS-equivalent included.
- Migration 003 (Android): new columns, `message_ops`, and the rebuilt FTS index. Older incoming messages count as read.
- Phase 10 fix: a chat started by an incoming message now previews its newest message (it compared against the conversation's creation time).
- Follow-ups:
  - Phase 12: muted chats send no notifications.
  - Phase 13: group semantics for ops (admins deleting others' messages, per-member reactions).
  - Phase 15: deleting a conversation must also delete local attachment files.
  - Phase 17: the web store and search.
  - Phase 27: a moderation review path for `abuse_reports`, and making the in-app retention copy follow the env.

## Evidence
- `packages/message-engine`: 68 unit tests, including ops arriving out of order or before their target, conflicting edits from two devices, tombstones of unknown messages, reciprocal read receipts, delivery receipts off, blocked senders, conversation controls and search.
- The SQLite store passes the extended contract on `node:sqlite`, Devanagari search included.
- `apps/server`: `security.int.test.ts` (blocks, dropped sends, typing and presence, lookups, reports, TTL, logs) and the typing-scope case in `gateway.int.test.ts`; 112/112 integration tests pass.
- `buf breaking` against `main`: no changes.
