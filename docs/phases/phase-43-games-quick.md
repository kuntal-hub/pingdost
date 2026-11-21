# Phase 43 — Games C: quick games (Tic-Tac-Toe, Connect Four, Dots and Boxes, Snakes and Ladders)

**Goal:** four short games on the Phase 41–42 base, each with solo play (computer players only when alone; the user picks how many where the game allows more than one, and the difficulty) and play with friends in chats, on phone and web.

**Depends on:** 42. ADR 0049.

**Read first:** ADR 0049; `packages/games` (`GameDefinition`, session, hub); the Ludo screens on both apps.

*Outline: refine the task list when the phase starts.*

## Tasks
- [ ] Rules, bots (Easy / Medium / Hard: Tic-Tac-Toe and Connect Four by depth-limited minimax, Dots and Boxes by chain counting, Snakes and Ladders has no choices, so only the dice) and tests in `@pingdost/games`.
- [ ] Wire: one settings and one move message per game in `games.proto` (additive; vectors).
- [ ] Boards on both apps (SVG/views; tokens from ui-tokens; motion through the existing helpers).
- [ ] Snakes and Ladders uses Phase 42's fair dice.

## Done when
- [ ] Package, mobile and web tests, typecheck, lint; protocol vectors.
- [ ] Each game: a solo game per difficulty and a friend game against the sim peer (web and phone).
