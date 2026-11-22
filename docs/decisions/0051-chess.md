# 0051 — Chess: own move generator, in-house pieces, slow play, draw offers with a move

- **Status:** Accepted
- **Date:** 2026-11-22
- **Phase:** 44
- **Approved by user:** n.a. (technical choices inside the plan of ADR 0049; no new dependency)

## Context
Phase 44 adds Chess on the turn-game frame (ADR 0049 third amendment): full rules, a computer player at three levels, games with friends in chats (two seats; group members watch), on phone and web. The phase file left open whether to write a move generator or use a permissive library, and where the piece art comes from. ADR 0049 says friend games of this kind are slow play (no clocks).

## Options considered
| Option | Pros | Cons | License | Cost |
|---|---|---|---|---|
| **Own move generator (0x88 board, make/unmake, perft-tested)** | No dependency; the search uses the same board; small | Must be proven correct | ours (AGPL) | none |
| A JS chess rules library | Proven | A dependency in both apps and the rules package; its board is not built for a search; version and license checks for every update | varies (some GPL, some BSD/MIT) | none |
| A chess engine binary or WASM build | Strong play | Heavy, native/WASM build work, nothing a casual game needs; ADR 0049 rules out engines | varies | none |
| Piece sets from the web (CC BY-SA, GPL, …) | Polished | Attribution and share-alike terms; mixed licenses | various | none |
| **Pieces drawn in-house as shapes both apps draw** | No license question; themable from ui-tokens | Simpler look | ours | none |

## Decision
1. **Rules** (`packages/games/src/chess/`): `position.ts` is a 0x88 board with pseudo-legal generation filtered by make/unmake, castling rights by square masks, en passant, promotion, FEN in and out, and perft. `rules.ts` keeps the game state as JSON (FEN, the seat playing White, repetition keys since the last pawn move or capture, the moves in SAN, the last move, a standing draw offer, how it ended). Threefold repetition, the fifty-move rule and insufficient material end the game **automatically** (no claim step), as in most apps.
2. **Correctness:** perft on five standard positions (start to depth 4, Kiwipete to 3, positions 3, 4 and 5) matches the published counts; rules tests cover castling through check, en passant, promotion, SAN disambiguation, mate, stalemate and each draw.
3. **Computer player** (`bot.ts`): iterative-deepening negamax with alpha-beta, a capture search at the leaves, killer moves, and an evaluation worked out by formula (material, centralisation, pawn advance, bishop pair, king shelter then king activity). Easy searches 1 ply and picks among moves within 1.5 pawns of the best (15% of moves at random); Medium about 3 plies (0.7 s budget); Hard up to 6 plies (1.6 s). The search **yields to the event loop between root moves** (about every 12 ms), so the phone and the web keep drawing and taking taps; no worker is needed. Chess has no proxy moves, so its bot may use a time budget (the deterministic fixed-depth rule only applies to games with timers).
4. **Wire (additive):** `GameType.CHESS = 6`; `ChessSettings { host_side }` (drawn, White, Black); `ChessMove { from, to, promotion, offer_draw, accept_draw }` with squares 0–63. A draw is offered **with a move** and stands for one reply: the other player accepts on their turn (`accept_draw` instead of a move) or declines by playing on.
5. **Slow play:** `turnMs` is null: no timers, no proxy moves, no skips. Resigning is a `leave`, which applies at once (ADR 0049 third amendment, item 5).
6. **Pieces:** six silhouettes on a 45×45 grid in `chess/drawing.ts`, drawn by react-native-svg on the phone and SVG on the web. Board, piece and highlight colors are `gameBoardColors().chess` in ui-tokens (contrast-tested: outlines on both squares, black pieces on dark squares, coordinates as text).
7. **Boards:** tap a piece then a square, or drag it; dots for moves, rings for captures; the last move and a king in check tinted; a picker for promotion; the board turned for Black; the moved piece slides in. On the phone a screen reader turns every relevant square into a button; on the web the movable pieces and their targets are focusable.

## Consequences
- No new dependency; nothing to license-check. The chess search and rules are the only code that knows chess.
- Solo games have Resign; friend games have Resign, Offer a draw (with the next move) and Accept. Solo games have no draw offers.
- The sim peer starts a game on `!chess` and plays Medium; `games.int.test.ts` plays a few moves and a resignation through the real server.
- Phase 44's file, ROADMAP, CHANGES 2026-11-22, CLAUDE.md and ARCHITECTURE A4 (through ADR 0049) were updated.

## Evidence
- 2026-11-22: perft counts (start 20/400/8902/197281; Kiwipete 48/2039/97862; position 3 14/191/2812/43238; position 4 6/264/9467; position 5 44/1486/62379) all match in `chess.test.ts` (16 tests, about 2–3.5 s).
- A 150 ms budget on Kiwipete returned within the bound and left the position unchanged (`chess.test.ts`).
