# Phase 24 — Mesh / nearby file transfer (chunked, resumable)

**Depends on:** 15, 23 · **Platforms:** shared TS, Android

## Goal
Encrypted attachments move between devices without the Internet: direct or multi-hop, chunked, integrity-checked per chunk and for the whole file, and resumable after links drop. The recipient acknowledges only after assembling and verifying the full file. This completes the offline-mesh launch requirement.

## Read first
- REQ §10.2 (bullet 3), §11.4 (chunking bullet), §19.3 (last bullet)
- ADRs: attachment AEAD, nearby transport, mesh routing

## Tasks
- [ ] **Chunking:** split the already-encrypted attachment ciphertext into mesh chunks sized for the link (from the nearby ADR, e.g. 16–64 KiB on BLE, larger on Nearby Connections).
  - Chunk packets carry the transfer ID, index, count and **chunk hash in the outer header**, so relays can drop corrupt chunks.
  - The manifest, with all chunk hashes, rides inside the E2EE message.
- [ ] **Receiver assembly:** a bitmap of received chunks; per-chunk hash verification; **missing-chunk requests** (resume) after reconnecting; full-file SHA-256 + AEAD verification before marking it complete. **Only then** send the delivered ACK/receipt (REQ §19.3).
- [ ] **Relays:** store chunks under the relay quota; forward with the Phase 23 policy; drop chunks after the mesh ACK for the transfer.
- [ ] **Direct bulk path:** if the nearby ADR enabled Nearby Connections (Android↔Android), use it for direct transfers and fall back to BLE.
- [ ] **Limits and UX:**
  - the mesh max file size is configurable (default per ADR measurements; REQ allows up to 100 MB, but show a realistic time estimate for BLE);
  - progress "12 / 200 chunks received", pause/resume, cancel;
  - the sender sees relayed vs delivered.
- [ ] **Tests:**
  - simulation: a 10 MB file across A→B→C with random link drops and resume;
  - a corrupt chunk injected → re-requested;
  - the final ACK only after full verification;
  - the relay quota respected.
- [ ] **Device test:** direct transfer of a 10 MB+ file between 2 phones in airplane mode with interruptions (walk out of range and back). Run multi-hop if a 3rd phone is available.

## Key files
`packages/mesh-protocol/src/chunks/*`, `packages/attachments/src/mesh.ts`, `apps/mobile/src/nearby/files*`

## Out of scope
Web nearby (browsers can't do this); iOS (30).

## Done when
- The REQ §19.3 last bullet is satisfied in simulation and on 2 devices (direct).
- ROADMAP notes **"Offline-mesh launch requirement met on Android"**.
- `pnpm lint typecheck test` passes.
