# Phase 15 — Attachments UX (Android) + storage management

**Depends on:** 10, 14 · **Platforms:** Android

## Goal
Send and receive images, videos, voice notes and documents on Android. Compression is on by default with an original-file option, the size rules are honest, files are encrypted at rest locally, and the user can manage storage.

## Read first
- REQ §10.1, §10.2, §14.1, §14.3, §19.3 (first three bullets)
- ARCHITECTURE A6
- **Load skill `expo:expo-overview`**

## Tasks
- [x] **Native streaming I/O:** read and write files in chunks with the expo-file-system File API (no base64), feeding `packages/attachments` encrypt/decrypt with the native crypto provider. (`src/attachments/files.ts`, `pipeline.ts`: ~1 MiB reads and writes through `FileHandle`s; downloads stream `expo/fetch` bodies.)
  - [ ] Verify that memory stays flat on a 100 MB file (**device check**, steps in the PROGRESS entry).
- [x] **Local storage:** sent and received attachments are stored **as encrypted files** (per-file key in SQLCipher). Viewing decrypts to a temp cache, which is cleaned on exit or after a timeout.
  - The vault keeps each attachment's own STREAM ciphertext; the key is the manifest key in `messages.attachment` (ADR 0018).
  - Plaintext lives in `<cache>/pingdost-view/` and is deleted when the viewer closes or the app goes to the background; exports after 10 min; everything left over at the next start.
  - Thumbnails are generated locally **before** encryption (expo-image-manipulator; video frames from the local Media3 module instead of expo-video-thumbnails) and stored encrypted. They are decrypted into memory only.
- [x] **Compression:**
  - images via expo-image-manipulator (Standard 1600 px / q 0.75, HD 2560 px / q 0.85);
  - videos: react-native-compressor was checked and replaced by AndroidX Media3 Transformer in the local module `modules/pingdost-media` (ADR 0018, CHANGES 2026-10-20). ffmpeg-kit is not used.
  - **Before sending, show:** original size, estimated compressed size and quality, and a "Send original" toggle (only if ≤ limit). (`screens/chats/send-attachment.tsx`; photo sizes are measured, video sizes estimated from the plan.)
  - **Over 100 MB:** offer compression; send only if the result is ≤ the limit; otherwise explain why it can't be sent. Non-compressible files over the limit are rejected with a clear message. (`rules.ts` `planDraft`, checked again after compressing.)
- [x] **Pickers:** camera + gallery (expo-image-picker), documents (expo-document-picker), voice notes (expo-audio: record, playback, a waveform from metering sent in the manifest, duration).
- [x] **Transfer UI:** upload and download progress, pause/resume (using resumable chunks), retry, cancel. (`transfers.ts` + `screens/chats/attachment-bubble.tsx`)
  - Auto-download settings: thumbnails always; full media on Wi-Fi only (default) / always / never (Settings → Storage).
- [x] **Viewers:** image (pinch-zoom, pan, double tap), video (expo-video), audio player (inline), documents opened via expo-sharing with an "exports leave PingDost's protection" notice.
- [x] **Storage screen:**
  - total usage; per-chat media list and size; delete selected media;
  - **"Clear cache" removes thumbnails and temp files only and says so; it never deletes history** (REQ §14.3);
  - a placeholder row for the mesh relay cache, kept separate (filled in Phase 23).
- [x] Recipient ACK after a verified download triggers server deletion (Phase 14 endpoint). The whole ciphertext is checked first (`verifyStream`); failed acks retry on reconnect.
- [x] Handoff items: deleting messages or chats (and delete-for-everyone tombstones) drops their files (engine `content_removed`, GC); captions are searchable; held sends show the upload in the chat and survive restarts.

## Key files
`apps/mobile/src/attachments/*`, `apps/mobile/app/(app)/chats/[id]/*` (composer, bubbles), `apps/mobile/app/(app)/settings/storage.tsx`

## Out of scope
Web attachments (18); mesh transfer (24).

## Done when
- **On a phone:**
  - photo sent compressed and also as original;
  - a 100 MB+ video compressed and sent, or rejected with an explanation;
  - a 100 MB+ PDF rejected;
  - a voice note sent and received;
  - the recipient views the media;
  - the server object is gone after the ACK (check the fs dir, or SeaweedFS with the `s3` profile);
  - "Clear cache" leaves history intact.
- `pnpm lint typecheck test` passes.

## Handoff notes
**From Phase 7 (ADR 0009):** expo-image-picker 58.0.10 is already installed (avatars). Its `app.json` plugin blocks `CAMERA` and `RECORD_AUDIO`: to capture photos or video for attachments, give `cameraPermission`/`microphonePermission` a usage string instead of `false`.
**From Phase 11 (ADR 0014):**
- `engine.deleteConversation` and `deleteForMe` remove rows only. They must also delete local attachment files and `attachments` rows.
- A delete-for-everyone tombstone must drop the attachment file too.
- Messages are upserted (`ON CONFLICT DO UPDATE`), never `INSERT OR REPLACE`, because the FTS triggers rely on a stable rowid.

**From Phase 14 (ADR 0017):**
- Use `@pingdost/attachments` (already a mobile dependency):
  - `encryptStream` / `decryptStream` take async iterables of `Uint8Array`;
  - `sniffMime` (never the file name) and `canSend` (REQ §10.1);
  - `buildManifest` (caption and thumbnail included);
  - `uploadAttachment`, which resumes from the server's part list. Read parts from the local encrypted copy, so a resume never re-encrypts.
  - `formatSize` gives the A8 "MB" labels.
- Send flow: `engine.attachmentRecipients(conversationId)` → encrypt to the local encrypted file → `uploadAttachment({ recipientDeviceIds, expiresAt })` → `engine.sendAttachment(conversationId, manifest)`.
  - Nothing is stored until the upload completes. Add a local "uploading" placeholder (queued in the `attachments` table) so the bubble shows progress and survives a restart.
- Receive: `MessageRecord.attachment` (`AttachmentInfo`, base64 key) holds what the download needs. `attachmentDecryptInput(info)` turns it into `decryptStream`'s input. After `decryptStream` succeeds (it checks the whole-ciphertext hash), call `attachmentsApi.ack`.
  - `download-url` answers `ATTACHMENT_NOT_FOUND` once the object is gone (expired, or every device acked): show "no longer available".
- Thumbnails are their own staged attachment (`AttachmentInfo.thumbnail`): upload them first, and fetch them before the full file.
- Errors to show: `ATTACHMENT_TOO_LARGE`, `ATTACHMENT_QUOTA_EXCEEDED` (1 GiB staged per user) and `ATTACHMENT_STAGING_FULL` (server full; retry later).
- The chat bubble shows only "📷 Photo · 3.2 MB" plus the caption for now (`attachmentBody` in `screens/chats/chat.tsx`). Previews and notifications use `attachmentText`.
- Search covers text messages only. Decide whether captions should be searchable (the FTS triggers in migration 003 index `kind = 'text'`).
- The `s3` compose profile runs SeaweedFS, not MinIO. For the "object gone after the ACK" check, look in `ATTACHMENT_FS_ROOT` (default `./.data/attachments`).
