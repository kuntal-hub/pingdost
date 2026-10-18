# Phase 15 — Attachments UX (Android) + storage management

**Depends on:** 10, 14 · **Platforms:** Android

## Goal
Send and receive images, videos, voice notes and documents on Android. Compression is on by default with an original-file option, the size rules are honest, files are encrypted at rest locally, and the user can manage storage.

## Read first
- REQ §10.1, §10.2, §14.1, §14.3, §19.3 (first three bullets)
- ARCHITECTURE A6
- **Load skill `expo:expo-overview`**

## Tasks
- [ ] **Native streaming I/O:** read and write files in chunks with the expo-file-system File API (no base64), feeding `packages/attachments` encrypt/decrypt with the native crypto provider.
  - Verify that memory stays flat on a 100 MB file.
- [ ] **Local storage:** sent and received attachments are stored **as encrypted files** (per-file key in SQLCipher). Viewing decrypts to a temp cache, which is cleaned on exit or after a timeout.
  - Thumbnails are generated locally **before** encryption (expo-image-manipulator / expo-video-thumbnails) and stored encrypted.
- [ ] **Compression:**
  - images via expo-image-manipulator (max dimension and quality presets);
  - videos via `react-native-compressor`. **Check current maintenance and Expo compatibility first.** If unsuitable, pick an alternative with an ADR note; ffmpeg-kit is retired, so do not use it.
  - **Before sending, show:** original size, estimated compressed size and quality, and a "Send original" toggle (only if ≤ limit).
  - **Over 100 MB:** offer compression; send only if the result is ≤ the limit; otherwise explain why it can't be sent. Non-compressible files over the limit are rejected with a clear message.
- [ ] **Pickers:** camera + gallery (expo-image-picker), documents (expo-document-picker), voice notes (expo-audio: record, playback, simple waveform, duration).
- [ ] **Transfer UI:** upload and download progress, pause/resume (using resumable chunks), retry, cancel.
  - Auto-download settings: thumbnails always; full media on Wi-Fi only (default) / always / never.
- [ ] **Viewers:** image (pinch-zoom), video (expo-video), audio player, documents opened via expo-sharing with an "exports leave PingDost's protection" notice.
- [ ] **Storage screen:**
  - total usage; per-chat media list and size; delete selected media;
  - **"Clear cache" removes thumbnails and temp files only and says so; it never deletes history** (REQ §14.3);
  - a placeholder row for the mesh relay cache, kept separate (filled in Phase 23).
- [ ] Recipient ACK after a verified download triggers server deletion (Phase 14 endpoint).

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
  - the server object is gone after the ACK (check the fs dir or MinIO);
  - "Clear cache" leaves history intact.
- `pnpm lint typecheck test` passes.
