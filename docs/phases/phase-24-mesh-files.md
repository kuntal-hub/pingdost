# Phase 24 — Mesh / nearby file transfer (chunked, resumable)

**Depends on:** 15, 23 · **Platforms:** shared TS, Android

## Goal
Encrypted attachments move between devices without the Internet: direct or multi-hop, chunked, integrity-checked per chunk and for the whole file, and resumable after links drop. The recipient acknowledges only after assembling and verifying the full file. This completes the offline-mesh launch requirement.

## Read first
- REQ §10.2 (bullet 3), §11.4 (chunking bullet), §19.3 (last bullet)
- ADRs: attachment AEAD, nearby transport, mesh routing

## Tasks
- [ ] **Chunking:** split the already-encrypted attachment ciphertext into mesh chunks sized for the link: 64 KiB, the attachment format's own chunk (one BLE link packet holds up to 128 KiB, ADR 0023); larger only on a Wi-Fi path, if one is added.
  - Chunk packets carry the transfer ID, index, count and **chunk hash in the outer header**, so relays can drop corrupt chunks.
  - The manifest, with all chunk hashes, rides inside the E2EE message.
- [ ] **Receiver assembly:** a bitmap of received chunks; per-chunk hash verification; **missing-chunk requests** (resume) after reconnecting; full-file SHA-256 + AEAD verification before marking it complete. **Only then** send the delivered ACK/receipt (REQ §19.3).
- [ ] **Relays:** store chunks under the relay quota; forward with the Phase 23 policy; drop chunks after the mesh ACK for the transfer.
- [ ] **Direct bulk path (optional):** Nearby Connections is out (no Play Services; CHANGES 2026-10-31).
  - Evaluate Android's own **Wi-Fi Aware** first: platform API, and iOS 26 supports it (Phase 30).
  - Then **Wi-Fi Direct**, with the group name and passphrase exchanged over the BLE link (API 29+, no invitation dialog).
  - Use it between phones that both support it, fall back to BLE, and record the choice in an ADR. Check `NEARBY_WIFI_DEVICES` (Android 13+) and the license of any library.
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

## Handoff notes
**From Phase 22 (ADR 0024):**
- `NearbyPeerTransport.send` takes only `ENVELOPE` packets. Each one waits for the recipient's `Ack`, up to 256 envelope IDs per ACK and a 15 s timeout. For chunks, add a chunk path with its own ACK (by transfer ID and index) rather than one envelope ACK per chunk.
- `TransportRouter.route(deviceId)` says which path reaches a device now. Use it to choose between staged upload (Internet) and a direct transfer.

**From Phase 21 (ADR 0023):**
- **Realistic sizes over BLE:** at the expected 50–150 KB/s, 10 MB takes about 1–3.5 minutes and 100 MB about 11–35 minutes per hop. Set the default mesh file limit and the time estimate from the measured row in ADR 0023's matrix (pending at the end of Phase 21).
- The link's `send` applies backpressure (512 KiB queued per link), so a chunk pump that awaits `send` never overruns memory. `linkDown.unsent` tells how many chunks to re-request or resend.
- There is no Nearby Connections path (see the bulk task).

**From Phase 14 (ADR 0004, 0017):**
- The E2EE `AttachmentManifest` carries `chunkHashListSha256`, the SHA-256 of the list of per-64-KiB-chunk ciphertext hashes, not the list itself.
  - Send the list as the first mesh chunk (or add a manifest field with a protocol change), and check it against `chunkHashListSha256` before trusting per-chunk hashes.
  - `encryptStream` returns `chunkHashes`.
- Use the manifest's `attachmentId` (UUIDv7) as the mesh transfer ID; the receiver also checks `ciphertextSha256` and decrypts (AEAD per chunk) before sending the receipt.
- A file sent over the mesh needs no staged upload: send the manifest with `engine.sendAttachment` and skip `uploadAttachment`.

**From Phase 15 (ADR 0018):**
- Each attachment's local copy is its STREAM ciphertext at `<documents>/attachments/<attachmentId>`: the same bytes as the staged object. Send it as it is, and recompute the per-chunk hashes from it (the manifest has only the list's hash).
- A received copy goes into the vault the same way: append, `verifyStream`, mark the `attachments` row `done`.