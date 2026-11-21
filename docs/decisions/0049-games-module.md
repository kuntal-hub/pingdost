# 0049 — Games module: games inside chats, E2EE moves, shared rules, fair dice, computer players only when alone

- **Status:** Accepted (Phase 41 builds the core and solo play; Phase 42 the wire, engine and friends)
- **Date:** 2026-11-21
- **Phase:** 41, 42 (43–47 add games on the same base)
- **Approved by user:** yes, the product choices (opponents, computer players, Ludo rules; CHANGES 2026-11-21). The technical choices need no approval.

## Context
The user asked for a games module: simple multiplayer games (Ludo first, then Tic-Tac-Toe, Chess, UNO, Call Bridge, Poker and more) played with friends inside a chat, a Games section (browse games, friends online, your games), and a play-with-computer mode with difficulty levels for every game. No game engines, nothing heavy, and no personal data shared. Rewards (coins, points) may come later.

Games are not in REQ. The rules that apply are the privacy promise (REQ §1, §5; ARCHITECTURE A10), Circles (ADR 0041: nobody can contact you without your consent), E2EE for everything users exchange (A5), and "no custom cryptography".

The user decided (2026-11-21):
1. **Opponents:** circle friends and group members only. No matchmaking with strangers.
2. **Computer players:** only when someone plays alone from the Games screen. They pick how many computer players (Ludo: 1–3) and the difficulty. Never in a game with friends. The rule holds for every game.
3. **Ludo defaults:** Ludo King-style classic. The host can change the toggles.

## Options considered
| Option | Pros | Cons | License | Cost |
|---|---|---|---|---|
| Server lobby and server-run games (authoritative state, matchmaking) | Easy fairness, timers, strangers | The server learns who plays whom and what; breaks Circles and the privacy promise | — | VPS load |
| **Moves as E2EE `Content` through the normal outbox (control fanout), rules checked by every client** | Same privacy as messages; works for offline players (mailbox) and over nearby/mesh; groups via Megolm; no server change | Old builds show placeholders; fairness needs care (dice) | — | none |
| Moves over the ephemeral channel (like call signals) | Nothing stored on the server even briefly | 1:1 only, online only, no nearby/mesh; a closed app loses the game | — | none |
| Dice rolled by the mover's own device | Simplest | A modified app picks its own rolls | — | — |
| **Hash commit-reveal dice (SHA-256 commitments)** | Neither the roller nor anyone else steers a roll; standard construction on an existing primitive | A player can stall after seeing a bad roll | — | — |
| Mental poker (commutative encryption) for cards | No trusted dealer | Custom cryptography (forbidden); slow | — | — |
| A game engine (Phaser, Unity, Godot, Skia game kits) | Effects, physics | Heavy bundles, native builds, nothing these board/card games need | various | — |
| **Plain views: react-native-svg + Reanimated on the phone, SVG/DOM on the web** | Already installed; light; themable through ui-tokens | More hand-written animation | MIT | none |

## Decision
1. **Games live in conversations.** A 1:1 chat or a group is the room; there are no other rooms. The server keeps no games, lobbies, results or stats, and cannot tell a game event from a message. Group members who don't take a seat can watch. Starting a game from the Games tab picks a chat (or opens the friend's 1:1 chat).
2. **Wire (Phase 42).** A new E2EE body `Content.game = 16` (`proto/pingdost/v1/games.proto`; padding keeps field 15):
   - `Game { game_id (16 B, the create event's message ID), seq, oneof event { create, join, start, turn, leave, end, emote } }`.
   - It is sent like a reaction: an engine **control fanout** through the normal outbox (Olm to the peer and one's own devices in 1:1; Megolm in groups). The mailbox delivers it to offline players, so a game can go on for hours or days. On phones it also travels over nearby and the mesh with no Internet (A4).
   - The receive path treats it as direct content: the circle drop (1:1) and the member check (Megolm) apply, as for text.
   - `create` also stores a chat row of the new message kind `game` (the invite card); every other event is stored only in the engine's game log (`GameRecord`, `GameEventRecord`), never as a bubble.
3. **Shared deterministic rules.** `@pingdost/games` is pure TypeScript with no React and no platform code. Each game is a `GameDefinition` (setup, current seat, legal moves, apply, result, bot). Every client checks every event and folds the log into the same state:
   - **Lobby:** `create` (host, game type, settings), then `join`s, then the host's `start`, which fixes the seats in order. A full table starts by itself; the host may start early with at least the minimum. Joins after `start` are ignored (the joiner watches).
   - **Turns:** `seq` = the number of turn events before it. Only the seat whose turn it is may send turn `seq`; events wait in a buffer until the gap fills, and duplicates are dropped by event ID.
   - **Leaving:** a leave takes effect at the leaver's next turn. Nobody can move past that turn without the leaver, so every client applies it at the same point. When fewer than the minimum remain, the game ends. The host can **End for everyone** at any time.
   - **Divergence:** every turn carries an 8-byte state hash (SHA-256 of the canonical state after the move). A mismatch or an illegal move marks the game *out of sync*; the UI offers End game. Nothing is ever repaired silently.
4. **A seat belongs to the device that joined** (the sender device ID, which Olm/Megolm authenticate). One's other devices (a linked browser) watch the game ("Playing on your phone"). There are no two-device races and no seat secrets to share between devices.
5. **Fair dice without a server** (Ludo, Snakes and Ladders, later dice games): a hash commitment scheme over `CryptoProvider.sha256` (sync on both platforms; no new primitive, no new dependency).
   - At `join` the seat device draws a 32-byte random seed and stores it with the join event in one engine-store write (sealed on the web). The seed never leaves the device.
   - The seat's i-th nonce is `SHA-256("pingdost/game/nonce/v1" ‖ seed ‖ i)`. Each of its events (join, turns) publishes `commit = SHA-256("pingdost/game/commit/v1" ‖ nonce)` for its next turn, and a fresh 16-byte random salt.
   - Roll j of turn k = an unbiased die (rejection sampling) from `SHA-256("pingdost/game/roll/v1" ‖ reveal_k ‖ salt_of_event_k−1 ‖ game_id ‖ k ‖ j)`, where `reveal_k` is the nonce behind the roller's last commitment. The roller committed before the previous salt existed, and the previous author chose the salt without knowing the reveal, so neither can steer the roll. Every client checks `SHA-256(ctx ‖ reveal) = commit` and recomputes the rolls.
   - Accepted limits: a player who dislikes a roll can stall (indistinguishable from someone who left the app); a modified app can see its own later rolls within the same turn. Both are fine for games among friends with nothing at stake.
   - Solo games roll with `crypto.getRandomValues`.
6. **Computer players only when alone.** Solo games run entirely on the device: the user's seat plus 1..max−1 computer seats at Easy, Medium or Hard. Friend games have only humans. Every game ships a bot with three levels, built in the rules package (heuristics and small searches; no engines or models).
7. **Rendering without a game engine.** Phone: `react-native-svg` for static boards (memoized), Reanimated for pieces and dice, `haptic()` and `useMotion()` so Motion and Haptics settings hold. Web: SVG attributes and React `style` (CSSOM; the CSP forbids only `<style>` elements and style attribute strings), `pd-*` motion classes in `styles.css` with Calm and Off. Colors come from `@pingdost/ui-tokens` `gameColors`. Each player color also has a shape so color-blind players can tell pieces apart.
8. **Stats stay on the device** (wins and games per game, in the encrypted settings). Rewards, coins or leaderboards would need a separate privacy decision: anything kept on the server would be a new record of who plays.
9. **Card games with hidden hands** (UNO, Call Bridge, Poker) need a way to deal cards nobody else can see. Mental poker is custom cryptography; the likely answer is a dealer device that shuffles and sends each hand over Olm one to one, with commitments revealed at the end. It is decided in Phase 45's ADR.
10. **Old builds** (before Phase 42) store each game event as an "Update PingDost" placeholder. That is accepted: there is no public release yet, and the phone change is JS-only.

## Consequences
- New package `packages/games`; new tab Games on both apps (order Chats, Calls, Games, Settings); `gameColors` in ui-tokens with contrast tests.
- Phase 42 adds the wire body, the engine API (`sendGameEvent`, `listGames`, `getGame`, `listGameEvents`, `onGameEvent`), a store migration on both apps, the web bus methods, a presence-watch registry (the open chat and the Games tab share the 32-user limit), "your turn" local notifications, and a sim-client player for device checks.
- History sync leaves game rows out: a browser linked after a game started shows it as playing on the phone. Backups (`.pdbk`) leave games out.
- No timers in friend games (they suit slow play over the mailbox). A stuck game is left or ended by the host.
- Phase files 41–47 were written with this ADR; ROADMAP, ARCHITECTURE A4 and CHANGES 2026-11-21 were updated.

## Evidence
- Code read 2026-11-21: `Content` oneof (`content.proto:35-53`; padding at 15), control fanout (`engine.ts` `#controlFanout`), receive allow-lists (`receive.ts:55-57`, circle drop at `:531`), the ephemeral channel (1:1 only, `sync/channel.ts`), `CryptoProvider.sha256` (sync), `watchPresence` (replaces the list, at most 32), web CSP (`style-src 'self'`; React `style` uses the CSSOM).
- Installed and reused: react-native-svg 15.16.0, react-native-reanimated 4.7.1, react-native-gesture-handler 3.3.0, expo-haptics 58.0.7, lucide-react 1.70 (web), Lucide per-icon imports (phone). No new dependency.
