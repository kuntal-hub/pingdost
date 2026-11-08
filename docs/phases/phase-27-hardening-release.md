# Phase 27 — Hardening & release readiness (Android + web)

**Depends on:** 18, 19, 24, 26 · **Platforms:** all

## Goal
Make the product release-worthy: security and privacy audits, full acceptance traceability, load and cost checks, honest legal and in-app wording, operational runbooks, and a Google Play internal-testing release. It may be split into 27a/27b if it runs long.

## Read first
- REQ §5, §18, §19 (all), §21, §23
- ARCHITECTURE A9, A10
- All ADRs (skim the index)

## Tasks
Status 2026-11-02 (ADR 0030; PROGRESS has the details).
- [x] **Threat model** `docs/security/threat-model.md` (assets, actors, trust boundaries: server, relays, push providers, object store, browser storage; STRIDE-lite table; residual risks such as metadata visibility and Megolm post-compromise security limits).
- [x] **Acceptance traceability** `docs/security/acceptance.md`: every REQ §19 bullet → its automated test or documented manual check, with the latest result. Gaps filled (sender history after expiry asserted; log scan; backlog drain). Device rows stay ⏳ until run.
- [x] **Audits** (`docs/security/audits.md`):
  - [x] **log and crash redaction:** grep plus a runtime capture test across server (`engine.int` 10), mobile and web (`log-hygiene.test.ts`); two unguarded mobile logs fixed;
  - [x] **dependencies:** `pnpm audit` (overrides + accepted list), `cargo deny check` (RUSTSEC-2026-0385 fixed), license report (`pnpm licenses:check`, deny.toml);
  - [x] **web:** CSP and security headers (`security-headers.test.ts`);
  - [x] **secrets:** gitleaks in CI (history clean after a reviewed allowlist);
  - [x] **crypto bindings:** CI `bindings` job regenerates `wasm2` and `jsi2` and diffs them; pickle-key copies zeroized in Rust; WASM build paths remapped.
- [x] **32-bit Android:** decided: 64-bit only until Play data shows a need (ADR 0030).
- [x] **Retention and deletion audit:** `dist/retention-audit.js` (+ test); backups exclude delivery data; wording updated. [ ] **Run it on staging** (user step, docs/ops/retention-audit.md).
- [x] **Abuse tests:** per-sender mailbox budget added and tested; WS flood tested; uploads, OTP/login, pairing, mesh spam already covered (`abuse.int.test.ts` header).
- [x] **Load and cost:** k6 script (`k6/`), load harness, local measurements, migration backlog bug found and fixed, projections and thresholds (`docs/ops/capacity.md`). Decision: stay on KVM 1. [ ] **Re-run on the VPS** (capacity.md §5).
- [x] **Legal and wording:** privacy policy and terms drafts (`docs/legal/`, fields to fill), in-app explainer shared by phone and web (`@pingdost/chat-core` `PRIVACY_EXPLAINER`), Play Data Safety answers (`docs/release/play-console.md`).
- [x] **Runbooks** `docs/ops/`: `incidents.md` (Redis/Mongo full or down, disk full, provider limits, key or secret compromise, TURN abuse, mailbox abuse), secret rotation (deploy.md, extended), `restore-metadata-db.md`, `retention-audit.md`.
- [ ] **Release** (user steps): Play Console account (**US$25; not paid**), internal testing track, the web production deploy (Pages variables). Done in code: versioning (0.1.0 / versionCode 1), the release AAB builds (R8 fix for react-native-webrtc), crash reporting = none (ADR 0030), checklist `docs/release/README.md`. Account deletion built 2026-11-09 (ADR 0036: Settings → Delete account, email code, `POST /v1/me/delete`; integration-tested). The Cloudinary picture is deleted too (best effort, tested against a fake). Still before Play production: the web resource for deletion requests, a check on a phone, and one real Cloudinary check.
- [x] Update README with the status and an honest feature list; iOS pending (Phases 28–30).
- [x] From handoffs: FLAG_SECURE on the recovery phrase (expo-screen-capture), a frozen `.pdbk` fixture restored by every build, the device-owner cache (Phase 18), Play declarations (Phases 22–26).
## Key files
`docs/security/*`, `docs/ops/*`, `tests/acceptance/*` (or per-package), `.github/workflows/ci.yml` (gitleaks, audits), `k6/*`

## Done when
- The traceability table is complete, with every automatable REQ §19 item passing and the manual ones signed off.
- The audits are clean or have documented accepted risks.
- The internal-track build is installable by testers.
- The production web is live.

## Handoff notes
**From Phase 10 (ADR 0012):**
- Hermes V1 (RN 0.88) has a strict native `TextDecoder`, so `Utf8TextDecoder` is a fallback only. Keep the self-test in `src/polyfills.ts`.
- Safety numbers use expo-crypto's native SHA-512: about 1.4 s in a debug build on the emulator. Measure on a low-end phone in a release build.
- Release builds must not log: the `[engine]`, `[safety]` and `[polyfills]` logs run only under `__DEV__`.
**From Phase 11 (ADR 0014):**
- `abuse_reports` has no review tooling yet: add a moderation path, and keep the in-app copy ("deleted after 90 days") in step with `ABUSE_REPORT_RETENTION_SECONDS`.
- Ops (edit, delete, reaction) are not resent after a session repair once the server accepted them. Measure how often this happens before changing it.
**From Phase 12 (ADR 0015):**
- The notification small icon is the Expo template's monochrome glyph (`assets/images/android-icon-monochrome.png`): replace it with the PingDost mark.
- FCM may deprioritize high-priority data messages that rarely end in a visible notification (muted chats, duplicates): check delivery delay on real phones, including OEM battery savers.
**From Phase 13 (ADR 0016):**
- A device that missed a promotion rejects that admin's controls until a newer control or server notice: measure how often added members end up without keys from some members.
- Admins plus a compromised server can add members; document this in the security review.
**From Phase 14 (ADR 0017):**
- REQ §19.3 server bullets are covered by `apps/server/test/attachments.int.test.ts` (fs + s3) and `engine.int.test.ts` scenario 9. The 100 MiB spike is slow-tagged: re-run it on the VPS and record the timings.
- The staged-attachment record keeps the recipient device IDs and sizes until deletion: list this metadata in the privacy notes.
- **From Phase 18 (ADR 0021):**
  - each relayed ephemeral packet reads the recipient device from Mongo (`delivery.prepare` → `activeDeviceOwner`); cache it if relays get busy;
  - the phone serves history and files only while PingDost is open (no push wake for a sync);
  - the web has no video compression, and viewing a file holds it whole in memory (up to 100 MB);
  - no Playwright e2e for the web UI yet.
**From Phase 19 (ADR 0022):**
- Block screenshots on the recovery-phrase screens (`FLAG_SECURE`, e.g. expo-screen-capture; check its license and version).
- A restore that dies after the server accepted the new phone resumes with a partial history: record a "restore pending" marker and offer to re-run it.
- Approving from the old phone moves no history: consider an online hand-over over the Phase 18 sync channel.
- Keep old `.pdbk` files readable: a fixture backup from this version restored by every later build.
- Device checks of the phone-change flows on two real phones (see the Phase 19 PROGRESS entry).
**From Phase 24 (ADR 0027; CHANGES 2026-11-01):**
- Wi-Fi Aware as a bulk path for mesh files once ADR 0023's matrix is measured on two phones (platform API; `NEARBY_WIFI_DEVICES` on Android 13+). Then reconsider the 25 MB default limit.
- The web client should fetch `mesh` attachments from the phone first (`fetchFromPhone`) instead of trying the server.
- A mesh file whose sender gets the Internet back mid-transfer still completes only over the mesh: consider staging it then.
- Pipelined chunk offers (a window, or range ACKs) if the device measurements show the stop-and-wait ACK costs much airtime; measure JavaScript SHA-256 per chunk on low-end phones.
- Groups and the sender's other phones get no mesh files yet.

**From Phase 23 (ADR 0025, 0026; CHANGES 2026-11-01):**
- Privacy notice: relays see daily routing tokens, packet IDs, times, hop budget, copies, size, crypto type, and for groups the group and Megolm session IDs. Phones in range can recognise a phone's public device key (ADR 0026). The Nearby relay screen says so already; reuse its wording.
- Play Console: declare `RECEIVE_BOOT_COMPLETED` (the optional reminder after a restart) beside the `connectedDevice` service. Decide whether a headless start at boot is wanted (the relay is JavaScript; ADR 0025).
- "Clear relay cache" frees rows but not file size: consider a `VACUUM` (or `incremental_vacuum`) after clearing up to 250 MB.
- Abuse: delivered-ID lists are unauthenticated and quotas are per self-chosen origin token; measure whether an authenticated delivery proof or tighter per-neighbour limits are needed.
- Copy: "Forwarded by N devices — not yet delivered" (`relayedLabel`) and the relay pause reasons (`describeRelay`) need the release copy review.

**From Phase 22 (ADR 0024):**
- The privacy notes must say what nearby messaging shows to PingDost phones in range: that a PingDost phone is near, and this device's public Ed25519 key, which is stable.
- Declare the Bluetooth permissions and the `connectedDevice` foreground service in Play Console. The text the app shows is in `screens/settings/nearby.tsx`.
- `[nearby]` logs run only under `__DEV__`. Keep it that way: they carry states and counts, never keys.
**From Phases 25–26 (ADR 0028, 0029):**
- Play Console: declare `USE_FULL_SCREEN_INTENT` (calling app) and the `phoneCall` foreground service type, with the reasons.
- Decide TURN over TLS (5349) for production (runbook step exists; off on staging).
- Privacy notice: the server learns that a call invite went to an offline device (it sends the `call` push), and TURN usernames carry the user ID.
- Optional: a self-managed `ConnectionService` (system call log, car, headset buttons); a lost history entry when a browser tab closes mid-call.
