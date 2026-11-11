# 0041 — Circles: nobody can contact you without your consent

- **Status:** Accepted
- **Date:** 2026-11-11
- **Phase:** 37
- **Approved by user:** yes (server-held circles and the name "Circle", CHANGES 2026-11-10)

## Context
Item 8 of the user's UI list: people message, call or add to a group only those in their circle, which takes a request the other side accepts. It deviates from REQ §8.1/§8.2 (anyone could write to any username) and from ARCHITECTURE A2 ("the server keeps no contact list"). The user chose links held by the server over enforcement on the phones only, so a stranger's data never reaches the recipient's phone. The cost is a lasting "who is connected to whom" list on the server.

Constraints: Atlas M0 allows 100 operations per second (ADR 0030), so no Mongo read per message; the Redis budget of ADR 0010 must not grow; nearby and mesh routes have no server.

## Options considered
| Option | Pros | Cons | License | Cost |
|---|---|---|---|---|
| Enforcement on the phones only | Server keeps no social graph | A stranger's ciphertext and pushes still reach the phone; no protection on the web before the engine runs | — | — |
| **Server-held links + engine checks** (user's choice) | Strangers are refused before anything is stored or pushed; the engine covers nearby and mesh | The server keeps the links; the privacy texts must say so | — | — |
| Strict server rule: no one-to-one envelope outside the circle at all | Simplest rule | Breaks groups: receipts, room-key requests and session resets between co-members travel one to one over Olm, without `group_id` | — | — |

## Decision
- **Model.** A link is mutual (`circle_links`, `_id` = sorted user pair, `since`). A request (`circle_requests`, `_id` = `from:to`) carries no message; the recipient sees only the sender's public profile. Accept links both; asking someone who asked first links at once. Decline is silent: the request stays, hidden from the recipient, and the sender sees "Requested" until it expires (`CIRCLE_REQUEST_TTL_DAYS` = 30, TTL index). Withdraw deletes it. Either side may remove the link; no notice is sent, but both sides' lists refresh (`CircleChanged`), so composers lock on both.
- **Limits.** 20 new requests per account per day (`CIRCLE_REQUESTS_PER_DAY`, in-memory window; repeats do not count), 100 pending (`MAX_PENDING_CIRCLE_REQUESTS`), 1,000 per circle (`MAX_CIRCLE`); `CIRCLE_LIMIT_REACHED`, `RATE_LIMITED`.
- **Blocks.** A block deletes the link and requests both ways. A request to someone who blocked the sender is stored as declined: the sender sees "Requested", the blocker never sees it. A user who blocked someone must unblock before asking them (`CONFLICT`).
- **Enforcement on the server** (`NOT_IN_CIRCLE`, not retryable), with each user's circle cached in memory: filled at connect (`warm`) or on first use, updated on every change (one API instance, A2). No Mongo read per message once warm.
  - One-to-one envelopes (no `group_id`) between different users need a link **or a shared group**. Co-members pass because group receipts, room-key requests and session repair travel one to one; their apps drop direct content from outside the circle (below). `GroupService.sharesGroup` is cached per pair and cleared on every group change.
  - Ephemeral packets between different users (call signalling, including `PacketFlag.RING`) need the link itself: a co-member cannot call.
  - Key claims: devices of owners outside the circle who share no group are left out and named in `refusedDeviceIds`; a claim naming only such devices fails with `NOT_IN_CIRCLE`. The engine fails those outbox items at once (no retries).
  - Typing reaches the circle, and co-members only with the shared group's `group_id`. Presence is hidden both ways outside the circle (the hub's "hidden" check is block or no link).
  - Group create and add name only people in the adder's circle.
  - Blocks keep their silent drop (`Accepted{STORED}`) and are checked first.
- **Live updates and pushes.** `ServerFrame.circle_changed` (`CircleChanged { user_id }`, additive) goes to the user's sockets on every change that concerns them; a decline reaches only the decliner. A new request and an accept send a content-free `{"t":"circle"}` push (FCM, Web Push; APNs alert "Circle update"), at most one per device per minute, to devices that are not connected. The phone fetches the lists and shows its own notification with the public name; the web shows "Circle update".
- **Engine (defence in depth).** Option `circle(userId) → boolean | undefined`. When the list is known and lacks the sender, one-to-one Text, attachments, reactions, edits, deletes, bodies from newer versions and call signals are dropped unread, without a receipt; receipts, session resets, key changes and group traffic pass. `undefined` (never loaded on this device) drops nothing, so a fresh install loses no messages; the server checks anyway.
- **Cache on the device.** Phone: the encrypted SQLite settings (`circle`), like the block list. Web: a sealed setting in the Dexie engine store (`app.circle`) in the leader tab, shared with other tabs over the bus.
- **Privacy.** Account deletion removes links and requests both ways; `retention-audit` checks the TTL index, requests older than 30 days, expiry beyond creation + 30 days, and links naming a deleted account. The privacy policy and the in-app explainer say the server keeps the circle list until either side removes it or deletes the account, and requests for at most 30 days.
- **Existing chats.** Circles start empty. A chat with someone outside the circle keeps its history and shows "Add <name> to your circle to message them" (or the request's state) in place of the composer; call buttons are hidden (phone) or disabled (web).

## Consequences
- REST `/v1/circle*`, `circlesApi` in `@pingdost/api-client`, `SimClient.linkWith` / `linkAll`. Every integration suite links its users first; `sim-client peer` accepts every request, `--dial-user` asks first and calls once accepted.
- Phase 38 (people search) replaces the exact-username "Add to circle" flow; Phase 39 forwards only to chats one may still write to.
- Group co-members outside each other's circle can still send one-to-one ciphertext to each other through the server (dropped by honest apps). Tightening that needs group receipts and repairs to carry `group_id`: a later protocol change, not needed for the threat model of strangers.
- No new native dependency.

## Evidence
- `apps/server/test/circles.int.test.ts` (13 tests): requests, accept, decline, withdraw, remove, expiry, pending and daily limits; a stranger's message, key claim, ring, typing, presence and group add refused; co-member group traffic, receipts and keys allowed but no ring; mixed claims; blocks; account deletion. All 27 integration suites pass (`pnpm --filter @pingdost/server test:int`), including `redis-budget.int.test.ts`.
- `packages/message-engine/src/routing/circles.test.ts`: nearby text from outside the circle dropped with no receipt while the circle's arrives; a mesh-relayed text dropped at the recipient; nothing dropped before the list loads.
- Pixel 8 emulator with the sim peer, 2026-11-11: locked composer on an old chat; Add to circle → accepted → Message → echo; Circle screen remove; an incoming request appears live on the chat list, Accept, then the peer's call rings. Chrome: Circle page, Add to circle from new chat, locked composer.
