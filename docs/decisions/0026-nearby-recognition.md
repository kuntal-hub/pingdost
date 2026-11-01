# 0026 — Nearby recognition stays key-based (no contact-only tags)

- **Status:** Accepted
- **Date:** 2026-11-01
- **Phase:** 23
- **Approved by user:** n.a. (ADR 0024 asked Phase 23 to weigh it)

## Context
ADR 0024: in the nearby handshake each phone proves its stable Ed25519 device key, so a stranger who records it can recognise the phone again. Before the mesh relay (ADR 0025) makes phones link to many strangers, ADR 0024 asked for a decision on contact-only recognition, where only contacts could recognise a phone. ARCHITECTURE A10 forbids custom cryptography.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| **Keep the key-based handshake (chosen)** | Standard signatures; already built and tested. Peers need the key anyway to check relay ACKs. | A stranger can recognise a phone it linked to before. |
| Per-contact tags from a shared secret (Briar-style handshake keys) | Strangers learn nothing stable. | A new key agreement and derivation scheme with its own review; every contact pair needs a secret, set up while online. Relays would then need another way to check ACKs. |
| Rotating per-link ephemeral keys certified by the device key, shown only to contacts | Hides the key from strangers. | Contacts must find each other without a stable identifier: the same problem as above, plus certificate handling. |
| Randomised Hello for strangers, real key only after a contact match | Simple idea. | The match needs something stable or shared (back to the first two rows). |

## Decision
Keep ADR 0024's handshake for Phase 23. A stranger may learn and recognise a phone's public device key; it cannot resolve the key to an account through PingDost. The Settings texts say so (Nearby messaging, Nearby relay). Relaying is a separate opt-in, so users who do not want more strangers to link can leave it off. Nearby messaging itself is also off by default.

## Consequences
- The privacy notice (Phase 27) states that nearby and relaying expose a stable device key to phones in range.
- Revisit if a reviewed, standard protocol for private contact discovery over BLE becomes available, or with iOS (Phase 30), which needs the same handshake.
- No code change in this phase.

## Evidence
- ADR 0024 Consequences; ADR 0025 Consequences ("Relays see").
- Briar's Bramble protocols (design reference only, not used) are the known example of contact-only tags: a separate key agreement, per-contact tags and rotation. Not re-checked against their current docs in this session; check before any future work on this.
