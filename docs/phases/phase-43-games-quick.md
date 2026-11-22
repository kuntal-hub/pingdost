# Phase 43 — Games C: quick games (Tic-Tac-Toe, Connect Four, Dots and Boxes, Snakes and Ladders)

**Goal:** four short games on the Phase 41–42 base, each with solo play (computer players only when alone; the user picks how many where the game allows more than one, and the difficulty) and play with friends in chats, on phone and web.

**Depends on:** 42. ADR 0049 (third amendment: the turn-game frame).

**Read first:** ADR 0049; `packages/games` (`GameDefinition`, session, hub); the Ludo screens on both apps.

## Tasks
- [x] One frame for turn games in `@pingdost/games`: `TurnRules` (`core/turn.ts`), `TurnController` (solo), `foldTurnGame` + `TurnNetController` (friends; steps, proxy moves, skips, three strikes, leaves), solo saves, labels, `any-game.ts` (fold and summary for any type). The lobby moved to `core/net.ts` and Ludo's fold uses it.
- [x] Rules, bots and tests: Tic-Tac-Toe (Easy random-ish, Medium sees one move each way, Hard perfect minimax), Connect Four (alpha-beta at depth 2 with slips / 4 / 6), Dots and Boxes (Easy slips, Medium greedy and safe, Hard adds the last-safe-line search and double-dealing), Snakes and Ladders (dice only; PingDost's own layout).
- [x] Wire: `GameType` 2–5, one settings and one move message per game in `games.proto` (Snakes and Ladders: settings only, a roll is its turn), `GameRoll.state_hash`; regenerated, vectors added.
- [x] Boards on both apps: phone react-native-svg + Reanimated CSS keyframes (marks pop, discs drop and bounce, lines draw, boxes pop, pieces walk then climb or slide); web SVG with `pd-mark-in`, `pd-drop`, `pd-draw-line` (Calm and Off in `styles.css`) and the Web Animations API for the walk. Colors from ui-tokens (`cellAlt`, `label`, `frame`, `ladder`, `snakes`, `dot`; contrast-tested).
- [x] Snakes and Ladders uses Phase 42's fair dice (hash chains, salts).
- [x] Friend games follow Ludo's pattern (pure fold, network controller, `simGames` in the sim client; `peer` answers `!ttt`, `!c4`, `!dots [2-4] [3-6]`, `!snakes [2-4]`).
- [x] From Phase 42: "Play with friends" on every game screen (pick a chat); the game screen's chat button shows the unread count and new messages show as toasts; the chat shows a "Back to the game" pill; Rematch after a game (phone and web, Ludo included).

## Done when
- [x] Package, mobile and web tests, typecheck, lint; protocol vectors.
- [x] Friend games through the real server: `games.int.test.ts` plays Connect Four one to one and Snakes and Ladders in a group of three (sim clients, E2EE).
- [ ] Each game: a solo game per difficulty and a friend game against the sim peer (web and phone). **Not run**: no browser (the Chrome extension was not connected) and no phone or emulator attached this session.

## As built (2026-11-22)
- Routes: phone `game/setup?game=`, `game/play?game=`, `game/pick-chat?game=`, `game/start?conversationId=&game=`; `game/[gameId]` picks Ludo or the turn screen by the game's type. Web `/games/:game/setup`, `/games/:game`, `/games/friends/:game`; `/games/play/:gameId` picks the page; `/chat/:id?startGame=<type>` opens the invitation with that game.
- Stores: phone setting `game_turn_solo`; web `pingdost.game-turn-solo`; setups per game in the existing prefs.
- Hard Tic-Tac-Toe answers an empty board from a short list (every square draws); the search took 9 s over 400 test games on a loaded PC.
- Friend results are not counted in the local stats (a reopened finished game would count twice); the Games tab shows records against the computer only.
