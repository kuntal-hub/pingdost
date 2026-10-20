# Phase 27 — Hardening & release readiness (Android + web)

**Depends on:** 18, 19, 24, 26 · **Platforms:** all

## Goal
Make the product release-worthy: security and privacy audits, full acceptance traceability, load and cost checks, honest legal and in-app wording, operational runbooks, and a Google Play internal-testing release. It may be split into 27a/27b if it runs long.

## Read first
- REQ §5, §18, §19 (all), §21, §23
- ARCHITECTURE A9, A10
- All ADRs (skim the index)

## Tasks
- [ ] **Threat model** `docs/security/threat-model.md` (assets, actors, trust boundaries: server, relays, push providers, object store, browser storage; STRIDE-lite table; residual risks such as metadata visibility and Megolm post-compromise security limits).
- [ ] **Acceptance traceability** `docs/security/acceptance.md`: every REQ §19 bullet → its automated test or documented manual check, with the latest result. Fill any gaps with tests.
- [ ] **Audits:**
  - **log and crash redaction:** grep plus a runtime capture test across server, mobile and web; no secrets, plaintext or ciphertext;
  - **dependencies:** `pnpm audit`, `cargo audit`, a license report (e.g. `license-checker` + `cargo-deny`) checked against the project license;
  - **web:** CSP and security headers;
  - **secrets:** scanning (gitleaks) added to CI;
  - **crypto bindings (from Phases 2–3):** a CI drift check that regenerates both ubrn bindings (`wasm2`, `jsi2`) and diffs them; zeroize pickle-key copies where the platform allows.
- [ ] **32-bit Android (from Phase 3, ADR 0005):** decide from device data whether to support `armeabi-v7a` (build the ubrn JSI player for it, or switch to the classic `jsi` flavour). Until then the Play listing is 64-bit only.
- [ ] **Retention and deletion audit:** scripts that verify no `pending_envelopes`, attachments, OTPs, pairing requests or security events are older than their limits (staging data), and that a backup policy excludes them or the wording reflects that they may be included.
- [ ] **Abuse tests:** mass large uploads (quota), never-delivered queue growth (per-sender limits on pending envelopes; add a cap if missing), WS flood, OTP/login brute force, pairing spam, mesh spam (simulation).
- [ ] **Load and cost:** a k6 (OSS) script on staging covering WS connections, message throughput, mailbox migration under backlog. Project usage against the VPS's limits (RAM, CPU, disk, monthly transfer; ADR 0013) and Atlas M0's 512 MB, decide whether KVM 1 needs the KVM 2 upgrade (tell the user first: it costs money), and set the alert thresholds.
- [ ] **Legal and wording:**
  - privacy policy and terms (plain language) using the REQ §1 / §5.4 honest wording: what metadata the server sees, temporary ciphertext, no permanent history, irrecoverable without backup, relay metadata, browser storage weakness;
  - in-app privacy explainer screens;
  - Play Store Data Safety answers drafted.
- [ ] **Runbooks** `docs/ops/`: incidents (Redis or Mongo full/down, disk full, provider limit hit, key or secret compromise, TURN abuse), secret rotation, restoring the metadata DB.
- [ ] **Release:** Play Console account (**$25 one-time; confirm with the user first**); release AAB build (local Gradle, or EAS free); an internal testing track; versioning scheme; crash reporting decision (none, or a self-hosted, privacy-scrubbed option); the web production deploy. Production runs on the same VPS: promote the staging stack and its DNS (ADR 0013). There is no second stack.
- [ ] Update README with the status and an honest feature list. Note that iOS is pending (Phases 28–30).

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
