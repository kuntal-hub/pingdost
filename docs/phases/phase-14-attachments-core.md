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
- The attachment AEAD ADR: `docs/decisions/0004-attachment-encryption.md`

## Tasks
- [x] **`packages/attachments`** (platform-neutral):
  - `encryptStream` / `decryptStream` per **ADR 0004**:
    - XChaCha20-Poly1305 STREAM (`StreamBE32`), implemented in `crates/pingdost-crypto` (add `chacha20poly1305` 0.11 + `aead-stream` 0.6; regenerate bindings) and exposed through `CryptoProvider`;
    - per-file random key and 19-byte nonce prefix, 64 KiB plaintext chunks, last-chunk flag, decrypt-by-index;
    - it works on async iterables of `Uint8Array`, so mobile and web can feed file chunks;
  - `ciphertextSha256` over the whole ciphertext, plus the per-64-KiB-chunk SHA-256 hash list (`chunkHashListSha256` in the manifest; the list travels with the ciphertext). Upload resume may group chunks (e.g. 1 MiB) at the transport level;
  - an `AttachmentManifest` builder/validator (`scheme`, key, nonce prefix, sizes, chunk count, mime, hashes, optional encrypted thumbnail, staging ref);
  - test vectors in `@pingdost/test-fixtures`, checked by both the WASM and native providers (WASM: unit tests. Native: the dev-crypto screen's **Run scenarios**, which still has to be run on a phone; see PROGRESS);
  - **MIME sniffing** by magic bytes (images, video, audio, pdf, zip-based docs, etc.); extensions are never trusted;
  - **size rules** per REQ §10.1: `canSend(file, {compressible, compressedEstimate})` returns ok / needs-compression / reject-with-reason; only images and videos are compressible;
  - unit tests with large synthetic streams.
- [x] **Server `attachments` module:**
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
    - add a MinIO service under the `s3` compose profile. ⚠ Done with **SeaweedFS** instead (MinIO CE is no longer distributed; ADR 0017, CHANGES 2026-10-20).
  - **Janitor job:** delete expired objects, uploads not completed within `ATTACHMENT_ORPHAN_SECONDS`, aborted or partial multipart uploads, and acked-but-not-deleted retries. Metrics for staged bytes, oldest object age and deletion failures.
  - Rate limits on uploads; abuse protection through quotas (per user, plus a total cap `ATTACHMENT_TOTAL_QUOTA_BYTES` for the VPS disk).
- [x] **Engine hook:** `AttachmentManifest` content type wiring. The send flow encrypts → uploads (or defers to nearby later) → sends a message with the manifest. The receive flow keeps the manifest; downloads happen on demand (UI in Phase 15).
  - Done as `engine.attachmentRecipients` → `encryptStream` + `uploadAttachment` → `engine.sendAttachment(manifest)`. Receivers file `kind: 'attachment'` with the checked manifest; an invalid one becomes `unsupported`. Proven end to end through the real server in `test/engine.int.test.ts` scenario 9.
- [x] **Object-store spike:** a 100 MB encrypted round-trip through `fs` and through MinIO (`s3`): timing, memory use (streaming, with no full buffering), interrupted upload resume, signed URL expiry, ACK deletion, lifecycle cleanup. Write an ADR (attachment staging store). Note that R2 needs a card on file even for the free tier, so it stays an option, not the default. Production is the single Hostinger VPS (ADR 0013), so `fs` on its disk is the production store: size the default quotas and the janitor against its 50 GB (KVM 1).
  - ADR 0017 records the numbers (`fs` and `s3` via SeaweedFS).
- [x] **Integration tests:** REQ §19.3 server-side bullets (staged bytes contain no plaintext marker; signed URLs expire; ACK deletes; the janitor removes expired, orphaned and partial uploads); a quota rejection; a non-recipient download is denied. Tag the 100 MB test `slow`.

## Key files
`packages/attachments/src/*`, `crates/pingdost-crypto/src/attachment.rs`, `packages/crypto/src/conformance/attachment.ts`, `apps/server/src/modules/attachments/{routes.ts,service.ts,signer.ts,store/fs.ts,store/s3.ts}`, `apps/server/src/jobs.ts` (`attachment-janitor`), `packages/message-engine/src/attachments.ts`, `docker-compose.yml` (`s3` profile: SeaweedFS)

## Out of scope
Mobile picker/compression UI (15); web (18); mesh chunks (24).

## Done when
- `pnpm test` and `pnpm test:int` (including the slow 100 MB test, run once and recorded) pass.
- The ADR is written.
- `pnpm lint typecheck` passes.
