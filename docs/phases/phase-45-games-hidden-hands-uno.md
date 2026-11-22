# Phase 45 — Games E: hidden hands (dealing) + Last Card (UNO-style)

**Goal:** a way to deal cards so each player sees only their own hand, without a server and without custom cryptography; then a shedding card game with UNO-style mechanics, named **Last Card** with PingDost's own cards (UNO is a trademarked game): 2–4 players with friends, 1–3 computer players when alone.

**Depends on:** 42. ADR 0049 (item 9), ADR 0052.

**Read first:** ADR 0049; ADR 0003 (Olm); `packages/games` session and fair dice.

## Tasks
- [x] **ADR 0052: dealing hidden hands.** Self-dealt draws for Last Card (each seat commits to 128 draw secrets at join; a card comes from the owner's secret and a salt it didn't choose; playing it reveals the secret, which everyone checks). A rotating dealer with jointly random deals and per-card commitments for Call Bridge and Poker. What the dealer can see and what an honest app shows are written down there.
- [x] Direct per-seat events next to the shared log: `sendGameEvent(…, { to })` sends a private `deal` to one device over Olm; receivers keep it as a game event only, also from a group co-member outside the circle.
- [x] Turn-frame hooks for hidden hands (`TurnRules.hidden`: seat data, setup and moves with salts, the personal view, proofs, dealer step) and a solo setup hook for randomness.
- [x] Last Card rules (draw, play the drawn card or keep it, skip, reverse, draw two, wild, wild draw four, the "last card" call with a two-card penalty, places and points), computer players (Easy/Medium/Hard), wire, card tables on both apps.
- [x] Sim peer: `!lastcard [2-4]`.

## Done when
- [x] Dealing tests (no hand visible to another seat in the shared state or events; every played card proved against its commitment); Last Card rules and bots; vectors.
- [x] A friend game through the real server with three sim clients (`games.int.test.ts`); a three-player game with an absent player over the fold (`turn-network.test.ts`).
- [ ] Solo per difficulty and a friend game with two sim peers, on web and phone. **Not run**: no browser and no phone this session.

## As built (2026-11-22)
- Cards come from the full 108-card mix every time (with replacement): no card counting; in theory more than four of a card can appear. The Wild Draw Four "only without the color" rule is not a rule (others can't check it).
- An absent player's turn (30 s) is played for them as draw one and pass, which needs no secret; three in a row take them out.
- Scoring: the first to empty their hand wins, the others are placed by cards held; card points show only in solo games.
- `Game` messages may now be up to 16 KiB (a four-seat start carries everyone's commitments).
