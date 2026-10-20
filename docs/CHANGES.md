# PingDost — Requirement Changes & Deviations

This log records every change to, or deviation from, `privacy_first_messaging_app_requirements.md` (REQ), newest first. Format: date · change · reason · affected phases.

---

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
