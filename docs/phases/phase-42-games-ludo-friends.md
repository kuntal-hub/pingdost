# Phase 42 — Games B: Ludo with friends in chats (E2EE moves, fair dice)

**Goal:** start Ludo from any 1:1 chat or group; friends join from the invite card and play turn by turn, live or over hours (offline players catch up from the mailbox; phones also play over nearby and the mesh). The Games tab shows your turn, active games, invites and friends online. No computer players in friend games.

**Depends on:** 41 (rules, screens), 37 (circles), 17 (web chat). ADR 0049.

**Read first:** ADR 0049, ADR 0011 (outbox, control items), ADR 0014 (ops), ADR 0016 (groups), ADR 0041 (circle drop), ADR 0006 (codecs, vectors), ADR 0020 (web leader and bus). Code: `packages/protocol/proto/pingdost/v1/content.proto`, `packages/message-engine/src/{engine,receive,store}.ts`, `apps/mobile/src/screens/chats/chat.tsx` (`PICK_ACTIONS`, `Bubble`), `apps/web/src/features/chats/{chat-view,bubble}.tsx`, `apps/web/src/chat/{client,leader,bus}.ts`.

## Tasks
- [x] **Protocol:** `games.proto` (`Game { game_id, seq, oneof event { create, join, start, roll, move, skip, leave, end, emote } }`, `LudoSettings`, `LudoMove`) and `Content.game = 16`; `gen`; `checkContent` (sizes, caps, one emoji); `make-vectors` (deliberate wire change); `buf lint`. A turn is a `roll` (reveal, commitment, salt) then a `move` (ADR 0049 amendment).
- [x] **Timers (friend games only; ADR 0049 amendment):** 30 s to roll and 30 s to move, two countdowns around the active avatar.
  - If the player's app is open when time runs out, it rolls, then makes the deterministic Medium move.
  - Any client may send that deterministic move after a `roll` whose move is late.
  - If no `roll` comes by the deadline plus 10 s of grace, another player's app sends `skip`; clients accept it only after deadline plus 5 s on their own clock.
  - After 3 skips in a row the player is removed.
  - Tests: skip and auto-move convergence, clock skew, removal.
- [x] **Invites from everywhere:** "Play a game" in 1:1 chats and groups, the Games tab (friends online, chats), and "Play with friends" on the game screen (pick a chat). The invite card is a message, so it notifies like one.
- [x] **Engine:** `MessageKind` `game` (the invite card), `GameRecord` / `GameEventRecord`, `WriteBatch.games` / `gameEvents` / `deleteGames` (cascade on conversation delete), `getGame` / `listGames` / `listGameEvents`; `sendGameEvent` (own copy + card on create + control fanout; the seat seed stored in the same write), `onGameEvent`; receive `case 'game'` with `game` in `GROUP_BODIES` and `DIRECT_CONTENT`; cards take reactions, not edits; history sync leaves games out. Memory store and `runEngineStoreContract` cases; phone migration 011 and store; `DexieEngineStore` next version (sealed payloads and seeds).
- [x] **chat-core:** preview "Ludo game"; selection rules (no copy or forward for cards).
- [x] **`@pingdost/games`:** `fair-dice` (seed, nonces, commitments, rolls, verification), `session` (log fold: lobby, auto-start when full, seq buffer, dedupe, leave at the leaver's next turn, end, state hash, invalid), `hub` (`GameHub` over an engine-like API: summaries and actions create/join/start/move/leave/end/emote/rematch). Tests: convergence under seeded shuffles and duplicates, leave and end, tampered reveal and wrong device rejected, hash mismatch reported.
- [x] **Phone:** "Game" tile in the chat "+" sheet → picker (rules toggles; 1:1 = 2 seats, group up to 4); `game-card.tsx` in the bubble switch (Join, Start, Open, Watch, result); `game/[gameId]` route with network seats; chat while playing (Chat button with unread badge, "Back to game" pill, message toasts, emote bar); Games tab lists (your turn, active, invites, friends online with Invite); presence-watch registry (open chat first, 32 max); "It's your turn" local notification (respects mute; not while the game is on screen).
- [x] **Web:** paperclip → menu (Send a file, Start a game); game card in `bubble.tsx`; the game as a side pane in the chat view (`?game=<id>`, board/chat toggle on narrow screens); Games page lists; bus wiring (`ENGINE_METHODS`, `onGameEvent`, `BusMessage` `game`); presence registry in the leader.
- [x] **Sim client:** `SimClient` games API (hub + Medium bot); `sim-client peer --games` joins invites and plays.
- [x] **Tests:** `packages/message-engine/src/games/*.test.ts` (1:1, Megolm, dedupe, cascade); `apps/server/test/games.int.test.ts` (1:1 with one side offline mid-game, 3-player group with a watcher, leaving, a stranger's event dropped, WS frame scan).

## As built (2026-11-22)
The tasks above were written before the build; ADR 0049's second amendment holds where they differ.
- Done:
  - Protocol, engine, stores (memory, phone migration 011, Dexie version 4), chat-core and notification text.
  - `@pingdost/games`: `core/fair-dice.ts` (a hash chain fixed at join, not per-turn commitments), `ludo/network.ts` (a fold over slots `turn`/`index`; the lowest event ID wins a slot; no `seq` buffer is needed) and `ludo/network-controller.ts` (presentation, the 30 s timers, auto-play, skips and proxy moves, three-skip removal). Labels and summaries are in `ludo/labels.ts`.
  - Sim client: `simGames` (`tools/sim-client/src/games.ts`) in place of a hub; `peer` plays by default (`--games false` turns it off; `!ludo [2-4]` starts a game).
  - Phone: the Game tile in the "+" sheet → `game/start` (rules, seats in groups); `screens/chats/game-card.tsx`; `game/[gameId]` (`ludo-net-screen.tsx`: lobby, board, names, timer rings, emotes, Open the chat, Leave, End for everyone); Games tab lists and Friends online; `watchPresence(ids, key)`; `games/turn-notifier.ts`.
  - Web: attach menu (Send a file, Start a game); `game-card.tsx`; `/games/play/:gameId` (`ludo-net-page.tsx`); Games page lists and Friends online; bus wiring; `mergedWatch` in the leader.
- Built differently: the web game is its own page with a chat button, not a side pane; there is no `GameHub` class (each app folds per game with hooks; `simGames` drives sim clients); receivers do not check clocks on skips.
- Not built (moved to Phase 43): "Play with friends" on the game screen; while playing, the chat's unread badge, a "Back to game" pill and message toasts; rematch.

## Follow-up: the last player in wins at once (rules change 2026-11-22; ADR 0049 amendment)
- [x] `foldLudoGame`: when the leaves in hand would leave exactly one player in, they take effect at once and that player wins, without finishing their turn. Other leaves still wait for the leaver's next slot. The turn games already worked this way; a test now checks every turn game (Call Bridge ends at the first leave, as before).
- [x] Checks: `network.test.ts` (a group of three, the other two leave during the stayer's turn, the same end in any order), `games.int.test.ts` 9/9.
  - **Open (user):** a 3-player group game where the other two leave.

## Done when
- [x] Protocol gen has no drift; vectors test passes.
- [x] Engine, games, chat-core, web-store, mobile and web tests, typecheck and lint pass (repo-wide `pnpm lint`, `typecheck`, `test`, `format:check`).
- [x] `pnpm --filter @pingdost/server test:int` passes in full: 29 files, 199 tests (2 skipped), games suite included.
- [ ] Chrome: a game web ↔ `sim-client peer` to the end. Played the lobby, start, rolls and moves, card and lists in Chrome; not played to the end there (the end is covered by `games.int.test.ts` and the timer-only game in `network.test.ts`).
- [ ] Device (user): phone ↔ sim peer, phone ↔ web, and a 3-person group game with two sim peers. The new routes bundle in Metro; the emulator's app was signed out, so no on-device run yet.

## Handoff notes
- Phase 43 adds games through `GameDefinition` only; the wire gets one settings and one move message per game (additive).
