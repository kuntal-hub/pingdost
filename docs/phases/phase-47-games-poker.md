# Phase 47 — Games G: Poker (Texas Hold'em, chips only)

**Goal:** Texas Hold'em with play chips only (no money, no purchases, nothing redeemable), with friends (2–6 seats) and solo with computer players at Easy / Medium / Hard, on phone and web.

**Depends on:** 45 (dealing). ADR 0049.

**Read first:** ADR 0049 and Phase 45's dealing ADR (0052); `packages/games`. Decisions: ADR 0053.

## Tasks
- [x] Rules (`packages/games/src/poker/rules.ts`): no-limit Hold'em, blinds 10/20 doubling every 10 hands (or fixed), heads-up blinds, minimum raise = the last full raise, a short all-in doesn't reopen raising, side pots and uncalled bets, odd chips left of the button, busts and places, at most 1,000 hands.
- [x] Hand ranking (`poker/hands.ts`): the best five of seven as one number; names and phrases for the table; starting-hand strength.
- [x] Computer players (`poker/bot.ts`): Monte Carlo equity against pot odds; bluff rates and sample counts by level; Hard reads raises. Solo only (ADR 0049).
- [x] Solo play: the deck in the state, dealing / board / showdown as `auto` steps (new `TurnRules.auto`); the game ends when the user is out of chips.
- [x] Friends (ADR 0053): a dealing chain per seat (`seat_data`), the button deals with per-position commitments and private hole cards, turns up each street with nonces, players' apps show their cards at the showdown, the dealer shows its link at the end and every client checks the deal. 30 s timers: check or fold, muck at the showdown, an absent dealer passes.
- [x] Wire (additive): `GameType.POKER`, `PokerSettings`, `PokerMove`; engine type name; chat-core label; catalog entry available.
- [x] Table UI on both apps: phone `screens/games/turn/poker-board.tsx`, web `features/games/turn/poker-board.tsx` (pot and side pots, five shared cards, the last hand's result, showdown hands, your cards with what they make, fold / check-call / raise with presets; web keys F, C, R). Seat lines in the players' strip (`pokerSeatLine`). Table colors `gameBoardColors().felt` (contrast-tested). Setup options: starting chips, blinds go up. Boards receive seat names (`TurnBoardProps.names`).
- [x] Sim peer: `!poker [2-6]`.
- [x] Store wording: "Play chips: no real money, nothing to buy and nothing to win" in the setup, rules and store listing; Play's gambling policy read 2026-11-22 and recorded in `docs/release/play-console.md` (recheck before release).
- [ ] Web: Poker solo at each level, and a friend game with `sim-client peer`s (`!poker` in a 1:1 chat; `!poker 3` in a group with two peers).
- [ ] Phone: the same on a device (the bundle compiles in Metro; nothing was run on a device).

## Done when
- [x] Hand-ranking and pot tests; bots; vectors; solo per difficulty; a friend game with sim peers.
  - `pnpm --filter @pingdost/games test`: `poker/poker.test.ts` (17 tests: ranking ladder, wheel, kickers, two trips, ties, phrases, equity, side pots, heads-up order, minimum raise and short all-in, solo games against each level, save/restore mid-hand, the user busting ends solo, Medium > Easy and Hard > Medium in duplicate matches, a pinned deal vector, hidden hands and proofs, absent player / dealer / shower, wire round trips, result lines) and `core/turn-network.test.ts` (three devices through `TurnNetController`; an absent player taken out after three proxies).
  - `apps/server/test/games.int.test.ts`: three hands of Poker in a group of three sim clients through the real server (all deals checked, no seat secret in any frame).
- [ ] Browser and phone runs (above).
