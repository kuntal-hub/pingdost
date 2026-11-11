# Phase 38 — Find people and pick group members

**Goal:** find someone by the start of their username or name, or by their full email address, while typing. Start a chat or send a circle request from the results. Create groups and add members by picking several people from the circle at once, and give a new group a description.

**Depends on:** 37. User request 2026-11-10 (CHANGES; items 9–11 of `prompts/UI_modifications.txt`). The user chose **prefix search plus exact email** over partial matching of everything.

**Read first:** ARCHITECTURE A2 (User discovery ⚠, Groups), A10; the Circles ADR (Phase 37); ADR 0016; ADR 0030 (Atlas ops budget).

## Tasks
- [x] New ADR (People search). ARCHITECTURE A2 "User discovery": turn the ⚠ "planned" line into the built design.
- [x] **Server search** `GET /v1/users/search?q=` (signed in):
  - from 2 characters: username prefix (normalised) and display-name word prefix (case- and accent-folded; a new stored search field with an index, back-filled for existing users); an email only when the query is a whole address (exact, normalised);
  - at most 10 results; never the searcher, deleted accounts, or anyone either side has blocked;
  - each result: user ID, username, display name, avatar and circle state (in circle, requested, requested you, none); **never an email**;
  - a per-user rate limit sized for debounced typing, within Atlas M0's 100 ops/s;
  - Privacy settings "Find me by name" and "Find me by email" (both on by default). Exact username search always works, as today.
  The exact `by-username` endpoint stays (the sim tools use it).
- [x] **Phone new chat (item 9):** one field, ~300 ms debounce, stale answers dropped. Circle members who match show at once (filtered on the device), then the server's results. Each row: avatar, name, @username and one action: Message, Add to circle, Requested, or Accept.
- [x] **Phone new group and add members (item 10):** only circle members, filtered on the device on each keystroke by name and username (faster, and nothing leaves the phone); a whole email address goes through the server search and keeps only circle members. Multi-select with chips and a "Next" / "Add (N)" button; people already in the group show as members and cannot be picked. The server check from Phase 37 backs this up.
- [x] **Group description (item 11):** a field on the new-group screen (the same limit as Group info), sent in the first `GroupControl`.
- [x] **Web:** new-chat search, the multi-select member picker, the description on create.

## Done when
- [x] New `apps/server/test/users-search.int.test.ts`: username prefix, name word prefix, exact email only (part of an email finds nothing), no email in any response, blocked and deleted accounts excluded, the two Privacy settings, the rate limit.
- [x] Server, mobile and web tests, lint and typecheck pass.
- [ ] Phone and web: search by part of a username, part of a name and a whole email; start a chat with a circle member; send a request to someone else; create a group with three picked members and a description; add two members at once.

## Handoff notes
- 2026-11-11 (ADR 0042): built. Chrome checked (username part, whole email vs fragment, circle-only picker, group with a description, current member not pickable). Open: the phone row of Done when (no new native code: Phase 35's APK), and a group with three picked members (the test account had one circle member).
