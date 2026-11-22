# 0053 — Poker: no-limit Texas Hold'em with play chips, a dealing chain per seat, proved board and showdown

- **Status:** Accepted
- **Date:** 2026-11-22
- **Phase:** 47
- **Approved by user:** n.a. (the product choices follow ADR 0049, 0052 and the Phase 47 outline: chips only, 2–6 seats, solo with levels; CHANGES 2026-11-22 records the choices made while building)

## Context
Phase 47 adds Poker: Texas Hold'em with play chips only, with friends (2–6 seats) and solo against Easy / Medium / Hard computer players, on phone and web. ADR 0052 decided that Call Bridge and Poker use a rotating dealer whose device knows the hands of its round, with a jointly random deal and per-card commitments checked at the round's end. Poker differs from Call Bridge in three ways that need decisions here:
1. The number of hands is unbounded (Call Bridge has five rounds, so a commitment per round fits in `seat_data`).
2. Shared cards (flop, turn, river) must be turned up during the hand, and only the dealer can turn them up.
3. Hands at the showdown are shown by their owners, and the folded hands should stay down.

Simulated gambling also touches store policy (Google Play's gambling policy restricts gambling ads and real-money links).

## Options considered
| Option | Pros | Cons | License | Cost |
|---|---|---|---|---|
| A dealer commitment per hand in `seat_data` (as Call Bridge) | Same code path | Caps the hands (e.g. 64 per seat ≈ 1 KiB each in `start`) | — | — |
| **A dealing hash chain per seat** (its end in `seat_data`, one link shown per hand, backwards) | 1,000 hands with 32 bytes per seat; every shown link is checked against the last one; a skipped hand's link is never reused | A dealer can still stall to avoid dealing a hand it dislikes (a strike, as for any absent player) | — | — |
| The dealer reveals the whole deal only at the end (no proofs during the hand) | Fewer steps | Nobody could check the board as it comes | — | — |
| **The dealer turns up each street with nonces; players show their own two cards at the showdown** | Every card on the table is checked at once; the showdown doesn't need the dealer | One step per street from the dealer's app | — | — |
| No timers (as Call Bridge) | Simplest | A closed app stalls a betting game for everyone | — | — |
| **30 s timers: an absent player checks (or folds to a bet); an absent dealer passes; an absent player at the showdown mucks** | Betting never stalls; every proxy move is deterministic, so every client checks it | A dealer that stays away voids its hand (bets go back) | — | — |

## Decision
1. **Rules:** no-limit Texas Hold'em, 2–6 players, play chips only. Starting chips 500 / 1,000 / 2,000 / 5,000 (default 1,000); blinds 10/20, doubling every 10 hands unless the host fixes them. Heads-up the button posts the small blind and acts first before the flop. A raise must be at least the last full raise; a short all-in does not reopen raising for players who already acted at that level. Side pots per all-in level; an uncalled bet comes back; an odd chip goes to the first winner left of the button. Out of chips is out; the last player with chips wins (places: chips, then who went out last, then who left). At most 1,000 hands (then places by chips). Folding is offered only when there is a bet to call.
2. **Solo:** the whole deck is in the state (xorshift deck per hand from a CSPRNG seed); dealing, turning up the board and showing hands are `auto` steps the solo controller plays after a pause (a new optional `TurnRules.auto` hook), so each is visible. The computer players read only their own cards, the board and the betting. The game ends when the user (seat 0) runs out of chips.
3. **Computer players** (solo only, ADR 0049): a Monte Carlo estimate of the chance to win (50 / 140 / 260 random deals of the unseen cards by level) against the pot odds. Easy adds noise, calls loosely and bluffs at random (6%); Medium bets strong hands (over 1.5× its fair share), calls with the price plus 3%, bluffs 8% after the flop against one or two players; Hard deals a raiser's cards from stronger starting hands, bets for value from 1.15× its fair share, bluffs 5%, and asks for a margin over the price facing a bet after the flop. Measured over 30 duplicate heads-up matches of 40 hands each (the same cards to each side once): Medium +79,772 chips against Easy (ahead in 30 of 30); Hard +58,970 against Medium (ahead in 18); Hard +167,978 against Easy. At a six-seat table Hard and Medium come out even, both far ahead of Easy.
4. **Friends, dealing (extends ADR 0052 item 2):**
   - At join each seat publishes the end of its **dealing chain** (32 bytes, `seat_data`): `chain[0] = SHA-256("pingdost/game/poker-chain/v1" ‖ seat seed)`, then the same `chainStep` as the dice chain, 1,024 links. Hand h is dealt from link `1023 − h`.
   - The button deals: deck = Fisher–Yates from `SHA-256("pingdost/game/poker-deal/v1" ‖ link ‖ salt ‖ game id ‖ h)`, where the salt is the latest by another device. It publishes a 16-byte commitment per used position (two per seat, then five for the board: at most 272 bytes), and sends each seat its two cards with their nonces privately (Olm, ADR 0052 item 3). A seat's app checks its private cards against the commitments.
   - It turns up the flop, turn and river as steps with each card's nonce; every client checks them. At the showdown each player's app shows their two cards with nonces (automatically; the shared state shows only cards turned up). The pots are paid at once.
   - At the hand's end the dealer shows its link; every client checks it hashes down to the seat's last shown link (or the anchor), recomputes the deal and compares every commitment. A mismatch sets *a deal didn't match* (`badDeal`).
   - **Accepted limits:** the dealer's device knows every hand of its deal (an honest app never shows them); once the link is shown, a modified app could work out the folded hands too.
5. **Timers (30 s, the frame's proxies):** an absent player checks, or folds facing a bet; at the showdown their cards stay down (muck: they give up the pot). An absent dealer passes: before the deal the next seat deals (that hand number is skipped, its link never used); during the hand the hand is called off and every bet goes back; at the end its deal goes unchecked (counted). Three in a row take a player out, as in the other timed games. Leaving folds the leaver's hand; a leaving dealer calls the hand off.
6. **Store wording:** "Play chips: no real money, nothing to buy and nothing to win" in the setup, rules and store listing. No chip purchases, prizes, real-money links or gambling ads, ever. Play's policy page was read on 2026-11-22; recheck before release (`docs/release/play-console.md`).
7. **No new dependency.** Hand evaluation is our own (best five of seven as one comparable number). Cards reuse Call Bridge's drawing; the table cloth is `gameBoardColors().felt` in ui-tokens (contrast-tested).

## Consequences
- Wire (additive): `GameType.POKER = 9`, `PokerSettings` (`GameCreate.settings` 14), `PokerMove` (`GameMove.play` 10): action/amount, commitments, positions/cards/nonces, reveal, muck, pass.
- Frame: `TurnRules.auto` (solo steps nobody chooses) and `TurnRules.note` (a status line such as "Bob is dealing…" or the hand's result); `TurnBoardProps.names` on both apps. The deck helpers moved from Call Bridge to `core/deck.ts` (same code).
- Every fold re-folds a game from its first event (as for all games); a long Poker game (hundreds of hands, about 12 events each) costs more per event than the other games. A cached prefix fold is the fix if it shows on phones.
- Phase 47 builds it; ROADMAP, CHANGES and CLAUDE.md were updated.

## Evidence
- `pnpm --filter @pingdost/games test`: hand ranking, pots, betting rules, solo games at each level, the duplicate-match strength test, dealing proofs, a pinned deal vector, wire round trips; friend games over `foldTurnGame` and `TurnNetController` (three devices, hidden hands, proved cards, checked deals; an absent player taken out after three proxies).
- `apps/server/test/games.int.test.ts`: three hands in a group of three through the real server; no seat secret in any frame.
- Play Console Help, "Real-Money Gambling, Games, and Contests", https://support.google.com/googleplay/android-developer/answer/9877032 (read 2026-11-22).
