# 0017 — Attachment staging store: `fs` on the VPS disk, `s3` as an option

- **Status:** Accepted
- **Date:** 2026-10-20
- **Phase:** 14
- **Approved by user:** n.a. (follows ADR 0013; R2 stays opt-in because it needs a card)

## Context
REQ §10.2 and §16.4 stage encrypted attachments on the server for a short time: until every recipient device has fetched them, or at most `ATTACHMENT_MAX_RETENTION_SECONDS`. REQ §10.3 names an S3-style object store, while §22 budgets for VPS disk. ARCHITECTURE A2 allows both, behind one `AttachmentStore` interface. ADR 0013 made one Hostinger KVM VPS the only paid service (KVM 1: 50 GB disk). ADR 0004 fixed the encryption (XChaCha20-Poly1305 STREAM, 64 KiB chunks), so the server only ever stores ciphertext.

The phase asked for a 100 MB round trip through `fs` and through MinIO (`s3`).

## Options considered
| Option | Pros | Cons | License | Cost |
|---|---|---|---|---|
| **`fs` on the VPS disk** (chosen default) | No extra service or account; streaming writes; range reads served by the API; same box as the API | Bounded by the 50 GB disk (shared with Docker, logs, Valkey); egress is VPS bandwidth | own code | Included in the VPS |
| `s3` on Cloudflare R2 | Free tier of 10 GB, free egress; offloads the VPS disk | **Needs a card on file even for the free tier**; another account and secret | n.a. (service) | Free tier, card required |
| `s3` on self-hosted MinIO | The phase's plan for local S3 tests | Community edition no longer distributed; `minio/minio` and `quay.io/minio/minio` pulls were denied here (2026-10-20) | AGPL-3.0 | Free |
| `s3` on self-hosted SeaweedFS (dev/CI only) | Apache-2.0, a single container with an S3 gateway, health endpoint | One more service if used in production (we don't) | Apache-2.0 | Free |

## Decision
- **Production uses `fs`** (`ATTACHMENT_STORE=fs`) on the VPS disk, under `ATTACHMENT_FS_ROOT/<last 2 chars of the ID>/<attachmentId>`. `s3` is kept and tested so R2 (or any S3 API) can be switched on later by configuration only, once the user accepts R2's card requirement.
- **⚠ Deviation:** the local S3 test service is **SeaweedFS** (`chrislusf/seaweedfs:4.48`, compose profile `s3`, port 8333, dev-only credentials), not MinIO.
- **Protocol** (`/v1/attachments`, DTOs in `@pingdost/shared-types`):
  - `POST /v1/attachments`: the uploader declares the attachment ID (UUIDv7, also the manifest's), the ciphertext size and SHA-256, the recipient devices (≤ 512, all active) and optionally the linked message's expiry. The server checks the size limit (`ATTACHMENT_MAX_BYTES` plus AEAD tags), the user quota and the total quota. It returns `partSize`, `partCount` and signed part URLs (TTL `ATTACHMENT_PRESIGNED_URL_TTL_SECONDS`).
  - Parts are whole ciphertext chunks: 16 chunks (≈ 1 MiB) on `fs`; 80 chunks (≈ 5 MiB) on `s3`, whose multipart parts must be at least 5 MiB.
    - `fs`: `PUT …/parts/:index` with an HMAC-signed token. Each part is written to a parts directory (temp name, then renamed). On `complete` the parts are streamed into a temp file while hashing, and that file is renamed into place, so a half-joined file is never served.
    - `s3`: presigned `UploadPart` URLs of one multipart upload.
  - `GET …/status` lists the parts received and hands out fresh URLs for the rest, so an interrupted upload resumes without re-encrypting. The client reads from its local encrypted copy.
  - `POST …/complete` checks the total size and the streaming SHA-256, then sets `ready`. A mismatch deletes the upload.
  - `POST …/download-url` (recipient devices only; anyone else gets `ATTACHMENT_NOT_FOUND`): a short-lived signed URL. `fs` serves it from the API with HTTP range support; `s3` presigns a `GetObject`.
  - `POST …/ack`: the device is moved to `ackedDeviceIds`. After the last recipient, the record goes to `deleting` and the object is deleted.
- **Stored metadata** (`attachments` collection): ID, uploader user and device, ciphertext size and SHA-256, part layout, multipart upload ID, pending and acked device IDs, status, created, completed and expiry times. **No key, no name, no MIME type, no plaintext size.** The key and file metadata travel only in the E2EE `AttachmentManifest` (ADR 0004), which now also carries `thumbnail` (12, its own staged attachment) and `caption` (13).
- **Expiry:** `expiresAt = min(createdAt + ATTACHMENT_MAX_RETENTION_SECONDS, linked message expiry)`.
- **Janitor** (job `attachment-janitor`, every `ATTACHMENT_JANITOR_INTERVAL_SECONDS` = 300 s, with a job lease) deletes:
  - expired objects;
  - uploads not completed within `ATTACHMENT_ORPHAN_SECONDS` (6 h), aborting their S3 multipart uploads;
  - records stuck in `deleting` (a failed delete is retried);
  - store leftovers that no record claims: part directories and files on `fs`, multipart uploads and objects on `s3`.
- **Quotas, sized for KVM 1 (50 GB):**
  - `ATTACHMENT_USER_QUOTA_BYTES` = 1 GiB of staged ciphertext per user (`ATTACHMENT_QUOTA_EXCEEDED`, 413);
  - new `ATTACHMENT_TOTAL_QUOTA_BYTES` = 30 GiB for everyone (`ATTACHMENT_STAGING_FULL`, 503: retry later, or send over nearby). That leaves about 20 GB for the OS, Docker images, Valkey, logs and coturn.
  - With 14-day retention, a full disk needs about 2 GB of new uploads a day that are never fetched. In practice, ACK deletion empties most objects within minutes.
- **Rate limits** (per client IP, per 15 min):
  - `attachmentsCreate` 60;
  - `attachmentsRead` (status, complete, download URL) 600;
  - `attachmentsAck` 600;
  - `attachmentParts` 3,000 (a 100 MB file is about 100 parts);
  - `attachmentBlob` 600.
  - Part uploads and blob reads are authorized only by their signed tokens, like presigned S3 URLs.
- **Metrics:** `pingdost_attachments_deleted_total{reason}`, `pingdost_attachment_deletion_failures_total`, and gauges for staged bytes, staged objects and the oldest object's age.
- **Client side** (`@pingdost/attachments`, platform-neutral): `encryptStream` and `decryptStream` over async iterables, `buildManifest` and `readManifest` (strict checks; file names sanitized), `sniffMime` (magic bytes only), `canSend` (REQ §10.1 rules) and the resumable `uploadAttachment`.
- **Message engine:**
  - `attachmentRecipients(conversationId)` lists the devices to stage for (the recipients' and this user's other devices).
  - `sendAttachment(conversationId, manifest)` checks the manifest and sends it as a message, `kind: 'attachment'`, with the caption in `body`. It goes over Olm, or Megolm in groups.
  - Receivers keep the checked manifest (`MessageRecord.attachment`, file key included, in the encrypted store) and download on demand.
  - An invalid manifest becomes an "unsupported" placeholder.
  - Delete for everyone clears the stored manifest and key.

## Consequences
- Phase 15 builds the Android UX on these pieces:
  - file IO and the local encrypted copy;
  - an upload/download queue with progress;
  - compression, thumbnails and captions;
  - ACK after a verified download;
  - deleting local files on "delete for me" and on tombstones.
- Phase 18 does the same on the web (Dexie or OPFS).
- Phase 20 provisions `ATTACHMENT_FS_ROOT` on a Docker volume and checks the disk headroom against `ATTACHMENT_TOTAL_QUOTA_BYTES`. It also sets Caddy's request body limit to at least one part (≈ 1 MiB plus headers) and stops Caddy from buffering streaming responses.
- Phase 24 (mesh) reuses the chunk hash list and the attachment ID as the transfer ID.
- Switching to R2 later: set `ATTACHMENT_STORE=s3` and the `ATTACHMENT_OBJECT_STORE_*` group (`ATTACHMENT_OBJECT_STORE_REGION=auto`), after the user agrees to R2's card requirement. Objects already staged on `fs` are not moved, so switch while staging is empty (or accept that those uploads are lost and get re-sent).

## Evidence
- 100 MiB spike (`PINGDOST_SLOW=1 … test/attachments-100mb`, 2026-10-20, Windows 11 PC, Node 24, WASM crypto). Encryption and decryption stream through temp files; one upload part was failed on purpose and resumed. Signed URL expiry was checked on `fs`; ACK deletion on both.

  | Store | Ciphertext | Encrypt | Upload (with resume) | Download | Decrypt | Peak RSS Δ | Peak heap Δ |
  |---|---|---|---|---|---|---|---|
  | `fs` | 104,883,216 B | 7.3 s | 2.5 s | 0.9 s | 7.9 s | +90 MiB | +0 MiB |
  | `s3` (SeaweedFS) | 104,883,216 B | 7.5 s | 4.5 s | 1.9 s | 7.3 s | +46 MiB | +2 MiB |

  A second run after the final changes gave the same picture. `fs`: 7.5 s / 2.4 s / 0.7 s / 7.3 s, RSS +94 MiB, heap +2 MiB. `s3`: 7.3 s / 4.0 s / 2.0 s / 7.2 s, RSS +42 MiB, heap +2 MiB.

  The flat heap shows no full buffering. RSS growth is WASM linear memory and the OS file cache.
- Integration tests (`test/attachments.int.test.ts`, `fs` and `s3`; `test/engine.int.test.ts` scenario 9):
  - no plaintext marker in the staged bytes;
  - recipients only;
  - range reads;
  - resume;
  - SHA-256 mismatch refused;
  - size, user quota and total quota;
  - URL expiry;
  - ACK deletion;
  - the janitor (expired, orphaned, partial, leftovers);
  - the engine flow end to end.
- MinIO: community edition retired (https://glukhov.org/data-infrastructure/object-storage/minio-dead/, https://github.com/minio/minio, checked 2026-10-20); image pulls denied on this PC the same day.
- SeaweedFS 4.48, Apache-2.0 (https://github.com/seaweedfs/seaweedfs, checked 2026-10-20). AWS SDK for JavaScript v3 `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` 3.1153.0, Apache-2.0.
