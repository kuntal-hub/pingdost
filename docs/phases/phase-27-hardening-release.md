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
  - **secrets:** scanning (gitleaks) added to CI.
- [ ] **Retention and deletion audit:** scripts that verify no `pending_envelopes`, attachments, OTPs, pairing requests or security events are older than their limits (staging data), and that a backup policy excludes them or the wording reflects that they may be included.
- [ ] **Abuse tests:** mass large uploads (quota), never-delivered queue growth (per-sender limits on pending envelopes; add a cap if missing), WS flood, OTP/login brute force, pairing spam, mesh spam (simulation).
- [ ] **Load and cost:** a k6 (OSS) script on staging covering WS connections, message throughput, mailbox migration under backlog. Project usage against the free-tier limits from A9, and set the alert thresholds.
- [ ] **Legal and wording:**
  - privacy policy and terms (plain language) using the REQ §1 / §5.4 honest wording: what metadata the server sees, temporary ciphertext, no permanent history, irrecoverable without backup, relay metadata, browser storage weakness;
  - in-app privacy explainer screens;
  - Play Store Data Safety answers drafted.
- [ ] **Runbooks** `docs/ops/`: incidents (Redis or Mongo full/down, disk full, provider limit hit, key or secret compromise, TURN abuse), secret rotation, restoring the metadata DB.
- [ ] **Release:** Play Console account (**$25 one-time; confirm with the user first**); release AAB build (local Gradle, or EAS free); an internal testing track; versioning scheme; crash reporting decision (none, or a self-hosted, privacy-scrubbed option); the web production deploy.
- [ ] Update README with the status and an honest feature list. Note that iOS is pending (Phases 28–30).

## Key files
`docs/security/*`, `docs/ops/*`, `tests/acceptance/*` (or per-package), `.github/workflows/ci.yml` (gitleaks, audits), `k6/*`

## Done when
- The traceability table is complete, with every automatable REQ §19 item passing and the manual ones signed off.
- The audits are clean or have documented accepted risks.
- The internal-track build is installable by testers.
- The production web is live.
