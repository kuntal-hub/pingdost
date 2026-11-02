# 0030 — Release hardening: audit gates, mailbox limits, batched migration, release policy

- **Status:** Accepted
- **Date:** 2026-11-02
- **Phase:** 27
- **Approved by user:** n.a. (the paid steps, Play Console $25 and a KVM 2 upgrade, are left to the user)

## Context
Phase 27 makes Android + web release-worthy (REQ §5, §18, §19, §21, §23; ARCHITECTURE A9, A10). The audits and the load test found problems that needed decisions beyond the phase plan:
- **Mailbox migration lost envelopes under backlog.** The migration job moved at most one batch (200) per poll (300 s in production), while a staged Redis copy only lives one grace period (900 s) past its due time. More than about 600 envelopes coming due within 15 minutes would expire from Redis before reaching Mongo. The load harness reproduced it: of 10,000 envelopes sent to offline devices, 600 reached Mongo (60 s grace in that run).
- **Atlas Free (M0) allows 100 operations per second** (MongoDB docs, checked 2026-11-02). The per-envelope migration (insert + read-back) and the per-send device lookup spent that budget fast; it, not the VPS, is the first capacity limit.
- **Never-delivered queues had no per-sender limit** (REQ §18).
- **The committed WASM module carried the build machine's paths** (`C:\Users\<name>\.cargo\registry\…`, 84 times): rustc embeds panic locations.
- ADR 0005 left 32-bit Android to this phase; crash reporting, versioning and TURN over TLS also needed a call.

## Options considered
| Topic | Options | Chosen |
|---|---|---|
| Migration throughput | per-envelope with more workers; drain loop only; **drain loop + one bulk upsert and one `$in` read-back per batch** | drain + bulk |
| Device-owner lookups | none; Redis cache; **in-process TTL cache (60 s), dropped on revocation** | in-process |
| Never-delivered queues | Redis counters (cost commands, ADR 0010); count pending envelopes per sender in Mongo (costs M0 operations); **in-memory daily budgets per sender** | in-memory |
| WASM host paths | Cargo `trim-paths` (unstable in 1.99); **`--remap-path-prefix` via `scripts/remap-rust-paths.mjs`** | remap |
| Rust advisories | cargo-audit; **cargo-deny** (advisories + licenses + bans + sources, MIT/Apache-2.0) | cargo-deny |
| Secret scanning | gitleaks-action (licence key for organisations); **the gitleaks container (MIT) in CI** | container |
| 32-bit Android | build the ubrn player for `armeabi-v7a`; switch to the classic `jsi` flavour; **stay 64-bit until Play data shows a need** | 64-bit |
| Crash reporting | Sentry/Crashlytics SDK; self-hosted GlitchTip; **none in the app; Play Console's Android vitals only** | none |

## Decision
1. **Migration** (`modules/delivery/jobs.ts`): each job run calls `drain()`, passes of up to `migrationBatchSize` until nothing more is due, a write fails, or 80 % of the poll interval (the lease) is used. Each pass writes the batch with one unordered bulk upsert (`insertMany`) and verifies it with one `find({_id: {$in}})` (`existing`); a Redis copy is dropped only after its own document was read back. The per-envelope Redis steps (lock, get, unstage) and the Redis budget are unchanged.
2. **Device-owner cache** (`infra/ttl-cache.ts`, `app.ts`): device → owner for 60 s, active devices only, removed by the `onRevoked` hook (the only revocation path). Blocks were already cached (60 s).
3. **Per-sender mailbox budgets** (`modules/delivery/quota.ts`, `ThrottleSettings`): an account may leave at most **5,000 envelopes per recipient device** and **32 MiB of ciphertext** in the mailbox per 24 h. Online deliveries and duplicates are not counted. Over budget, `Send` is answered `RATE_LIMITED` (retryable): the sender keeps the message in its outbox. In memory, single API process (ADR 0013); it resets on restart.
4. **Audit gates in CI** (`.github/workflows/ci.yml`): gitleaks over the whole history (`.gitleaks.toml` allowlists the reviewed test vectors), `pnpm audit` (accepted advisories by GHSA in `pnpm-workspace.yaml` `auditConfig`, dev/build tools only), `pnpm licenses:check` (`scripts/check-licenses.mjs`), `cargo deny check` (`deny.toml`), and a **bindings job** that regenerates the `wasm2` and `jsi2` bindings, diffs the TypeScript, and fails if the committed WASM holds a build-machine path. Security patches for transitive dependencies are pnpm `overrides`, same major only.
5. **Reproducible paths:** `build:wasm` runs through `scripts/remap-rust-paths.mjs` (cargo home → `/cargo/registry/src`, repo → `/pingdost`). The Android `.so` keeps its paths for now: ubrn sets per-target RUSTFLAGS (16 KB page alignment) that a global flag would override. It ships only inside the APK; accepted (low).
6. **Pickle keys** are wiped in Rust (`Zeroizing`) as soon as the FFI call ends; the JS-side copies cannot be (documented in the threat model).
7. **Android ABIs:** `arm64-v8a` and `x86_64` only for internal testing and the first release (ADR 0005 stays). Revisit when Play Console's device catalog or tester reports show 32-bit-only phones in the target market (Android Go devices); then build the ubrn player for `armeabi-v7a`.
8. **No crash-reporting SDK.** Nothing in the app sends crash data. Google Play's Android vitals (collected by Google from users who opted in at the OS level) is the only crash source; the privacy policy and Data Safety answers say so.
9. **Versioning:** `version` in `app.json` is SemVer (`0.1.0` for the first internal build); `android.versionCode` is an integer raised by 1 for every upload to Play (Play rejects a reused code). Server images are tagged `v<version>` (the deploy workflow).
10. **TURN over TLS** stays off for the internal release (ADR 0028's runbook step remains); plain TURN on 3478 UDP/TCP. Revisit if testers on restrictive networks cannot connect.
11. **Release builds:** R8 keeps `org.webrtc.**` (`extraProguardRules`): react-native-webrtc's JNI classes broke `bundleRelease` since Phase 26 (`Missing class org.webrtc.Dav1dDecoder$Natives`). The manifest drops `SYSTEM_ALERT_WINDOW` (Expo template default, unused) and expo-screen-capture's `READ_MEDIA_IMAGES` / `DETECT_SCREEN_CAPTURE` (`blockedPermissions`). Blocking `SYSTEM_ALERT_WINDOW` also removes React Native's debug overlay permission (the perf monitor); acceptable.

## Consequences
- Migration capacity: one batch costs 2 Atlas operations instead of 400; locally a 10,000-envelope backlog migrates within one grace period (Evidence). Production keeps `MESSAGE_MIGRATION_POLL_SECONDS ≤ GRACE / 3`.
- A spammer can still fill the mailbox with many accounts; registration is limited per IP and per address (ADR 0007), and alerts fire on mailbox size (docs/ops/alerts.md). Runbook: docs/ops/incidents.md.
- Capacity numbers and the KVM/M0 decision: docs/ops/capacity.md. The audits and accepted risks: docs/security/audits.md.
- Phase files updated: 27 (this phase), 28 (iOS groundwork note), 29–30 unchanged.

## Evidence
- Load harness (`apps/server/test/load-server.ts`) + k6 2.3.0 (`k6/ws-load.js`) on this PC (2026-11-02), see docs/ops/capacity.md.
- Before the fix: 10,000 offline envelopes, 60 s stage and grace, 20 s poll → 600 in Mongo, the rest expired (the overdue alert fired). Per-envelope drain only: 4,000. Batched drain: see capacity.md.
- `cargo deny check`: RUSTSEC-2026-0385 (`ctutils` 0.4.3, non-constant-time masks) fixed by `cargo update -p ctutils` (0.4.7); then advisories, bans, licenses, sources ok.
- gitleaks v8.30.1: 18 findings over 30 commits, all test vectors or SecureStore item names; none after the allowlist.
- Atlas Free limits: https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/ (100 operations per second; checked 2026-11-02).
