# Phase 44 — Games D: Chess

**Goal:** Chess with full rules (castling, en passant, promotion, check, mate, stalemate, threefold repetition, fifty-move rule, insufficient material), solo against the computer at Easy / Medium / Hard, and with a friend in a chat (2 seats; group members watch), on phone and web.

**Depends on:** 42. ADR 0049.

**Read first:** ADR 0049; `packages/games`.

*Outline: refine the task list when the phase starts.*

## Tasks
- [ ] Rules in `@pingdost/games` (own move generator, or a permissive-licensed rules library after a license and version check; no chess engine binary). Perft tests against the standard positions.
- [ ] Bot: alpha-beta with a small evaluation, depth by level, a time budget so the UI never stalls (web worker / interaction-friendly chunks on the phone if needed).
- [ ] Optional clocks are not in scope (friend games are slow play; ADR 0049).
- [ ] Wire: `ChessSettings`, `ChessMove` (from, to, promotion).
- [ ] Board and pieces as SVG on both apps (piece art drawn in-house or OFL/CC0 sets after a license check); move hints, last move, check highlight; drag and tap to move.

## Done when
- [ ] Perft and rules tests; package, mobile and web checks; vectors.
- [ ] Solo per difficulty and a friend game against the sim peer.
