# REQ §19 acceptance traceability

Every REQ §19 bullet → the automated test or manual check that covers it, with the latest result. **Auto** results come from the full runs of 2026-11-02 (Phase 27): `pnpm turbo run lint typecheck test` and `pnpm --filter @pingdost/server test:int` (see docs/PROGRESS.md for the counts). **Device** checks need phones or the VPS and are listed with their owner phase; they are open until someone records a result here.

Legend: ✅ pass · ⏳ open (manual, not yet run) · ⚠ covered in simulation only.

Paths: server tests are in `apps/server/test/`; engine tests in `packages/message-engine/src/`.

## 19.1 E2EE and server privacy

| Bullet | Covered by | Kind | Result |
|---|---|---|---|
| A network capture of a message through the backend holds only the encrypted envelope | `engine.int.test.ts` 8 (every WS frame scanned for a plaintext marker), 9 (attachment caption and key); `calls-webrtc.int.test.ts` (no SDP/ICE in frames); `sim-client start` (marker scan) | Auto | ✅ |
| MongoDB/Redis inspectors cannot recover plaintext or attachment keys | `engine.int.test.ts` 8 (every Redis value and Mongo document scanned), 9; `history-sync.int.test.ts` (no Redis/Mongo writes) | Auto | ✅ |
| Mesh device B forwards A→C but cannot decrypt or alter undetectably | `mesh/mesh.test.ts` "gives B ciphertext only…", "detects tampering at B…" | Auto (simulation) | ⚠ ✅ in sim · ⏳ three phones (Phase 23) |
| A removed group member cannot decrypt later messages | `groups.int.test.ts` "three members talk; a removed member cannot decrypt what follows"; `groups/groups.test.ts` | Auto | ✅ |
| Private and recovery keys never in server logs, analytics, crash reports or client env | `devices.int.test.ts` "keeps private keys off the server"; `platform.int.test.ts` "keeps passwords, OTPs, tokens…"; `engine.int.test.ts` 10 (debug-level logs scanned for plaintext, tokens, keys, ciphertext); `apps/mobile/src/log-hygiene.test.ts`, `apps/web/src/log-hygiene.test.ts`; `packages/config/src/public.test.ts` (only public values reach clients); no analytics or crash SDK (ADR 0030) | Auto + policy | ✅ |

## 19.2 Mailbox and deletion

| Bullet | Covered by | Kind | Result |
|---|---|---|---|
| An offline recipient's envelope is queued in Redis | `mailbox.int.test.ts` 1 | Auto | ✅ |
| At the stage boundary the worker migrates to Mongo, verifies, then deletes the Redis copy | `mailbox.int.test.ts` 2; 10 (a backlog larger than a batch drains in one run, Phase 27); load test (docs/ops/capacity.md) | Auto | ✅ |
| With Mongo down, the Redis copy stays and migration retries without loss | `mailbox.int.test.ts` 3, 7, 8 | Auto | ✅ |
| A delivery racing the migration gives exactly one logical delivery | `mailbox.int.test.ts` 4; `engine.int.test.ts` 3, 4 | Auto | ✅ |
| An ACK removes the envelope from Redis and Mongo; it is no longer fetchable | `mailbox.int.test.ts` 5 | Auto | ✅ |
| Undelivered envelopes expire ≤ 14 days after creation, not after migration | `mailbox.int.test.ts` 6; retention audit check "expiry beyond creation + retention" (`retention.int.test.ts`) | Auto | ✅ |
| The sender's local history stays after server-side expiry | `engine.test.ts` "expires undelivered messages, and a late receipt still counts" (asserts the sender's copy) | Auto | ✅ |

## 19.3 Attachments

| Bullet | Covered by | Kind | Result |
|---|---|---|---|
| Images and videos are compressed by default; opt-out when size permits | `apps/mobile/src/attachments/attachments.test.ts` "compresses photos by default and offers the original when it fits", "plans a video…" | Auto (logic) | ✅ · ⏳ real compression on a phone (Phase 15) |
| A file over 100 MB is blocked unless compression gets it under | `packages/attachments/src/attachments.test.ts` "applies the 100 MB limit…"; mobile "plans a video under the limit, and explains one that cannot fit" | Auto | ✅ |
| A non-compressible document over 100 MB is rejected with a clear message | mobile "rejects documents over the limit and empty files…"; `attachments.int.test.ts` "enforces the size limit, the quota and real recipients" | Auto | ✅ |
| Uploads carry encrypted bytes only; the store is private; signed URLs expire | `attachments.int.test.ts` "stages ciphertext only…", "lets signed URLs expire" (s3 half needs `--profile s3`); `engine.int.test.ts` 9 | Auto | ✅ (fs) · s3 half when SeaweedFS runs |
| The recipient's ACK deletes the staged object; a reaper removes expired, orphaned and partial uploads | `attachments.int.test.ts` "…deletes it on the last ACK", "janitor: …"; retention audit "staged attachment files" | Auto | ✅ |
| With no Internet on both ends, nearby mesh moves a file in chunks, verifies, resumes, and acknowledges only after full verification | `mesh/files.test.ts` (10 MB A→B→C with drops and resume, corrupt chunk, quota, pause/cancel) | Auto (simulation) | ⚠ ✅ in sim · ⏳ two phones (Phase 24) |

## 19.4 Offline and mesh

| Bullet | Covered by | Kind | Result |
|---|---|---|---|
| Two nearby devices exchange text with mobile data and Wi-Fi off | `routing/routing.test.ts` "exchanges text both ways in airplane mode…" | Auto (simulation) | ⚠ ✅ in sim · ⏳ two phones (Phase 22) |
| Three devices relay A→B→C; B cannot read it, C decrypts | `mesh/mesh.test.ts` "carries A → B → C…", "gives B ciphertext only…" | Auto (simulation) | ⚠ ✅ in sim · ⏳ three phones (Phase 23) |
| Duplicate encounters create no duplicate messages | `mesh/mesh.test.ts` "…duplicate encounters and the Internet create no duplicates"; `routing.test.ts` "does not duplicate…" | Auto | ✅ |
| Expired and over-hop packets are dropped | `mesh/mesh.test.ts` "drops expired and over-hop packets…"; `packages/mesh-protocol` tests | Auto | ✅ |
| Users opt in/out of relaying; off stops forwarding new third-party packets | `mesh/mesh.test.ts` "forwards nothing while relaying is off…"; `apps/mobile/src/nearby/relay.test.ts` | Auto | ✅ |
| The UI distinguishes local queue, relay acceptance and final delivery | `packages/chat-core` labels tests; mobile `nearby/status.test.ts` "names the path of a delivery", `attachments/mesh-status.test.ts`; `packages/shared-types` message-state tests | Auto (logic) | ✅ · ⏳ seen on a phone (Phase 22–23) |
| Real-device tests: foreground, background, screen locked, OS-killed, low battery, low storage, Bluetooth denied, airplane mode; failures degrade visibly | ADR 0023 device matrix; pause rules in `relay.test.ts` (battery, saver, storage); `status.test.ts` (Bluetooth off, permission denied wording) | Manual | ⏳ (Phases 21–24) |

## 19.5 Calls and web pairing

| Bullet | Covered by | Kind | Result |
|---|---|---|---|
| Audio/video calls work mobile↔mobile and web↔mobile | `packages/call-engine` manager tests; `calls-webrtc.int.test.ts` (two werift clients); Chrome ↔ sim peer (Phase 25 entry) | Auto + manual | ✅ (sim, Chrome) · ⏳ phone↔phone and phone↔web (Phase 26 matrix) |
| Direct WebRTC where possible, TURN when needed; no call recording | `calls-webrtc.int.test.ts` direct and TURN-forced, "no writes"; `calls.int.test.ts` (credentials on the running coturn) | Auto | ✅ (local coturn) · ⏳ staging coturn across networks (Phase 25) |
| No group call actions | mobile `calls/logic.test.ts` "offers voice and video calls in direct chats only; groups have none"; web `features/chats/chat-view.tsx` renders `CallButtons` only when `!isGroup` (code check) | Auto + code check | ✅ |
| QR pairing: one-time expiring challenge, phone approval, replayed or expired payloads refused | `pairing.int.test.ts` (approval, expiry, re-shown QR, wrong challenge, primary-only approval, signatures) | Auto | ✅ |
| Web history sync sends only the recent window and creates no server history | `sync/sync.test.ts` "sends only the recent window…"; `history-sync.int.test.ts` "…writes nothing on the server" | Auto | ✅ |
| Revoking a browser stops new access and revokes its authorization | `pairing.int.test.ts` "lets the phone revoke a linked browser…"; `devices.int.test.ts` revocation; `engine.int.test.ts` 7 | Auto | ✅ |

## Manual sign-off still needed
Before calling the product release-ready, record results here for: the ⏳ rows above (phone pairs for nearby/mesh/calls, real compression, the ADR 0023 background matrix) and the staging coturn check. Each owner phase's PROGRESS entry lists the steps.
