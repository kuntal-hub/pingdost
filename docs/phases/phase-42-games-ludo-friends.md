# Phase 42 — Games B: Ludo with friends in chats (E2EE moves, fair dice)

**Goal:** start Ludo from any 1:1 chat or group; friends join from the invite card and play turn by turn, live or over hours (offline players catch up from the mailbox; phones also play over nearby and the mesh). The Games tab shows your turn, active games, invites and friends online. No computer players in friend games.

**Depends on:** 41 (rules, screens), 37 (circles), 17 (web chat). ADR 0049.

**Read first:** ADR 0049, ADR 0011 (outbox, control items), ADR 0014 (ops), ADR 0016 (groups), ADR 0041 (circle drop), ADR 0006 (codecs, vectors), ADR 0020 (web leader and bus). Code: `packages/protocol/proto/pingdost/v1/content.proto`, `packages/message-engine/src/{engine,receive,store}.ts`, `apps/mobile/src/screens/chats/chat.tsx` (`PICK_ACTIONS`, `Bubble`), `apps/web/src/features/chats/{chat-view,bubble}.tsx`, `apps/web/src/chat/{client,leader,bus}.ts`.

## Tasks
- [ ] **Protocol:** `games.proto` (`Game { game_id, seq, oneof event { create, join, start, turn, leave, end, emote } }`, `LudoSettings`, `LudoMove`) and `Content.game = 16`; `gen`; `checkContent` (sizes, caps, one emoji); `make-vectors` (deliberate wire change); `buf lint`.
- [ ] **Engine:** `MessageKind` `game` (the invite card), `GameRecord` / `GameEventRecord`, `WriteBatch.games` / `gameEvents` / `deleteGames` (cascade on conversation delete), `getGame` / `listGames` / `listGameEvents`; `sendGameEvent` (own copy + card on create + control fanout; the seat seed stored in the same write), `onGameEvent`; receive `case 'game'` with `game` in `GROUP_BODIES` and `DIRECT_CONTENT`; cards take reactions, not edits; history sync leaves games out. Memory store and `runEngineStoreContract` cases; phone migration 011 and store; `DexieEngineStore` next version (sealed payloads and seeds).
- [ ] **chat-core:** preview "Ludo game"; selection rules (no copy or forward for cards).
- [ ] **`@pingdost/games`:** `fair-dice` (seed, nonces, commitments, rolls, verification), `session` (log fold: lobby, auto-start when full, seq buffer, dedupe, leave at the leaver's next turn, end, state hash, invalid), `hub` (`GameHub` over an engine-like API: summaries and actions create/join/start/move/leave/end/emote/rematch). Tests: convergence under seeded shuffles and duplicates, leave and end, tampered reveal and wrong device rejected, hash mismatch reported.
- [ ] **Phone:** "Game" tile in the chat "+" sheet → picker (rules toggles; 1:1 = 2 seats, group up to 4); `game-card.tsx` in the bubble switch (Join, Start, Open, Watch, result); `game/[gameId]` route with network seats; chat while playing (Chat button with unread badge, "Back to game" pill, message toasts, emote bar); Games tab lists (your turn, active, invites, friends online with Invite); presence-watch registry (open chat first, 32 max); "It's your turn" local notification (respects mute; not while the game is on screen).
- [ ] **Web:** paperclip → menu (Send a file, Start a game); game card in `bubble.tsx`; the game as a side pane in the chat view (`?game=<id>`, board/chat toggle on narrow screens); Games page lists; bus wiring (`ENGINE_METHODS`, `onGameEvent`, `BusMessage` `game`); presence registry in the leader.
- [ ] **Sim client:** `SimClient` games API (hub + Medium bot); `sim-client peer --games` joins invites and plays.
- [ ] **Tests:** `packages/message-engine/src/games/*.test.ts` (1:1, Megolm, dedupe, cascade); `apps/server/test/games.int.test.ts` (1:1 with one side offline mid-game, 3-player group with a watcher, leaving, a stranger's event dropped, WS frame scan).

## Done when
- [ ] Protocol gen has no drift; vectors test passes.
- [ ] Engine, games, chat-core, web-store, mobile and web tests, typecheck and lint pass.
- [ ] `pnpm --filter @pingdost/server test:int` passes in full (including `redis-budget` and the games suite).
- [ ] Chrome: a game web ↔ `sim-client peer --games` to the end.
- [ ] Device (user): phone ↔ sim peer, phone ↔ web, and a 3-person group game with two sim peers.

## Handoff notes
- Phase 43 adds games through `GameDefinition` only; the wire gets one settings and one move message per game (additive).
