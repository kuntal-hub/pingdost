# Phase 41 — Games A: games core, Ludo vs computer, Games tab

**Goal:** a Games tab on both apps where the user plays Ludo against 1–3 computer players at Easy, Medium or Hard. The rules, board geometry and computer players live in a shared pure-TypeScript package that Phase 42 reuses for games with friends.

**Depends on:** 31 (design system). User request 2026-11-21 (CHANGES; ADR 0049).

**Read first:** ADR 0049 (all), ADR 0035 (tokens, motion, haptics, floating navigation). Code: `packages/call-engine` (package layout), `packages/ui-tokens/src/schemes.ts` (`AVATAR_COLORS`) and `src/index.test.ts`, the phone tab bar (`apps/mobile/src/components/floating-tab-bar.tsx`, `src/app/(app)/(tabs)/`), the web shell (`apps/web/src/shell/app-shell.tsx`, `src/app.tsx`).

No wire, server or native change: the phone build stays as installed.

## Tasks
Built 2026-11-21 (ADR 0049).
- [x] **`packages/games` (`@pingdost/games`)**, pure TypeScript, no dependencies:
  - [x] `core`: `GameDefinition` (the shared shape; each game adds its own move functions), `Random` (`cryptoRandom` with an unbiased die, `seededRandom` for tests), the catalog (Ludo available; the others listed as coming), local stats. The solo runner is `ludo/solo.ts` + `ludo/controller.ts` (the controller paces rolls, hops and computer turns, and is what the screens subscribe to).
  - [x] `ludo/board`: a 52-square track, home columns, start and star squares, each color's path, and 15×15 grid coordinates shared by both apps. `ludo/drawing` describes the board as shapes, so both apps draw the same board.
  - [x] `ludo/rules`: Ludo King-style classic. Toggles: tokens 4 or 2, need a 6, blockades (walls), stop at the first winner. Auto-move is a player preference, not a rule.
  - [x] `ludo/bot`: Easy (random legal move), Medium (goals for the moved piece), Hard (values the whole board, risk priced by stake, threats, the leader counted most, one roll of lookahead; well under 30 ms a move).
  - [x] Tests: every rule and toggle, geometry, 1,000 seeded bot games end with only legal moves, Medium beats Easy 84%, Hard beats Easy 92% and Medium 65% (400 seeded games each), controller with fake timers, save round trip.
- [x] **ui-tokens:** `gameBoardColors(dark)` (red, green, yellow, blue: fill, ring, `on`, soft yard; board, cell, line), fixed across schemes; tests: ring ≥ 3:1 on cells, board, `surface` and `background` in every palette, glyph ≥ 3:1 on its fill, ring ≥ 3:1 in its yard, pairwise ΔE ≥ 30. `gamePlayerShapes`: circle, square, triangle, diamond.
- [x] **Phone:** the Games tab (Chats, Calls, Games, Settings): catalog, "Continue" for a saved game, the record per level; setup (computer players 1–3, difficulty, color, rule toggles, "Move by itself"); the Ludo screen (react-native-svg board, Reanimated hops, dice with haptics, movable pieces pulse and are labelled for screen readers, result card, Play again, menu with New game, Rules, End). The save and stats go in the encrypted settings (`games`, `game_solo`).
- [x] **Web:** the same Games page, setup and Ludo page (SVG board and pieces, `pd-piece`/`pd-roll`/`pd-beckon` with Calm and Off, keys Space/R and 1–4, dialogs for the result and rules). The save and stats go in localStorage next to the appearance prefs.

## Done when
- [x] `pnpm --filter @pingdost/games test`, `pnpm --filter @pingdost/ui-tokens test`, mobile and web typecheck, lint and test; prettier clean (12/12 turbo tasks, 2026-11-21).
- [x] Web dev page in Chrome: full games against 1 and 3 computer players, each difficulty; Motion Off. (Hard × 3 classic, Easy × 1 and Medium × 1 quick; a reload mid-game and on the result.)
- [x] Phone: the routes bundle in Metro; a full game on the emulator (adb): a classic game and a quick game against Easy, resume after leaving and after Fast Refresh.
  - **Open (user):** the feel at Full motion on a real phone (hops, dice, haptics); adb cannot read the screen while those animations loop.

## Handoff notes
- Phase 42 reuses the board, rules, controller and screens with network seats: `SeatKind` already has `friend`; the controller today refuses to wait on anyone but the user and computers (`#settle` throws for `friend`), which is where remote turns plug in.
- `uiautomator dump` cannot read the game screen while Motion is Full (the beckoning die and pulsing pieces never let the UI go idle). Set Motion to Off for adb-driven checks.
- The web Ludo page has no turn timers or pause; leaving the page keeps the game (it is saved after every roll and move).
