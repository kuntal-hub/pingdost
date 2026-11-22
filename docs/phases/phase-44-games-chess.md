# Phase 44 — Games D: Chess

**Goal:** Chess with full rules (castling, en passant, promotion, check, mate, stalemate, threefold repetition, fifty-move rule, insufficient material), solo against the computer at Easy / Medium / Hard, and with a friend in a chat (2 seats; group members watch), on phone and web.

**Depends on:** 42 (and Phase 43's turn-game frame). ADR 0049, ADR 0051.

**Read first:** ADR 0049; `packages/games`.

## Tasks
- [x] Rules in `@pingdost/games` with PingDost's own move generator (0x88, make/unmake, FEN, SAN; no dependency, ADR 0051). Perft tests against five standard positions.
- [x] Bot: iterative-deepening alpha-beta with a capture search and a small evaluation, depth and time budget by level, yielding to the event loop between root moves so the UI never stalls (no worker needed).
- [x] No clocks (friend games are slow play; ADR 0049): `turnMs` null, so no timers, proxy moves or skips.
- [x] Wire: `GameType.CHESS`, `ChessSettings { host_side }`, `ChessMove { from, to, promotion, offer_draw, accept_draw }`; vector added.
- [x] Board and pieces on both apps (pieces drawn in-house, colors from ui-tokens, contrast-tested); move hints, last move, check highlight; tap and drag to move; promotion picker; the board turned for Black; the moved piece slides in.
- [x] Resign (solo and friends), draw offers with a move and Accept (friends), the moves in SAN under the board, a "Check" note.
- [x] Sim peer: `!chess`; `games.int.test.ts` plays Chess through the real server (moves, then a resignation).

## Done when
- [x] Perft and rules tests; package, mobile and web checks; vectors.
- [x] A friend game through the real server between sim clients (moves in SAN agree on both sides, resignation, no desync).
- [ ] Solo per difficulty and a friend game against the sim peer, on web and phone. **Not run**: no browser (the Chrome extension was not connected) and no phone or emulator attached this session.

## As built (2026-11-22)
- Threefold repetition, the fifty-move rule and insufficient material end the game automatically (no claim step).
- Easy picks among moves within 1.5 pawns of its best and plays 15% of moves at random; Medium searches about 3 plies (0.7 s), Hard up to 6 plies (1.6 s). On a phone (Hermes) the same budgets reach shallower depths.
- On the phone, a screen reader turns the movable pieces and their targets into buttons (tap to move); otherwise one touch responder handles taps and drags.
