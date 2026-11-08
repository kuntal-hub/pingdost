# Phase 18 — Recent-history sync (phone → web) + web attachments

**Depends on:** 15, 17 · **Platforms:** Android, web, server (ephemeral relay)

## Goal
After pairing, the browser gets a configurable recent-history window from the phone. The transfer is end-to-end encrypted, batched and resumable, and the **server stores nothing**. Older history and attachments arrive on demand.

## Read first
- REQ §10.2, §13.2 (all), §14.2, §19.5 (sync bullet)
- ARCHITECTURE A3 (ephemeral), A4

## Tasks
- [x] **Sync protocol ADR:** (ADR 0021)
  - **Request:** the web sends `SyncChunk{request: window SYNC_RECENT_DAYS / max messages per conversation}` to the phone over the Olm session between own devices, as an **ephemeral** envelope. The server relays it in memory to online devices only; nothing is written to Redis or Mongo.
  - **Batches:** the phone builds bounded batches (conversations + group state + messages + receipt states + attachment manifests, no attachment bytes + small encrypted thumbnails optional) with a cursor stored in `device_sync_state`.
  - **Integrity and resume:** each batch carries a hash and a sequence number, and the web acknowledges each one. The final manifest holds per-conversation counts for an integrity check. Pause/resume works via the cursor, and duplicates are skipped by messageId.
  - **Availability:** if either side goes offline, the sync pauses with an honest status ("Phone offline — sync paused").
- [x] **Server:** an ephemeral relay frame type with size limits and rate limits. Add a test proving that no Redis or Mongo writes happen (command counter + Mongo profiler/spy).
- [x] **Phone UI:** sync progress in Linked devices. **Web UI:** a progress bar, pause/resume, and a "Load older messages from phone" button per conversation (a scoped request).
- [x] **Web attachments:**
  - **Download:** if the staged object is still on the server and this device is a recipient, download and decrypt it (`@pingdost/attachments` `decryptStream` over the WASM provider → Blob; ADR 0004 dropped libsodium). Otherwise request the bytes from the phone over the ephemeral relay in chunks (size cap, configurable; default 25 MB, with an honest message beyond that).
  - **Cache:** an IndexedDB LRU with a size limit setting.
  - **Send from web:** encrypt and upload via Phase 14. Images can be compressed in the browser (canvas). There is no video compression on web in v1; send the original if it is ≤ the limit, else reject with an explanation.
  - Viewers for images, video, audio and documents (download).
- [x] **Tests:** sync engine unit tests (batching, resume after interruption, dedupe, integrity mismatch), and a sim-client integration test (phone-like + web-like clients) with mid-sync disconnects.

## Key files
`packages/message-engine/src/sync/*`, `apps/server/src/modules/gateway/connection.ts` (`#onEphemeral`; no separate `ephemeral.ts`), `packages/web-store/src/file-cache.ts`, `apps/mobile/src/sync/*`, `apps/web/src/{sync/*,attachments/*}`

## Out of scope
Recovery backups (19).

## Done when
- REQ §19.5 sync: only the configured window syncs by default; older history works on request; resume works after killing the web tab mid-sync; tests prove there are no server-side writes.
- Web views and sends images and docs.
- `pnpm lint typecheck test` passes.

**Real-phone checks 2026-11-08:** after pairing, the chat history came from the Nothing ("sent from your other device", safety notices included); "Load older messages from phone" answered (0 older: nothing outside the window). The web sent a text file (82 B) and a photo (157 KB, sent as 17 KB with Standard quality); both arrived on the vivo, and the web shows the photo. Still open: resuming after killing the tab mid-sync, and a photo received on the web from a phone.

## Handoff notes
**From Phase 14 (ADR 0017):**
- A web device can download a staged attachment only if it was in `recipientDeviceIds` when the sender uploaded. `engine.attachmentRecipients` lists the devices current at send time, so files sent before pairing come from the phone (the relay path above).
- The web store (Dexie) must keep `MessageRecord.attachment` (manifest JSON, file key included) inside the encrypted records, and pass `runEngineStoreContract`, which now covers attachment messages.
- Send from web: `engine.attachmentRecipients` → `encryptStream` → `uploadAttachment` → `engine.sendAttachment`, as on Android (Phase 15 notes).

**From Phase 15 (ADR 0018):**
- Reuse `@pingdost/attachments`:
  - `downloadCiphertext` (streamed, `Range` resume, expired-link renewal, `gone` / `network` / `aborted` errors; give it the browser `fetch`);
  - `verifyStream` (check everything before `ack`);
  - `uploadAttachment` with `signal` for pause/cancel;
  - `planVideo` / `scaledSize` / `IMAGE_PRESETS` / `THUMBNAIL_PRESET` (480 px JPEG, at most 256 KiB);
  - `buildManifest({ media })` for width, height, duration and waveform.
- Send: `engine.sendAttachment(id, manifest, { held: true })` stores the message while it uploads, then `engine.releaseAttachment(messageId)` sends it. Android's runner (`apps/mobile/src/attachments/transfers.ts`) is the model: thumbnail first, recipients fixed at the first attempt, release after the file upload completes.
- Android does not send file names for photos, videos or voice notes; only documents carry one.

**From Phase 16 (ADR 0019):** after pairing, the phone refetches its own directory (`engine.refreshDevices`), so new messages reach the browser. There is no Olm session between them until the first message: the sync request can open one (it is a normal own-device Olm session). The browser's device record has `userId`, `username`, `accountIdentityKey` and `linkedAt` (`LinkedDevice`).

**From Phase 17 (ADR 0020):**
- The web engine runs only in the leader tab (`apps/web/src/chat/leader.ts`). Run sync and attachment transfers there, and reach them from other tabs through the bus (`chat/bus.ts`; add message types rather than a second channel).
- `ChatClient` already relays `attachmentRecipients`, `sendAttachment` and `releaseAttachment`.
- `features/attachments/attachment-view.tsx` is the placeholder the bubble renders for attachments: replace it.
- Store-wise, a `device_sync_state` equivalent belongs in `packages/web-store` (a new Dexie version), sealed like the rest.
- Server tests can run a browser-like device on the Dexie store: `SimClient` with `store: new DexieEngineStore(...)` (see `apps/server/test/web.int.test.ts`).
## Outcome (2026-10-31, ADR 0021)
- The cursor (`device_sync_state`) is a sealed engine setting on both sides (`sync.source.<browser>`, `sync.sink`), not a new Dexie table: it is written in the same `apply` as each batch.
- The web's file cache is Dexie version 3 (`files`, `fileChunks`) in `packages/web-store`.
- Browser checks (real phone and Chrome) are listed in `docs/PROGRESS.md`.