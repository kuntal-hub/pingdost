# 0050 — Ludo look and feel: 3D pins, corner panels with dice, glowing yard, stacks, generated sounds

- **Status:** Accepted
- **Date:** 2026-11-21
- **Phase:** 41 (follow-up; the user's list after trying it)
- **Approved by user:** yes, the product choices (CHANGES 2026-11-21: sounds with a switch, always 4 pieces). The technical choices need no approval.

## Context
After trying Phase 41 the user asked for:
- more vivid graphics and smoother motion;
- a realistic 500–1000 ms dice roll in the roller's color;
- bouncing moves and 3D-looking pieces;
- always 4 pieces;
- a glowing yard for the active player;
- dice in each player's corner;
- stacks of pieces with a count;
- fair dice, with sound.

ADR 0049 still holds: no game engine, the same look on phone and web, Motion and Haptics settings respected.

## Options considered
| Option | Pros | Cons | License | Cost |
|---|---|---|---|---|
| Sound files (CC0 packs) | Real recordings | Assets to vet and ship on both apps; size | varies | — |
| **Sounds generated in code** (noise bursts, decaying tones) in `@pingdost/games` | No assets, no license question, identical on both apps, tiny | Synthetic character | — | none |
| A 3D library (three.js, Skia 3D) for dice and pieces | True 3D | A game-engine-like dependency, bundle size, native work | MIT | — |
| **Shaded 2D**: radial-gradient pins with a ground shadow, a gradient die with a tumble keyframe | Light, both apps, themable | Not true 3D | — | none |

## Decision
1. **Pieces are pins:** a map-pin outline, a radial gradient (each color's `light` → `fill` → `dark`), a white head with the color-blind shape, and a soft ground shadow.
   - The geometry is `LUDO_PIN` in `@pingdost/games`, drawn with react-native-svg on the phone and SVG on the web.
   - Movable pins bob and their base ring pulses (static at Motion Calm/Off).
2. **Colors:** `gameBoardColors` gains `light` and `dark` per player (gradients, the die, pins). Fills are more vivid; the contrast tests still hold in every scheme.
3. **Moves:** each square is an arc (lifted at mid-hop), with a squash on landing. A capture flies home after the mover lands. Pace: roll 800 ms, hop 170 ms. At Calm and Off, pieces jump and the waits shrink (ADR 0035).
4. **The die** is a rounded cube with a gradient in the roller's color and a tumble (two turns, bounces, faces changing) for the whole roll, then a settle.
5. **Corner panels:** each player has a panel at the screen corner nearest their yard (after the board turns, the user is always bottom left). It shows name, shape, pieces home or the finishing place, and that player's die: full size when they are rolling, small with their last roll otherwise. The user rolls by tapping their own die. Phase 42's timers draw around the avatar.
6. **The active yard glows:** a pulsing outline and glow (a static outline at Calm and Off).
7. **Stacks:**
   - Pieces of one color on one square draw as one stack (slightly offset upward, so it looks piled) with a count badge.
   - Different colors on a safe square sit side by side, one stack each.
   - A landing makes the stack pop.
   - `ludoStacks()` in `@pingdost/games` computes the layout for both apps.
8. **Always 4 pieces:** `LudoSettings.tokens` is gone. Restoring a saved 2-piece game fails, and it is dropped.
9. **Sounds:** `synthesizeGameSound(kind)` (`roll`, `hop`, `capture`, `home`, `win`) makes mono PCM, and `encodeWav` wraps it.
   - **Phone:** the WAVs are written once to the cache and played with expo-audio (no audio-mode change, so voice notes and calls are untouched).
   - **Web:** Web Audio buffers, made on the first tap.
   - A **Game sounds** switch (on by default) sits in setup and in the game menu.
   - Android has no silent-mode check without native code: there, game sounds follow the media volume and the switch.
10. **Dice fairness** is unchanged: the CSPRNG with rejection sampling (solo), commit-reveal (friends).

## Consequences
- Both apps' Ludo screens were reworked (corner panels instead of the strip, the die in the panels). Phase 42 reuses them with friend seats and adds the timers around the avatars.
- Tests: the stack layout, the sound synthesis (length, range, WAV header) and the tokens-always-4 restore.

## Evidence
- expo-audio 58.0.9 and expo-file-system 58.0.10 are already in the app (voice notes, attachments). The web uses Web Audio (no CSP change).
