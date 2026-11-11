# Phase 37 — Circles: nobody can contact you without your consent

**Goal:** people can message, call or add to a group only those in their circle. Getting into someone's circle takes a request they accept. The server enforces it, the apps also check it, and the UI makes it clear.

**Depends on:** 13, 17, 26 (🔄: the code is in place; their open items are device checks). User request 2026-11-10 (CHANGES; item 8 of `prompts/UI_modifications.txt`). The user chose **server-held circles** over enforcement on the phones only, and the name **Circle**.

**Read first:** REQ §1, §8.1, §8.2, §15; ARCHITECTURE A2 (Presence, Groups, Blocks and reports, Circles ⚠), A4 (Call signaling), A10; ADR 0010 (Redis budget), 0012, 0014, 0016, 0028, 0030 (Atlas ops budget), 0036 (account deletion).

## Model (confirm or adjust in the new ADR)
- A circle link is mutual: once B accepts A's request, either can message, call and add the other to groups. Either can remove it at any time; no notice is sent.
- A request carries no message, only the sender's public profile. B can Accept, Decline or Block. Declining is silent: A sees "Requested" until the request expires (30 days), then may ask again. Limits, for example 20 new requests per day and 100 pending per sender.
- Blocking removes the link and pending requests both ways.
- Group members who are not in each other's circles still get the group's messages and room keys (envelopes with `group_id`, already member-checked), but cannot message each other directly.
- Existing conversations: circles start empty (only test accounts exist). A chat with someone outside the circle keeps its history and shows "Add <name> to your circle to message them" in place of the composer.

## Tasks
- [ ] New ADR (Circles). ARCHITECTURE: turn the ⚠ "planned" lines of 2026-11-10 into the built design.
- [ ] **Server module `circles`:** collections `circle_links` (sorted user-ID pair, since) and `circle_requests` (from, to, created; TTL index). REST: send, list incoming and outgoing, accept, decline, withdraw, list the circle, remove. Live updates to the user's sockets (`CircleChanged`, like `GroupChanged`: a protocol change) and a contentless push for a new request and an accepted one.
- [ ] **Enforcement without a Mongo read per message** (Atlas M0 allows 100 ops/s; ADR 0030): an in-process cache of each online user's circle, filled at connect and updated on every change. Refused with `NOT_IN_CIRCLE`:
  - 1:1 envelopes (no `group_id`) between different users; the sender's outbox marks the item and does not retry;
  - key-bundle (one-time key) fetches, except for circle members and co-members of a shared group;
  - call rings (`PacketFlag.RING`), typing and presence watches outside the circle;
  - group create and add-member calls that name someone outside the adder's circle.
  `redis-budget.int.test.ts` stays within ADR 0010.
- [ ] **Engine (defence in depth, and the only check on nearby and mesh routes, where no server is involved):** 1:1 content from a sender outside the circle is dropped without a receipt; group content, own-device sync and session resets still pass. The device caches the circle list (SQLite on the phone, Dexie on the web).
- [ ] **Privacy:** account deletion (ADR 0036) and `retention-audit` cover both collections. The privacy policy (`docs/legal/privacy-policy.md`) and the in-app explainer (`packages/chat-core/src/privacy.ts`) say that the server keeps the circle list (who is connected to whom) until either side removes it or deletes the account, and keeps pending requests for at most 30 days.
- [ ] **Phone:** a Circle screen (from Settings and the contact screen: list, search, remove); Requests (incoming: Accept, Decline, Block; outgoing: Withdraw); a Requests row with a count at the top of the chat list; the chat header and contact screen show the state and its action; the locked composer. The exact-username new-chat flow gets "Add to circle" until Phase 38 replaces it.
- [ ] **Web:** the same lists in Settings, the Requests row in the chat list, the locked composer.
- [ ] **Sim tools and existing tests:** a `SimClient` helper that links two clients through the real API. Every existing integration test that messages, calls or groups two users links them first. `sim-client peer` accepts every circle request (and `--dial-user` sends one first). Update `docs/ops/run-on-devices.md` for the two-phone test.

## Done when
- [ ] New `apps/server/test/circles.int.test.ts`: request, accept, decline, withdraw, remove, expiry and limits; a stranger's message, call, key fetch, typing and group add are refused; group traffic between co-members outside each other's circle still works; a block clears the link; account deletion removes links and requests.
- [ ] Every existing integration suite, `pnpm test`, lint, typecheck and `retention-audit` pass.
- [ ] Engine test: nearby and mesh content from a sender outside the circle is dropped.
- [ ] On a phone with the sim peer, and on two phones: request → notification → accept → chat; decline; remove (the composer locks on both sides); a stranger cannot call; the web shows and accepts requests.

## Handoff notes
-
- 2026-11-11: built (ADR 0041). Open: final full test run, format check, retention-audit run, and the two-phone check. See PROGRESS.
