# PingDost — Requirement Changes & Deviations

This log records every change to, or deviation from, `privacy_first_messaging_app_requirements.md` (REQ), newest first. Format: date · change · reason · affected phases.

---

### 2026-11-01 — Phase 24: files over the mesh (ADR 0027)
1. **No Wi-Fi bulk path yet: files move over BLE only.** The plan had an optional Wi-Fi Aware or Wi-Fi Direct path. It was evaluated (ADR 0027) but not built: it cannot be tested without two phones, and Wi-Fi Aware hardware support varies. The default mesh file limit is therefore **25 MB** (configurable 10–100 MB in Settings → Nearby messaging, with a time estimate), not REQ's 100 MB.
   - *Affects:* 24 (done), 27 (Wi-Fi Aware once measured), 30.
2. **"Acknowledged after full verification" is the ordinary E2EE delivery receipt, held back.** The manifest says `mesh`; the recipient sends its delivery (and read) receipt only after assembling the file and checking the chunk-hash list, every AEAD tag and the whole-file hash. Per-chunk mesh ACKs only hand storage over from one holder to the next.
   - *Affects:* 24 (done).
3. **Mesh files go only to the contact's phones in a direct chat.** Groups, the sender's other phones and linked browsers are not sent the file over the mesh. A browser fetches it from the phone once online (ADR 0021). If the Internet returns mid-transfer, the file still completes over the mesh only.
   - *Affects:* 24 (done), 27.
4. **Per-chunk integrity is the chunk's own hash (checked by relays) plus the sender's signature (checked by the recipient)**, not a hash list sent ahead. The manifest's list hash is still checked at the end.
   - *Affects:* 24 (done).
5. **The simulation harness is in `packages/message-engine/src/mesh/`** and the key files moved accordingly (`packages/attachments/src/mesh*.ts`, `apps/mobile/src/nearby/files.ts`, `chunk-store.ts`), not `packages/mesh-protocol/src/chunks/*`.
   - *Affects:* 24 (done).

### 2026-11-01 — Phase 23: mesh store-and-forward relay (ADR 0025, ADR 0026)
1. **"Boot restart" is a notification, not a service start.** The plan asked for an optional, best-effort restart at boot. The relay's logic runs in the app's JavaScript, which Android does not start at boot, so a service started then would hold Bluetooth without relaying anything. With "Remind me to turn it back on" (Settings → Nearby relay, off by default), a `BOOT_COMPLETED` receiver posts "Nearby is paused since the restart"; opening PingDost starts nearby and relaying again.
   - *Affects:* 23 (done), 27 (a headless start, if wanted; the Play declaration for `RECEIVE_BOOT_COMPLETED`).
2. **Delivered-ID lists are not authenticated.** Holders drop copies that a peer says were delivered, so a malicious peer can make others drop copies; it could already drop what it carries itself. The sender never drops its own copy on such a list: only the E2EE receipt, or sending it another way, settles the message.
   - *Affects:* 23 (done), 27 (an authenticated delivery proof if abuse appears).
3. **Relay-visible data** (REQ §11.3 allows routing identifiers): daily routing tokens for the recipient and the sender, packet ID, times, hop budget, copies, size, crypto type, and for group traffic the group ID and Megolm session ID. A phone announces its tokens for the whole TTL window to every phone it links to, so the daily rotation hides little from a relay that meets it. No device IDs, names or contents. The Nearby relay screen says this.
   - *Affects:* 23 (done), 27 (privacy notice).
4. **Relaying is part of nearby messaging.** It needs nearby messaging on and is its own opt-in, off by default. The foreground service runs while nearby is on, and its notification reads "PingDost nearby relay active" while relaying. Turning relaying off stops taking and passing on other people's packets at once; packets already held stay until they expire or the user clears the relay cache.
   - *Affects:* 23 (done).
5. **The simulation harness is `packages/message-engine/src/mesh/`**, not `packages/mesh-protocol/test/sim/`: the scenarios need real engines, and `mesh-protocol` sits below the engine.
   - *Affects:* 23 (done).
6. **Nearby recognition stays key-based (ADR 0026).** Contact-only recognition would need a new protocol (A10). Strangers in range can recognise a phone's public device key, as ADR 0024 already says.
   - *Affects:* 23 (done), 27, 30.

### 2026-11-01 — Phase 22: direct nearby messaging (ADR 0024)
1. **After the recipient's phone acknowledges a message over Bluetooth, the state is `sent_to_server`, with the path recorded on the delivery row.** REQ §8.3's names have no state for "the recipient's own phone took it over Bluetooth". The state machine already means "the next hop holds it; only the E2EE receipt delivers it", so the state is reused. Labels and message info name the path ("Sent over Bluetooth to the recipient's phone — not yet delivered") and never show the raw name.
   - *Reason:* a new state would touch the shared enum, both stores, history sync and both UIs, for the same meaning.
   - *Affects:* 22 (done), 23 (relay acceptance stays `relayed`).
2. **The handshake shows strangers this phone's public device key.** While nearby messaging is on, a PingDost phone in range sees that a PingDost phone is near and, once linked, this device's Ed25519 public key. It does not see the device ID, account, name or number, and the app looks nothing up on the server. The key is stable, so a stranger could recognise the phone again. The Settings screen says this. Contact-only recognition (no stable identifier) needs its own protocol, so Phase 23 will consider it under a separate ADR.
   - *Affects:* 22 (done), 23, 27 (privacy notice).
3. **Nearby messaging is off by default and local to each phone.** REQ says nothing about a default. Turning it on goes through a screen that explains the permission first.
   - *Affects:* 22 (done), 27.
4. **An offline fan-out is partial.** When the sender's own directory is not cached (it never needed it), the contact's devices get the message now and the sender's own linked browsers get their copy once the Internet is back. Before this, the whole message waited.
   - *Affects:* 22 (done).

### 2026-10-31 — Phase 21: nearby spike (ADR 0023)
1. **No Google Nearby Connections.** The Phase 21 plan had an optional Nearby Connections path for bulk transfer between Android phones, and Phase 24 would have used it. `play-services-nearby` is closed source under the Android SDK License, which breaks the "permissive or OSI licenses" rule, and it needs Google Play services.
   - *Decision:* the user chose BLE only, with no Google library (2026-10-31).
   - *Trade-off:* no ready-made Wi-Fi upgrade. Phase 24 evaluates Android's own Wi-Fi Aware (which iOS 26 also supports) and Wi-Fi Direct as an optional fast path, and otherwise moves files over BLE, where 100 MB takes many minutes.
   - *Affects:* 21 (done in code), 24, 30.
2. **Nearby needs Android 8.0 (API 26) or newer.** The app still installs from Android 7.0 (minSdk 24); there the nearby screen says the phone is too old. REQ names no minimum version.
   - *Affects:* 22, 27.
3. **BitChat-android is GPL-3.0, not public domain** (the plan said "public domain; confirm the license"). It changed from MIT to GPLv3 in 1.7.x. It is used as a design reference only; no code is copied.
   - *Affects:* 21–24.
4. **The BLE link itself is not paired or encrypted.** Pairing shows system dialogs and leaves a lasting bond identifier. Confidentiality and integrity come from the E2EE layer and Phase 22's signed handshake (REQ §11.3).
   - *Affects:* 22, 23.

### 2026-10-31 — Phase 20: staging deployment (ADR 0013 verification)
1. **Atlas Free allows 500 connections** (REQ §22 says 100), 0.5 GB, 100 ops/s and 10 GB in plus 10 GB out per 7 days (checked 2026-10-31). Nothing changes in the code; the alerts use these numbers.
   - *Affects:* 20, 27.
2. **Monitoring is healthchecks.io plus UptimeRobot, without Grafana.** The server pings a heartbeat (`HEARTBEAT_URL`, new optional variable) from its job loop, and `deploy/scripts/monitor.sh` checks the REQ §18 metrics, Valkey, disk and RAM every 5 minutes and reports problems as a failed ping (one email path for everything).
   - *Trade-off:* no dashboards or history; UptimeRobot's free plan is non-commercial only, so production (Phase 27) needs another outside checker or a paid plan.
   - *Affects:* 20, 27.
3. **`/metrics` is not reachable from the internet** (Caddy answers 404); the monitor reads it inside the VPS. **Caddy keeps no access log** (attachment URLs carry their signature in the query string).
   - *Affects:* 20.
4. **Logs rotate by size** (5 × 10 MB per container), about a week at staging volume, instead of a strict 7 days.
   - *Affects:* 20, 27.
5. **No COEP header** on the web app: the WASM needs no shared memory, and COEP would block Cloudinary avatars. COOP is `same-origin`.
   - *Affects:* 20, 25 (recheck if calls need isolation).
### 2026-10-31 — Phase 19: backup, recovery and replacing the primary phone (ADR 0022)
1. **The recovery phrase's entropy is kept in the phone's secure storage** after it is shown once, so later backups reuse it. REQ §6.3 says the key must never reach the server, analytics or logs (it does not); REQ §7.5 asks for recovery keys in OS secure storage where practical.
   - *Trade-off:* someone with the unlocked phone can make a new backup, but cannot see the phrase that opens it.
   - *Affects:* 19 (done), 27.
2. **A restored phone is a new device**, so no 1:1 Olm session is restored or "marked stale": there are none. Contacts are asked for new sessions (`SessionReset`) and resend what the lost phone missed. This replaces the plan's "sessions marked stale, then reset".
   - *Affects:* 19 (done).
3. **Key-change notices:** only a changed account key shows "safety number changed" and resets verification. A new phone under the **same** account key (approved, or restored) shows "moved to a new phone; the safety number is unchanged" in the direct chat and **keeps** verification. Linked browsers add no notice. The Phase 19 plan said every `keyVersion` change resets verification.
   - *Reason:* only the account key's holder can certify a phone (ADR 0008), and the number the user compared did not change.
   - *Affects:* 19 (done).
4. **Only the active primary phone approves a new phone** (it alone holds the account key); a linked browser can only deny. The plan allowed a linked web device "if the policy allows".
   - *Affects:* 19 (done), 27.
5. **Approving from the old phone moves no history**; the app says to back up first and restore instead.
   - *Affects:* 19 (done), 27 (an online hand-over).
### 2026-10-31 — Phase 18: history sync and web attachments (ADR 0021)
1. **The server never holds sync data, not even briefly.** REQ §13.2 allows a relay to hold encrypted sync chunks "temporarily, with strict short expiry". PingDost relays them only to the online device, in memory, and otherwise answers `RECIPIENT_OFFLINE`.
   - *Reason:* nothing to expire or delete, and a test can prove no writes. Both devices are online during a sync anyway.
   - *Trade-off:* the phone must be online and PingDost open (or within 30 s of leaving it): there is no push wake for a sync, and the browser says "Phone offline — sync paused" meanwhile.
   - *Affects:* 18 (done), 27 (a wake for sync, if wanted).
2. **`device_sync_state` (REQ §14.1) is a sealed engine setting, not its own table**, on the phone (SQLCipher) and in the browser (Dexie).
   - *Reason:* one small JSON state per linked browser, written in the same atomic `apply` as each batch, with the same encryption as everything else.
   - *Affects:* 18 (done). Migration 002's empty `device_sync_state` table stays unused.
3. **History from before pairing comes with a cap per conversation (500 newest messages in the window) as well as the window.** REQ asks for a configurable duration/count; the window is 7/30/90/365 days in the browser's Settings.
   - *Affects:* 18 (done).
4. **Files sent before a browser was linked come from the phone, up to 25 MB by default (10–100 MB in Settings).** Larger ones say to open them on the phone. There is no video compression in the browser: a video over 100 MB is refused there.
   - *Affects:* 18 (done), 27.

### 2026-10-20 — Phase 15: attachments on Android (ADR 0018)
1. **Video compression uses AndroidX Media3 Transformer in a local Expo module (`apps/mobile/modules/pingdost-media`), not react-native-compressor.** ARCHITECTURE A6 and the Phase 15 plan named react-native-compressor, to be re-validated; REQ does not name one.
   - *Reason:* react-native-compressor 2.0.3 is maintained, but it pulls a Nitro C++ build, a JitPack LAME build and LGPL audio libraries we do not need. Media3 (Apache-2.0, Google) is already in the app through expo-video and expo-audio, and it has hardware encoders, progress and cancel.
   - *Trade-off:* about 150 lines of Kotlin to maintain; iOS (Phase 28) needs its own implementation.
   - *Affects:* 15 (done), 28.
2. **Attachment captions are searchable.** Phase 11 indexed text messages only and left captions open.
   - *Affects:* 15, 17 (the web store follows the store contract).
3. **The `AttachmentManifest` gains media details (width, height, duration, voice-note waveform; add-only fields).** Receivers lay out and label files before downloading them.
   - *Affects:* 15, 18 (web reads and writes them).

### 2026-10-20 — Phase 14: attachment staging (ADR 0017)
1. **The local S3 test service is SeaweedFS, not MinIO.** ARCHITECTURE A1 and the Phase 14 plan named MinIO; REQ does not.
   - *Reason:* MinIO's community edition is no longer distributed, and its image pulls were denied on the dev PC. SeaweedFS is Apache-2.0 and serves the same S3 API.
   - *Trade-off:* none in production: `fs` on the VPS disk is the production store, and `s3` stays an R2 option that needs a card.
   - *Affects:* 14 (done), 20.
2. **A total staging cap (`ATTACHMENT_TOTAL_QUOTA_BYTES`, 30 GiB) is added next to the REQ per-user quota.** When it is full, uploads get `ATTACHMENT_STAGING_FULL` (503) until space frees up; nearby transfer (Phase 24) still works.
   - *Reason:* the 50 GB VPS disk is shared with everything else.
   - *Affects:* 15 (show the error), 20 (disk sizing).

### 2026-10-19 — Hosting: one Hostinger VPS, Valkey only (ADR 0013)
1. **Upstash is dropped; the hot mailbox is self-hosted Valkey on the VPS.** REQ §2, §4, §17 and §22 name Upstash Redis.
   - *Reason:* Upstash free (500K commands/month) fits only about 50–60 active users (ADR 0010). Valkey costs nothing extra and was already the dev and test path.
   - *Trade-off:* we run Valkey ourselves (AOF, `noeviction`, a password, never exposed). Losing the VPS loses envelopes still in the Redis stage.
   - *Affects:* 20, 27. Phase 08 is done; ADR 0010 now points to ADR 0013.
2. **Host: one Hostinger KVM VPS (KVM 1 or 2, `x86_64`), bought by the user. Nothing else is paid.** This replaces "Hosting provider decided in Phase 20" (2026-10-18, item 10) and the Oracle Always Free candidate.
   - On the VPS, one Docker Compose stack: API, worker, Valkey, Caddy, attachment staging (`fs`) and coturn.
   - On free tiers: Atlas M0, Cloudflare DNS and Pages, GitHub Actions/GHCR, email and FCM.
   - *Reason:* the user's choice.
   - *Affects:* 14 (`fs` is the production store), 20, 25, 27.
3. **A production `REDIS_URL` must carry a password.** `@pingdost/config` enforces it.
   - *Affects:* 20.

### 2026-10-18 — Phase 3: Android native crypto build
1. **Android ships for 64-bit ABIs only** (`arm64-v8a`, plus `x86_64` for emulators). Phones that run a 32-bit-only Android (some low-end and Android Go devices) cannot install the app for now.
   - *Reason:* the chosen binding, ubrn's `jsi2` JSI player (ADR 0005), ships prebuilt only for 64-bit ABIs.
   - *Mitigation:* build the player for `armeabi-v7a` from ubrn's sources, or switch to ubrn's classic `jsi` flavour. Revisit in Phase 27 with real device data (REQ §14.1 asks for low-end device tests).
   - *Affects:* 03, 20, 27.
2. **Android Auto Backup is disabled** (`allowBackup: false`). REQ does not ask for it; ADR 0003 forbids restoring Olm state from backups. Account recovery stays with Phase 19.
   - *Affects:* 03, 19.

### 2026-10-18 — Initial planning deviations
1. **iOS deferred.** Android + web first; iOS moves to Phases 28–30. REQ §3 says all three platforms at launch, so iOS launch readiness is still required before a "full" launch.
   - *Reason:* the user has Android phones and no Mac or iPhone.
   - *Affects:* all mobile phases.
2. **Google-only social login in v1; Facebook deferred.**
   - REQ §3 lists Google + Facebook, while §6.1 lists only Google.
   - *Reason:* the user's choice; Facebook production login needs Meta app review.
   - *Affects:* 05–07.
3. **Worker is a second entrypoint** (`apps/server/src/worker.ts`), not `apps/worker`. `RUN_WORKER_IN_PROCESS` can co-host it with the API.
   - *Reason:* simpler deployment on a single small VM.
   - *Affects:* 05, 08.
4. **`REDIS_URL` replaces `UPSTASH_REDIS_URL`/`UPSTASH_REDIS_TOKEN`.** One native-protocol URL works with Upstash or self-hosted Valkey.
   - *Reason:* provider portability (REQ §21), given the free-tier command limits.
   - *Affects:* 01, 08, 20.
5. **No BullMQ or QStash initially.** Jobs use a small scheduler with Mongo leases, which REQ §21 allows.
   - *Reason:* the Upstash 500K commands/month free tier.
   - *Affects:* 05, 08.
6. **Temporary attachment staging uses an `AttachmentStore` interface** with `fs` (VPS disk, REQ §22) and `s3` (R2/MinIO) adapters.
   - *Reason:* REQ §10.3 (R2) conflicts with §22 (VPS storage); hosting is not chosen yet.
   - *Affects:* 14, 20.
7. **Cloudinary is used only for user profile avatars** (REQ §22). Group name and avatar are E2EE group-control content and are not stored on the server.
   - *Reason:* privacy.
   - *Affects:* 06, 13.
8. **Web devices authenticate only by QR pairing** from the primary mobile device; there is no password or Google login on web.
   - *Reason:* REQ §6.2 / §13.1 device model.
   - *Affects:* 16.
9. **REQ §20's Phase 0 spikes are scheduled just-in-time.** The crypto gate comes first (Phases 2–3); the other spikes open their tracks (8, 14, 21, 24, 25).
   - *Reason:* only the crypto choice shapes the core architecture; transports sit behind interfaces.
10. **Hosting provider decided in Phase 20.** Development is local on Docker until then.
    - *Reason:* the user's choice.
11. **Project is open source.** The license is confirmed in Phase 1 (AGPL-3.0-or-later recommended).
    - *Reason:* the user's choice.
12. **New env vars** (ARCHITECTURE A11), for example `MESSAGE_MIGRATION_POLL_SECONDS`, `MESSAGE_ONLINE_ACK_TIMEOUT_MS`, `ENVELOPE_MAX_BYTES` and `GOOGLE_CLIENT_IDS`. `GOOGLE_CLIENT_SECRET` is unused because sign-in verifies ID tokens.
