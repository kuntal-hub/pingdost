# Phase 13 — Groups (Megolm)

**Depends on:** 10 · **Platforms:** server, shared engine, Android

## Goal
Secure group chats: server-side membership and roles kept only as routing metadata, Megolm encryption, room keys distributed over Olm, and rekeying on every membership change. Removed members cannot read future messages, and group name and avatar are E2EE.

## Read first
- REQ §7.3 (group bullets), §8.2, §19.1 (bullet 4)
- ARCHITECTURE A2 (Avatars), A5
- The E2EE ADR

## Tasks
- [ ] **Server `groups` module:**
  - collection `{groupId, createdBy, members:[{userId, role: owner|admin|member, addedAt}], version, createdAt}`, with a limit of `GROUP_MAX_MEMBERS` (default 64);
  - endpoints: create, add members (admin+), remove (admin+, or self = leave), change role (owner), get group (members only);
  - every change bumps `version`, and members' online devices get a WS notice;
  - **routing check:** an envelope with `group_id` is only accepted for recipients who are current members, from a sender who is a current member;
  - each recipient device gets its own queued copy (REQ §8.2).
  - **No group name or avatar on the server.**
- [ ] **Engine:**
  - a group conversation type;
  - one outbound Megolm session per (group, sender device);
  - `RoomKey` content shared over Olm to all member devices (including own other devices);
  - **rotate on any membership change** (mandatory on removal), and periodically (every 100 messages or 7 days, configurable);
  - new members receive a key exported at the current index only, so they have no old history;
  - inbound sessions stored per sender device;
  - **Megolm replay check (ADR 0003):** Megolm itself accepts the same message twice, so reject any (sessionId, messageIndex) pair already accepted. Persist the seen indices with the inbound session;
  - accept room keys only over an Olm session with a certified member device. There is no key forwarding from other devices (the lesson from the 2023 Matrix analysis);
  - handle messages that arrive before their keys (hold, then request the key from the sender device).
- [ ] **E2EE group state:** `GroupControl` content (name, description, avatar as a small inline encrypted image) sent by admins. Clients apply it only if the sender is an admin per the server-confirmed membership version. Late joiners get a current-state snapshot from the adder.
- [ ] **UI:**
  - create group (pick contacts by username; name/avatar);
  - group chat (sender names/colors);
  - group info (members, roles, add/remove, leave, mute);
  - system messages ("A added B", "Security code changed for C").
  - **There must be no call action anywhere in groups** (REQ §8.2).
- [ ] **Tests (sim-client integration):**
  - 3 members exchange messages;
  - **removed member cannot decrypt messages sent after removal**;
  - new member cannot decrypt messages from before joining;
  - member with 2 devices;
  - out-of-order key arrival;
  - non-member envelopes rejected by the server;
  - size limit enforced.

## Key files
`apps/server/src/modules/groups/*`, `packages/message-engine/src/groups/*`, `apps/mobile/app/(app)/groups/*`

## Out of scope
Web group UI (17); group calls (never).

## Done when
- The integration tests pass, including REQ §19.1 bullet 4.
- A group of 3 accounts works on devices (2 phones + a sim-client as the third member is acceptable).
- `pnpm lint typecheck test` passes.

## Handoff notes
**From Phase 8 (ADR 0010):** the mailbox routes one envelope per recipient device (`dst` = device ID). A group message is N sends with N envelope IDs (`envelopeIdFor(messageId, deviceId)`). Each one costs 5 Redis commands on the offline path, so watch the budget for large groups.
**From Phase 9 (ADR 0011):**
- The receive pipeline ACKs and drops `CRYPTO_TYPE_MEGOLM` envelopes.
- `checkHeader` (`message-engine/src/content.ts`) accepts only direct messages (`recipient_user_id` set, conversation ID = `directConversationIdFor`). Add the group rules: the conversation ID is the group ID, and membership comes from group control messages.
- `ConversationRecord.kind` is `'direct'` only.
- The engine must reject a replayed Megolm `(sessionId, messageIndex)`: the seen set holds message and envelope IDs only.
- Fan-out is per user (`FanoutItem.recipientUserIds`) and reuses the device-item outbox.
