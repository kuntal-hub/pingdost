# PingDost — Requirement Changes & Deviations

This log records every change to, or deviation from, `privacy_first_messaging_app_requirements.md` (REQ), newest first. Format: date · change · reason · affected phases.

---

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
