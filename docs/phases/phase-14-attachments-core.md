# Phase 14 — Attachments core (+ object-store spike)

**Depends on:** 09 · **Platforms:** shared TS, server

## Goal
Encrypted attachment pipeline and temporary server staging:
- client-side streaming encryption and manifests;
- size and type rules;
- an `AttachmentStore` with `fs` and `s3` adapters;
- resumable chunked upload with integrity checks;
- short-lived signed URLs;
- deletion on ACK, and a janitor for expired, orphaned and partial uploads.

## Read first
- REQ §7.4, §10 (all), §16.4, §19.3, §22 (storage line)
- ARCHITECTURE A2 (Attachment staging), A5 (Attachments), A8 (Sizes)
- The attachment AEAD ADR

## Tasks
- [ ] **`packages/attachments`** (platform-neutral):
  - `encryptStream` / `decryptStream`: per-file random key, secretstream header, 64 KiB plaintext chunks (per the ADR). It works on async iterables of `Uint8Array`, so mobile and web can feed file chunks;
  - SHA-256 of the whole ciphertext, plus per-transfer-chunk hashes (1 MiB chunks) for resume and mesh;
  - an `AttachmentManifest` builder/validator (key, header, size, mime, sha256, chunk hashes, optional encrypted thumbnail, staging ref);
  - **MIME sniffing** by magic bytes (images, video, audio, pdf, zip-based docs, etc.); extensions are never trusted;
  - **size rules** per REQ §10.1: `canSend(file, {compressible, compressedEstimate})` returns ok / needs-compression / reject-with-reason; only images and videos are compressible;
  - unit tests with large synthetic streams.
- [ ] **Server `attachments` module:**
  - collection `attachments` (REQ §16.4 fields: objectId, ciphertextBytes, sha256, createdAt, expiresAt, pendingRecipientDeviceIds, ackedDeviceIds, status uploading|ready|deleting, uploaderDeviceId);
  - **no keys and no plaintext metadata.**
  - **Endpoints:**
    - `POST /v1/attachments`: validate size ≤ `ATTACHMENT_MAX_BYTES` + AEAD overhead, the per-user quota (`ATTACHMENT_USER_QUOTA_BYTES`), and that the recipients are valid. Returns `uploadId` + signed chunk URLs (TTL `ATTACHMENT_PRESIGNED_URL_TTL_SECONDS`).
    - `PUT` chunk; `GET /v1/attachments/:id/status`, which lists received chunks for resume.
    - `POST .../complete`: the server verifies the total size + streaming SHA-256, then sets `ready`.
    - `POST .../download-url`: recipient devices only.
    - `POST .../ack`.
  - `expiresAt = min(created + ATTACHMENT_MAX_RETENTION_SECONDS, linked message expiry)`.
  - Delete the object once every recipient device has acknowledged.
  - **`AttachmentStore` interface:**
    - `fs` adapter: files under `ATTACHMENT_FS_ROOT/<2-char shard>/<id>`, streaming writes, HMAC-signed URL tokens served by Fastify with range support, atomic rename on complete;
    - `s3` adapter: AWS SDK v3, presigned multipart, abort multipart; works with R2 and MinIO;
    - add a MinIO service under the `s3` compose profile.
  - **Janitor job:** delete expired objects, uploads not completed within `ATTACHMENT_ORPHAN_SECONDS`, aborted or partial multipart uploads, and acked-but-not-deleted retries. Metrics for staged bytes, oldest object age and deletion failures.
  - Rate limits on uploads; abuse protection through quotas.
- [ ] **Engine hook:** `AttachmentManifest` content type wiring. The send flow encrypts → uploads (or defers to nearby later) → sends a message with the manifest. The receive flow keeps the manifest; downloads happen on demand (UI in Phase 15).
- [ ] **Object-store spike:** a 100 MB encrypted round-trip through `fs` and through MinIO (`s3`): timing, memory use (streaming, with no full buffering), interrupted upload resume, signed URL expiry, ACK deletion, lifecycle cleanup. Write an ADR (attachment staging store). Note that R2 needs a card on file even for the free tier, so it stays an option, not the default.
- [ ] **Integration tests:** REQ §19.3 server-side bullets (staged bytes contain no plaintext marker; signed URLs expire; ACK deletes; the janitor removes expired, orphaned and partial uploads); a quota rejection; a non-recipient download is denied. Tag the 100 MB test `slow`.

## Key files
`packages/attachments/src/*`, `apps/server/src/modules/attachments/{routes.ts,service.ts,store/fs.ts,store/s3.ts}`, `apps/server/src/jobs/attachmentJanitor.ts`, `docker-compose.yml` (MinIO profile)

## Out of scope
Mobile picker/compression UI (15); web (18); mesh chunks (24).

## Done when
- `pnpm test` and `pnpm test:int` (including the slow 100 MB test, run once and recorded) pass.
- The ADR is written.
- `pnpm lint typecheck` passes.
