# 0052 — Dealing hidden hands: self-dealt draws, a rotating dealer, private game events

- **Status:** Accepted
- **Date:** 2026-11-22
- **Phase:** 45 (46 and 47 use it)
- **Approved by user:** n.a. (ADR 0049 item 9 left the method to this ADR; the product name "Last Card" is recorded in CHANGES 2026-11-22)

## Context
Card games need hands that only their owner sees, with no server that deals and no custom cryptography (ARCHITECTURE A10). Every client must still check that each card played was really the player's, and a closed app should not stall the others where avoidable. Phase 45 builds a shedding card game ("Last Card", the mechanics of UNO-style games under a generic name and our own card art: UNO is a trademarked game); Phase 46 builds Call Bridge, which needs a real 52-card deal (no duplicate cards).

## Options considered
| Option | Pros | Cons | License | Cost |
|---|---|---|---|---|
| Mental poker (commutative encryption) | No trusted party | Custom cryptography (forbidden), slow | — | — |
| **Self-dealt draws**: each seat commits to its own draw secrets at join; card = hash(secret, someone else's salt) | Nobody else ever knows a hand, not even the host; no dealer, so a closed app never blocks a draw; every played card is checked against its commitment | Cards are drawn with replacement (the mix of a real deck, not its exact counts); a modified app can know its own next draw before drawing | — | — |
| A host dealer for the whole game | Real deck | The host sees every hand; every draw waits for the host's app to be open | — | — |
| **Rotating dealer per round** with jointly random deals and per-card commitments, hands sent over Olm to each seat | Real deck without duplicates; the dealer can't stack the deck; players can't play cards they weren't dealt | That round's dealer knows all hands (an honest app never shows them); a dealer that is offline delays the round | — | — |

## Decision
1. **Last Card (self-dealt draws):**
   - At `create`/`join` each seat publishes 128 draw commitments in `seat_data`: 16 bytes each, `SHA-256("pingdost/game/draw-commit/v1" ‖ secret_k)`, where `secret_k = SHA-256("pingdost/game/draw-secret/v1" ‖ seat seed ‖ k)`. The seed is Phase 42's seat secret and never leaves the device. `start` copies each seat's data and adds a fresh `salt`.
   - Draw k of a seat is `SHA-256("pingdost/game/draw/v1" ‖ secret_k ‖ salt ‖ game id ‖ seat ‖ k)` mapped onto the 108-card mix (rejection-sampled). The salt is one the drawer did not choose: for the opening hand, the other seats' salts plus the start salt (the host: the other seats' salts only); during play, the latest salt by another device (for a card forced on the next player, the salt of the move that forced it). The fold keeps each draw's salt in the public state.
   - Only the owner can compute their cards. Playing a card reveals `secret_k`; every client checks it against the commitment and recomputes the card.
   - An absent player's turn (30 s timer) is played for them without their secrets: draw one (hidden) and pass. Three in a row take them out.
   - **Accepted limits:** cards come with replacement (no card counting; in theory more than four Wild Draw Fours could appear), and a modified app can know its own next draw before deciding to draw. The "only when you have no card of the color" rule for Wild Draw Four can't be checked by others, so it is not a rule here.
2. **Call Bridge (rotating dealer, Phase 46):**
   - The round's dealer derives the deal from its hash-chain secret for that round (committed at join, Phase 42) and the other seats' latest salts, so neither it nor anyone else can steer the deal.
   - It publishes a 16-byte commitment per card position in a public deal step, and sends each seat its 13 cards with their nonces as a **private game event** over Olm to that seat's device.
   - Each card played carries its position and nonce, checked against the commitment.
   - At the round's end the dealer reveals its secret: everyone recomputes the deal and checks every commitment, hand and revoke. A mismatch marks the game out of sync.
   - **Accepted limit:** the dealer's device knows every hand of its round.
3. **Private game events (engine):** `sendGameEvent(…, { to: { userId, deviceId } })` sends one Olm device item (direct header, as for receipts) and does not store the event on the sender. Receivers store it as a game event of that game without touching the game's record or card, and accept it from a member of the game's group even outside the circle. The public fold ignores private events.
4. **The frame:** `TurnRules.hidden` hooks (`seatData`, `setupNet`, `applyNet`/`isLegalNet` with salts and SHA-256, `personalize`, `prove`, dealer hooks) let the turn fold and controllers run hidden-hand games. Solo games keep full information (the computer players see what a dealer would), with the randomness supplied by the solo setup.

## Consequences
- Wire (additive): `GameCreate.seat_data`, `GameJoin.seat_data`, `GameSeat.seat_data`, `GameStart.salt`, `Game.deal` (private), plus each game's settings and move messages.
- Last Card's scoring: the first to empty their hand wins; the others are placed by the cards they hold. Card points (numbers at face value, action cards 20, wilds 50) are shown only in solo games, since the others' hands are never revealed in games with friends.
- Poker (Phase 47) uses the rotating dealer.

## Evidence
- Code read 2026-11-22: device items claim Olm keys themselves (`outbox.ts`), direct content needs the 1:1 header (`content.ts` `checkHeader`), the circle drop in `receive.ts` (exempted only for private game events from group members). Envelope limit 64 KiB (`packages/config`): four seats' draw commitments in a `start` are about 8 KiB.
