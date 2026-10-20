# 0018 — Attachments on Android: local vault, compression, held sends, transfers

- **Status:** Accepted
- **Date:** 2026-10-20
- **Phase:** 15
- **Approved by user:** n.a. (no gate decision)

## Context
Phase 15 makes attachments usable on Android: pick or record, compress (images and videos only, on by default, REQ §10.1), send, receive, view, and manage storage (REQ §14.1, §14.3). Files must be encrypted at rest on the phone (ARCHITECTURE A6), large files must not sit in memory, and transfers must survive interruptions and restarts (REQ §10.2, §19.3). Phase 14 (ADR 0017) built the staging server, the STREAM format and the resumable upload; this ADR records how the phone uses them.

## Options considered

**Video compression**

| Option | Pros | Cons | License | Cost |
|---|---|---|---|---|
| react-native-compressor 2.0.3 (Jul 2026) | Maintained; New Architecture (Nitro); Expo plugin; also compresses images and audio | Pulls react-native-nitro-modules (another C++ build on this long-path Windows setup), a JitPack LAME build and jlayer (LGPL) for audio we do not need; upload helpers we do not use | MIT (+ LGPL deps) | free |
| **AndroidX Media3 Transformer 1.9.1 in a local Expo module** | Google-maintained; hardware H.264/AAC encoders with fallback; progress and cancel; already in the app through expo-video and expo-audio (same version); Kotlin only, no C++ | We maintain ~150 lines of Kotlin; Android only (iOS needs AVFoundation in Phase 28) | Apache-2.0 | free |
| ffmpeg-kit | Everything | Retired (the plan forbids it); large binaries; GPL builds | LGPL/GPL | free |

**Local encryption of attachment files**

| Option | Pros | Cons |
|---|---|---|
| **Keep the attachment's own STREAM ciphertext as the local copy** (key = the manifest key, stored in SQLCipher) | One encryption pass; uploads read parts straight from it (a resume never re-encrypts); downloads append straight into it; the bytes match the staged object, so the mesh (Phase 24) can send them as they are | The local key is the one recipients also hold (they hold the plaintext anyway) |
| A second, device-only key per file | Local key never shared | A second full encrypt/decrypt pass per file; upload needs a separate ciphertext anyway |

## Decision
1. **Vault.** Each attachment (file or thumbnail) is stored as `<documents>/attachments/<attachmentId>`, its own XChaCha20-Poly1305 STREAM ciphertext (ADR 0004). The key lives only in the SQLCipher DB (`messages.attachment`). Plaintext exists only:
   - in the view cache (`<cache>/pingdost-view/<id>/<name>`) while a viewer shows it. It is deleted when the viewer closes or the app goes to the background. A copy handed to another app ("Open in another app", with a notice that it leaves PingDost's protection) is kept 10 minutes, so that app can read it. Everything left over is deleted at the next start;
   - in memory for thumbnails (data URIs, an LRU of 60), never on disk;
   - as picker copies and compression output in `<cache>/pingdost-work/`, deleted once the file is encrypted (or the send is abandoned) and at every start.
2. **Streaming IO.** Files are read and written about 1 MiB at a time with expo-file-system `FileHandle`s. Encryption and decryption run over async iterables. Downloads stream `expo/fetch` response bodies and write ~256 KiB pieces. No base64, and no whole large file in memory.
3. **Compression** (shared plans in `@pingdost/attachments` `compression.ts`):
   - Images: expo-image-manipulator, decoded downsampled and saved as JPEG. Presets: Standard (1600 px, q 0.75) and HD (2560 px, q 0.85). The preview screen shows the real sizes, because it compresses once to measure. Re-encoding drops EXIF (location); "Send original" says it keeps it. GIFs default to the original (compressing keeps one frame).
   - Videos: the local module `apps/mobile/modules/pingdost-media` (Media3 Transformer 1.9.1, `Presentation.createForShortSide`, H.264 + AAC). Steps are 720p at 2 Mbps, 480p at 1 Mbps and 360p at 500 kbps. A long video gets a bitrate cut to fit 95 % of the limit; below 250 kbps it is refused with an explanation. A video already smaller than the plan is sent as it is.
   - The module also gives video metadata and a first-frame preview (MediaMetadataRetriever), so expo-video-thumbnails is not needed.
   - Thumbnails: 480 px JPEG q 0.6, at most 256 KiB, made before encryption and staged as their own attachment.
4. **Manifest media details** (content.proto, add-only fields 14–17): `width`, `height`, `duration_ms`, `waveform` (up to 64 loudness samples for voice notes). Receivers lay out tiles and show durations before downloading. `AttachmentInfo` gains the same optional fields.
5. **Held sends.** `engine.sendAttachment(…, { held: true })` stores the message (`local_queued`, shown with upload progress) without queueing it; `engine.releaseAttachment(messageId)` queues it once the upload is complete. A file row stays "transferring" until the release, so a crash in between resumes (the server answers that the upload is complete) and releases.
6. **Transfers** (`apps/mobile/src/attachments/transfers.ts`, migration 006's `attachments` table, one row per staged file):
   - States: pending, transferring, paused, failed (+ error), gone, done, removed.
   - Two slots for files and four for thumbnails.
   - Uploads send the thumbnail first, with recipients fixed at the first attempt.
   - Downloads resume with `Range` (`downloadCiphertext`). Then the whole ciphertext is checked (`verifyStream`: every chunk's tag and the whole-file hash), and only then acknowledged. A failed ack is retried when the connection returns.
   - "Network" failures restart on reconnect. `ATTACHMENT_NOT_FOUND` / `ATTACHMENT_EXPIRED` become "No longer available".
   - Writes go through the engine store's queue (`SqliteEngineStore.exclusive`), so they never land inside an open batch transaction.
7. **Automatic downloads:** previews always. Full files on Wi-Fi only (default), always, or never; this is a local setting. On reconnecting to Wi-Fi, pending files from the last 7 days start.
8. **Deletion.** The engine emits `content_removed` for delete-for-me, chat deletion and delete-for-everyone tombstones. The app then drops the rows and vault files whose message is gone or has no manifest. At start, vault files with no row are deleted. A revoked device wipes the vault with its chats. Cancelling an upload deletes its never-sent message.
9. **Storage screen.** It shows usage (files, previews, temporary files, database, free space), per-chat media with delete-selected, the auto-download setting, and a separate nearby-relay-cache row (filled in Phase 23). "Clear cache" removes previews and temporary files only, says so, and says cleared previews cannot be fetched again (the server copy is gone once fetched).
10. **Search:** attachment captions are indexed (migration 006 triggers; the memory store matches them too).
11. **Session reset:** the engine's resend of unacknowledged messages to a reset device now covers attachment messages as well as text.

## Consequences
- **Web (Phase 18)** reuses `downloadCiphertext`, `verifyStream`, `planVideo`/`scaledSize`, and the held send plus `releaseAttachment`.
- **iOS (Phase 28)** needs an AVFoundation implementation of the `PingdostMedia` module, or another encoder.
- **Mesh (Phase 24)** can send vault files as they are. Per-chunk hashes are recomputed from them; only their list's hash is in the manifest.
- **New dependencies** (all MIT unless noted): expo-file-system 58.0.10, expo-document-picker 58.0.4, expo-audio 58.0.9, expo-video 58.0.12, expo-sharing 58.0.19, and AndroidX Media3 transformer/effect/common 1.9.1 (Apache-2.0).
- **Permissions:** `RECORD_AUDIO` (voice notes, and video recorded through the camera app) and `CAMERA`, with usage strings. Background audio, video playback and recording are off.
- The phase file and ARCHITECTURE A6 named react-native-compressor; CHANGES 2026-10-20 records the switch.

## Evidence
- react-native-compressor checked 2026-10-20: npm 2.0.3 (2026-07-25), MIT. Peer `react-native-nitro-modules >= 0.35`. Android dependencies: `org.mp4parser:isoparser`, `com.github.kaushik-naik:TAndroidLame` (JitPack) and `javazoom:jlayer`.
- Media3: the Google Maven metadata lists 1.11.1 as the latest. expo-video and expo-audio 58 pin 1.9.1, so the module uses 1.9.1. The 1.9.1 sources jar confirms `Presentation.createForShortSide`, `Transformer.Listener.onCompleted/onError`, `DefaultEncoderFactory.Builder.setRequestedVideoEncoderSettings`/`setRequestedAudioEncoderSettings`/`setEnableFallback`, and `getProgress(ProgressHolder)`.
- `expo/fetch` (SDK 58 source): `Uint8Array` request bodies, `AbortSignal`, and streamed `response.body`.
- Unit tests: `packages/attachments` (download resume, expired link, whole-file reply, gone, pause; verify; plans), `packages/message-engine` (held send and release, media fields, `content_removed`, caption search in the store contract), `apps/mobile` (rules, bubble status, repository and FTS on migration 006).
