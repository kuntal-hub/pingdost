# 0016 — Groups: server routing membership, E2EE controls, Megolm sessions

- **Status:** Accepted
- **Date:** 2026-10-20
- **Phase:** 13
- **Approved by user:** n.a.

## Context
REQ §8.2 asks for groups with roles, a configurable size limit, per-member encryption, rekeying on membership changes (removed members get nothing new), per-device queueing, and no group calls. REQ §19.1 bullet 4: a removed member cannot decrypt later messages. ADR 0003 fixes Megolm v1 (rotation on membership change and every 100 messages / 7 days, keys only over Olm, a replay check on (session, index)) and the lessons of the 2023 Matrix analysis: group membership is authenticated by members' signed control messages, never by the server, and there is no key forwarding from other devices. ARCHITECTURE A2 keeps group name, description and picture off the server.

## Options considered
| Topic | Option | Pros | Cons |
|---|---|---|---|
| Who decides membership | Server record only | Simple, always consistent | A compromised server could add a member and every client would share keys with them (the Matrix flaw) |
| | E2EE controls only | Server-proof | Routing still needs the server; a lost control leaves clients diverged forever |
| | **Server for routing + E2EE controls for key sharing; the server's view applied only restrictively** | The server can block or remove, never add; clients converge on removals through the server | A promotion or addition depends on the admin's control arriving |
| Ordering of controls | Sequence numbers per sender | — | Several admins, several devices |
| | **The server's version in every control, with the full member list** | Newest wins; skipped versions are harmless | A late control older than the server's notice: handled by the "late ADD / promotion if the server agrees" rule |
| Keys for late messages | Matrix-style key forwarding from any device | Robust | Forbidden by ADR 0003 |
| | **`RoomKeyRequest` to the session's own sender device, answered only for devices it was shared with, exported from the index they got** | No history leak to later joiners | The sender must come online |
| Group message state | Best device among all members (as 1:1) | — | "Delivered" when one member of 50 got it |
| | **Per member: delivered when every member still reachable has a device that confirmed** | Honest (REQ §8.3) | Slower to turn "delivered" |

## Decision
**Server (`apps/server/src/modules/groups`):** `groups {_id, createdBy, members:[{userId, role, addedAt, addedBy}], version, createdAt, updatedAt}`, indexed on `members.userId`.
- `POST /v1/groups` (the caller becomes the owner), `GET /v1/groups`, `GET /v1/groups/:id` (members only, else `NOT_A_MEMBER`), `POST …/members` (admins), `DELETE …/members/:userId` (admins remove plain members, the owner anyone; anyone leaves; a leaving owner hands over to the longest-standing admin, else member; the last one out deletes the group), `PATCH …/members/:userId` (owner; admin ↔ member). `GROUP_MAX_MEMBERS` (default 64) gives `GROUP_FULL`.
- Every change bumps `version` (optimistic concurrency, 3 attempts) and sends `GroupChanged{group_id, version}` to the online devices of members before and after the change.
- **Routing check:** an envelope with `group_id` (Megolm messages, room keys, key requests) is accepted only when sender and recipient are current members (`NOT_A_MEMBER`); a Megolm envelope without `group_id` is malformed. Membership sets are cached in memory and dropped on every change (one API instance, A2). Group controls travel untagged over Olm, so a removed member still hears of the removal.

**Protocol (add-only):** `GroupControl` gains `version`, `members` (`GroupMember{user_id, role}`), `description`, `avatar` (≤ 32 KiB) and the actions `CHANGE_ROLE` and `SNAPSHOT`; `RoomKey.exported`; a new `RoomKeyRequest{group_id, session_id, from_index}` body; the WS `GroupChanged` frame. `buf breaking` is clean.

**Client membership (`message-engine/src/groups/state.ts`):**
- Controls are Olm-authenticated (certified device) and name no recipient; their conversation is the group. CREATE comes from the owner it lists, SNAPSHOT (sent by the adder to new members, with the info) from an admin it lists; both must list this user.
- ADD and REMOVE need an admin in this device's state (admins remove plain members only; the owner anyone), CHANGE_ROLE the owner, LEAVE the leaving member, UPDATE_INFO an admin.
- A control newer than the state here replaces the member list (minus anyone the server removed in a newer version). An older one still adds the users it names, or applies its promotion, if the server lists them so now; its notice is shown either way.
- The server's view (`GET /v1/groups/:id`, on `GroupChanged`, at start, and after `NOT_A_MEMBER`) only removes members, lowers roles or marks this user `left`.
- Name, description and picture: last-write-wins on (header time, message ID).

**Megolm (`groups/megolm.ts`, the outbox and the receiver):**
- One outbound session per (group, device), replaced when the member set changed, a device it was shared with is no longer a recipient, after `groupRotationMessages` (100) or `groupRotationMs` (7 days).
- A group fan-out sends the session key over Olm (`room_key` items, group-tagged) to every member device that lacks it, at the current index, then encrypts the Content once and sends the same Megolm packet to every member device (this user's other devices included). Delivery rows are per device; the message state is per member (`aggregateGroupState`).
- Each own session is kept as an inbound copy with `sharedAt` (device → first index), to answer `RoomKeyRequest`s from exactly those devices from that index.
- Inbound sessions are keyed by (sender device, session ID) and bound to that device and user; the accepted indices are stored with them, so a replay under a new envelope ID is dropped.
- Group traffic that cannot be read yet is held (`held`): Megolm messages until their key arrives (after `roomKeyRequestDelayMs`, 10 s, the device asks the sender; at most every 5 min), room keys until the group or the sender's membership is known. Held records are pruned with the pending ops.
- Over Megolm only text, edits, deletes and reactions from current members count. Edits and deletes stay sender-only (no admin deletes in v1); one reaction per member; ops from people no longer members are ignored. Read receipts go per member to the sender's device; group typing is not relayed.
- No call action exists for groups (REQ §8.2).

**Android:** migration 004 (`groups`, `group_sessions_out`, `group_sessions_in`, `group_held`; replaces 002's empty `group_memberships`); New group, Group info (members, roles, add, remove, leave, mute, edit info), Add members; sender names and colours; group notices; group pictures resized on the phone (`expo-image-manipulator` 58.0.15) to ≤ 32 KiB and shown from `data:` URIs.

## Consequences
- A compromised server can drop or remove members but cannot make clients share keys with someone no admin added. A malicious *admin* together with the server can; admins are trusted for membership.
- A member whose device missed a promotion rejects controls from the new admin until the next newer control or a server notice confirming it; the effect is that the people that admin added get no keys from this member. Phase 27 measures it.
- Group size: each message costs one Megolm encryption plus one envelope per member device (the Redis budget of ADR 0010 grows with group size).
- Phase 17 (web): the Dexie store must pass the extended store contract; the web UI reuses `parseGroupNotice` and the engine API.

## Evidence
- `packages/message-engine/src/groups/{state,groups}.test.ts`: 17 tests over the fake server with real vodozemac (three members, removal, late joiner, two devices, key after message, replay, rotation, roles, size limit).
- `apps/server/test/groups.int.test.ts`: 8 tests on the real server with sim clients, including REQ §19.1 bullet 4 (the removed member's sessions cannot open the Megolm ciphertexts sent after the removal).
- The extended store contract passes on the memory store and on the SQLite store (Node's SQLite, migrations 002–004).
