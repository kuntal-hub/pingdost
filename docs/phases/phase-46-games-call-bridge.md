# Phase 46 — Games F: Call Bridge

**Goal:** Call Bridge (4 players, 13 cards each, calls, spades as trumps, 5 rounds) with friends (exactly 4 seats) and solo with 3 computer players at Easy / Medium / Hard, on phone and web.

**Depends on:** 45 (dealing). ADR 0049, ADR 0052.

**Read first:** ADR 0049 and ADR 0052; `packages/games`.

## Tasks
- [x] Rules (calls 1–13 starting left of the dealer, follow suit, else a spade if you have one, spades always trumps, scoring by round in tenths: the call plus a tenth per extra trick, or minus the call), five rounds with the dealer moving round the table.
- [x] The rotating dealer (ADR 0052): a deal from the dealer's committed secret and a salt it didn't choose, per-card commitments in a public deal step, each hand sent privately over Olm, every card proved, the secret shown at the round's end, the deal and revokes checked by everyone.
- [x] Computer players: calls estimated from high cards, trumps and short suits; Easy plays any legal card, Medium wins tricks only when it still needs them (sure winners first), Hard plays out 16 sampled deals of the unseen cards (respecting suits players showed out of) for each card.
- [x] Wire (`GameType.CALL_BRIDGE`, `CallBridgeSettings`, `CallBridgeMove`), suit shapes both apps draw, card colors in ui-tokens (contrast-tested), tables on phone and web (trick by seat, sorted hand, call picker, scores).
- [x] Four-player games need a group: one-to-one invitations and the chat picker leave Call Bridge out; solo setup has exactly three computer players.
- [x] Sim peer `!bridge`; `games.int.test.ts` plays two rounds with four sim clients through the real server.

## Done when
- [x] Rules and bot tests; dealing and revoke tests; a four-player game over the fold (five rounds, every deal checked); vectors.
- [x] A friend game through the real server with four sim clients.
- [ ] Solo per difficulty and a friend game with three sim peers, on web and phone. **Not run**: no browser and no phone this session.

## As built (2026-11-22)
- No timers (slow play, like Chess): a player who leaves ends the game for everyone, placed by the totals so far; the host can end it. The dealer's app deals and shows the deal by itself; a closed dealer app delays its round.
- A revoke found when the deal is shown costs the revoker its call for that round.
