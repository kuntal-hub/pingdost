# 0021 — History sync (phone → web) and attachments on the web

- **Status:** Accepted
- **Date:** 2026-10-31
- **Phase:** 18
- **Approved by user:** n.a.

## Context
A newly linked browser has no history (REQ §13.2). The phone is the authority for it, and the server must not become a copy of it (REQ §1, §19.5: "does not create permanent server history"). The transfer must be bounded, resumable, deduplicated and integrity-checked, and say honestly when the phone is not there. The browser also needs attachments (REQ §10.2, §14.2). Files sent before it was linked were never staged for it, and the browser's storage is a cache that can be evicted.

## Decision
1. **Channel.** History travels inside the E2EE `Content` as `SyncChunk` (add-only fields 5–11 plus `SyncBatch` and friends in `content.proto`), Olm-encrypted between two devices of the same user and carried as `PACKET_KIND_EPHEMERAL`.
   - `OwnDeviceChannel` (`packages/message-engine/src/sync/channel.ts`) opens the session from a claimed one-time key when there is none (that session then serves ordinary messages too). It accepts only devices in the verified own directory and handles packets one at a time.
   - The server relays an ephemeral packet in memory to the recipient's live socket and answers `Accepted{DELIVERED_TRANSPORT}`. It answers `RECIPIENT_OFFLINE` if the recipient is not online, or its socket is behind. Nothing is written to Redis or Mongo, and the server holds nothing for later. REQ §13.2 would allow short-lived encrypted holding; we do not need it.
   - **Budgets:** 250 ephemeral packets and 8 MiB of payload per socket per 10 s (`maxEphemeralFrames`, `maxEphemeralBytes`), on top of the frame budget and `ENVELOPE_MAX_BYTES`.
   - **Metrics:** `pingdost_ephemeral_relayed_total{outcome}` and `pingdost_ephemeral_bytes_total`.
   - `Transport` gains `sendEphemeral` / `onEphemeral` (WS transport, router and fake server).
2. **Protocol** (stop-and-wait, driven by the browser):
   - **Request.** The browser sends `request{days, max_per_conversation, conversation_id?, before?, resume_after}`. Defaults: `SYNC_RECENT_DAYS` 30 (choices 7/30/90/365 in Settings) and `syncMaxPerConversation` 500 (`DEFAULT_LIMITS`).
   - **Batches.** The phone fixes the conversation order (most recent first) and sends one batch at a time: conversations, then group state, then messages newest first. Each batch is an encoded `SyncBatch` of at most 60,000 bytes, filled to about 44 KB, with a sequence number, `data_sha256` and progress (chats done of total).
   - **Contents.** Messages carry their receipt state, read time, edits, deletes and reactions, and the attachment manifests (keys included, no bytes). Never sessions, keys, or local-only fields (pins, archive, mute).
   - **Acks.** The browser checks the hash, stores the batch, and acknowledges it (`ack{ok}`). `ok=false` gets the same records again; more than 3 rejections in a row fail the sync.
   - **Manifest.** After the last batch, the manifest holds the batch count and messages per conversation. A mismatch with what arrived runs the sync once more from the start, and a second mismatch fails it ("didn't arrive intact").
   - **Device state.** The `device_sync_state` of REQ §14.1 is a sealed engine setting on each side, not a new table: `sync.source.<browser>` on the phone and `sync.sink` on the browser, the same on SQLCipher and Dexie.
     - The phone keeps the cursor after the last acknowledged batch and after the batch in flight. A request naming the same sync resumes after whichever batch the browser says it stored; anything else starts over.
     - The browser stores each batch's records and the new cursor in **one** `apply`, so killing the tab at any moment resumes after the last stored batch.
   - **Dedupe.** Messages are skipped by ID. Edits, deletes and reactions waiting for a message are applied when it arrives. Group records are taken when newer (by version), and group traffic held for them is retried.
   - **Notifications.** None: the commit emits no `received` events for synced messages.
   - **Availability.**
     - When the phone is offline, the browser says "Phone offline — sync paused" and tries again after 15 s, 30 s, 1 min, 2 min, then every 5 min.
     - When the browser itself is offline, it says so and resumes when the connection is back.
     - A 15 s watchdog asks again (resume) when no batch comes.
     - The phone answers only while its socket is open: in the foreground, or 30 s after. It has no push wake for this.
   - **Pause/resume.** Pause sets the browser's state paused and tells the phone (`ack{pause}`). A batch in flight is dropped and comes again on resume.
   - **Older messages.** "Load older messages from phone" is the same protocol scoped to one conversation: before its oldest message here, up to 200, of any age. It waits while another sync runs.
   - **Who.** Only own devices that are linked browsers (`platform: web` or `role: linked`) get history; anything else is refused (`stop{REFUSED}`).
3. **Files on the web** (`apps/web/src/attachments/*`, leader tab only, reached over the bus):
   - **Download.**
     - First the staged copy, when this browser was a recipient (`downloadCiphertext`, Range resume).
     - On `gone` (never staged for it, expired, or every device fetched it), the phone's vault copy over the same channel: `fileRequest{offset, length}` → `filePart`, 48,000 bytes each, 4 in flight.
     - The phone serves only a complete vault copy (`apps/mobile/src/sync/files.ts`): the same ciphertext as staged, so bytes already stored stay valid.
     - The limit for fetching from the phone is 25 MB (`syncFileMaxBytes`; 10/25/50/100 MB in Settings). Beyond it the bubble says why and to open the file on the phone.
     - Every copy is checked completely (`verifyStream`) before it is used, and only then is a staged copy acknowledged.
   - **Cache.** `FileCache` (`packages/web-store`, Dexie version 3: `files`, `fileChunks`) keeps each file as its own STREAM ciphertext in 1 MiB pieces. The key lives only in the sealed message record, so no second seal is needed.
     - The least recently used files go first beyond the limit (100 MB–2 GB, default 500 MB); files in use and pending uploads stay.
     - "Clear cache" never touches messages.
   - **Viewing.** Files are decrypted in the tab into a Blob and shown from an object URL held only by that tab (at most 40). Images, video and audio show inline; any other type gets the type `application/octet-stream` and is only ever saved, so a document can never run in PingDost's origin.
   - **Send.**
     - Images are compressed on a canvas (Standard 1600 px / HD 2560 px JPEG) unless sent as the original. Previews are 480 px JPEG from the image or a video frame.
     - There is no video compression in the browser: a video over 100 MB is refused, with the reason.
     - The file and its preview are encrypted into the cache, the message is stored held, both are uploaded for the recipients fixed at the first attempt, then the message is released.
     - Pending uploads are a sealed record and resume when the tab starts or the connection returns.
4. **CSP.** An optional `VITE_STORAGE_URL` adds the store's origin to `connect-src` for an S3 store; the default `fs` store is the API origin.

## Consequences
- **Phase 20:** set `VITE_STORAGE_URL` only if staging is S3. The ephemeral budgets are code defaults (no env).
- **Phase 25:** calls reuse `sendEphemeral` and the channel. `OwnDeviceChannel` must accept contacts' devices for `CallSignal`, and `HistorySync.receive` routes only `syncChunk` today.
- **Phase 27:**
  - each relayed packet reads the recipient device from Mongo (`activeDeviceOwner`), which could be cached;
  - the phone serves history only in the foreground;
  - video compression on the web, and viewing large videos without holding them whole, are open.
- A browser whose data was cleared re-pairs and syncs again; the server cannot rebuild history (REQ §13.2).

## Evidence
- `packages/message-engine/src/sync/sync.test.ts` (10 tests, real vodozemac, fake server):
  - window and batches, with nothing stored on the server;
  - resume after the tab is killed mid-sync (one sync, never restarted);
  - dedupe with the manifest still passing; a rejected hash sent again;
  - pause and resume; phone offline, then back; load older; group state;
  - a non-browser refused; file parts from the phone (and `missing`).
- `sync/sink.test.ts` (3): a wrong hash, a manifest mismatch (run again, then fail), a match.
- `apps/server/test/history-sync.int.test.ts` (real server, real pairing, the browser on the Dexie store), 240 long messages and a group:
  - the browser's socket drops, the tab is killed and reopened, and the phone goes offline and back;
  - every message arrives exactly once;
  - no Redis command writes and no Mongo command changes a document;
  - an uninterrupted sync uses **zero** Redis commands.
- `apps/server/test/gateway.int.test.ts`: `Accepted{DELIVERED_TRANSPORT}` for a relayed packet; `RATE_LIMITED` past the ephemeral budget.
- `packages/web-store/src/file-cache.test.ts` (3): pieces and ranges, resume after a lost buffer, LRU with files kept.
- `apps/web/src/attachments/transfers.test.ts` (3): from the phone in parts (real encryption), over the limit refused before fetching, a corrupted part leaves nothing cached.
