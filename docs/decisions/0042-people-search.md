# 0042 — People search and picking group members

- **Status:** Accepted
- **Date:** 2026-11-11
- **Phase:** 38
- **Approved by user:** yes (prefix search plus exact email, CHANGES 2026-11-10 item 2)

## Context
Items 9–11 of the user's UI list: find people while typing, start a chat or send a circle request from the results, pick several group members from the circle, and give a new group a description. Until now discovery was an exact username lookup only (ARCHITECTURE A2). The user chose prefix search plus exact email over partial matching of everything, which would let anyone discover email addresses by typing fragments.

## Options considered
| Option | Pros | Cons | License | Cost |
|---|---|---|---|---|
| Atlas Search / a text index | Fuzzy matching | Not on M0 (Atlas Search) or no prefix match (text index); more data indexed | — | — |
| Regex on the display name | No new field | Case- and accent-insensitive regexes cannot use an index | — | — |
| **A stored, folded `searchWords` field + anchored regexes** | Prefix queries use the multikey index; folding done once on write | One derived field to keep current (and back-fill) | — | — |

## Decision
- **`GET /v1/users/search?q=`** (signed in; 2–254 characters):
  - a query that looks like an email address matches only that whole address (normalised), for accounts with "Find me by email" on; any fragment finds nothing;
  - otherwise: username prefix, and every query word as a prefix of some display-name word (lower case, accents removed: "zoe" finds "Zoë"), for accounts with "Find me by name" on; an exact username always matches, as the exact lookup always has;
  - at most 10 results (20 read, blocked ones removed), exact username first; never the searcher, unverified or deleted accounts, or anyone either side blocked;
  - each result: user ID, username, display name, avatar, and the circle state (`member`, `requested`, `incoming`, `none`); never an email.
- **Data:** `users.searchWords` (the display name's folded words), multikey index, written on every display-name change, back-filled at startup for older accounts. Privacy settings `findByName` and `findByEmail` (default on; older accounts get the default when read).
- **Cost:** about four Mongo reads per search (users, blocks, circle requests; the circle is cached). Per-account budget 60 per minute (debounced typing sends a few per name), per-IP route limit 600 per 15 minutes; inside Atlas M0's 100 ops/s.
- **Apps:**
  - New chat: one field; circle members matching on the device show at once, server results after a 300 ms pause, older answers dropped (abort + ticket). One action per row: Message, Add, Requested (withdraws), Accept. The phone's own circle lists win over the server's state once loaded.
  - Group members: only circle members, matched on the device on every keystroke (nothing leaves it); a whole email goes through the server and keeps only circle members. Several at once with chips; current members show as "Already in the group" and cannot be picked. Buttons say "Create group (N)" and "Add (N)".
  - A new group's description goes in its first `GroupControl` (the field already existed, ADR 0016).
- The exact `by-username` endpoint stays (sim tools, tests).

## Consequences
- ARCHITECTURE A2 "User discovery" now describes this search. Phase 39's forward sheet reuses the circle and search helpers (`@pingdost/chat-core` `matchesPerson`, `mergePeople`, `togglePicked`).
- Name search reveals that an account with a matching name exists, as a directory does; people can turn it off. Email search confirms only an address the searcher already knows in full.

## Evidence
- `apps/server/test/users-search.int.test.ts` (9 tests): username and folded name prefixes, two-character minimum and the 10-result cap with the exact username first, whole email only (three kinds of fragments find nothing), no email in any response and only the five public fields, circle states, blocked/unverified/deleted excluded, both Privacy settings, defaults for older accounts, the back-fill, the rate limit.
- Chrome, 2026-11-11: part of a username (circle member first with Message, others Add), a whole email found and a fragment not, a group created from the circle-only picker with a description shown in Group info, a current member shown as "Already in the group".
