# Phase 45 — Games E: hidden hands (dealing) + UNO

**Goal:** a way to deal cards so each player sees only their own hand, without a server and without custom cryptography; then UNO (2–4 players with friends; 1–3 computer players when alone).

**Depends on:** 42. ADR 0049 (item 9).

**Read first:** ADR 0049; ADR 0003 (Olm); `packages/games` session and fair dice.

*Outline: refine the task list when the phase starts.*

## Tasks
- [ ] **ADR: dealing hidden hands.** Candidates: a dealer device (the host) shuffles with commit-reveal randomness, sends each hand to its seat over Olm one to one, and reveals the deck's commitment at the end so every player can check the deal; a rotating dealer; per-card commitments. Mental poker is out (custom cryptography). Write down what the dealer can see and what an honest app shows.
- [ ] Direct per-seat events (hands) next to the shared log: the engine sends a game event to one device over Olm inside a group game.
- [ ] UNO rules (draw, skip, reverse, +2, wild, +4, UNO call, scoring), bots, wire, card UI on both apps.

## Done when
- [ ] Dealing tests (no hand visible to another seat in its events; deal verifiable at the end); UNO rules and bots; vectors.
- [ ] Solo per difficulty and a friend game with two sim peers.
