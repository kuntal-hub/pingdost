# Security and privacy audits (Phase 27)

Run on 2026-11-02. CI repeats the automatable ones on every push (`.github/workflows/ci.yml`: jobs `rust`, `security`, `bindings`). Re-run the manual ones before each release.

## 1. Log and crash redaction

| Check | How | Result |
|---|---|---|
| Server: sensitive fields scrubbed at any depth; request logs without bodies, query strings or IPs | `src/infra/logger.ts`; `infra.test.ts`; `platform.int.test.ts` "keeps passwords, OTPs, tokens and email addresses out of the logs" | pass |
| Server runtime capture at **debug** level across registration, device setup, messages, a restart, attachments | `engine.int.test.ts` 10: no plaintext marker, bearer token, refresh token, OTP, password, attachment key, or envelope/attachment ciphertext sample (base64, base64url, hex) in any log line | pass |
| Mobile JS: every `console.*` behind `__DEV__` | `apps/mobile/src/log-hygiene.test.ts` (app + local modules' JS). Fixed two unguarded calls: `crypto/bootstrap.ts` (timings), `app/_layout.tsx` (chat start error) | pass after fix |
| Web: every `console.*` behind `import.meta.env.DEV` | `apps/web/src/log-hygiene.test.ts` | pass |
| Kotlin modules (`nearby`, `pingdost-calls`, `pingdost-media`) | grep `Log.*`: five `Log.w` lines with fixed text and exception classes, no keys, addresses or payloads | pass (manual) |
| Crash reporting | No crash SDK in the app or web (ADR 0030). Play's Android vitals only | n/a |
| coturn | Logs problem lines that can name the TURN username (user ID) and client IP; container logs rotate (about a week) | accepted (ADR 0028) |

## 2. Dependencies

### npm (`pnpm audit`)
- Before: 30 advisories (7 high). Runtime-relevant: `fast-uri` < 3.1.9 / < 4.2.3 inside Fastify's ajv compiler (server).
- Fixed with same-major `overrides` in `pnpm-workspace.yaml`: `fast-uri` 3.1.9 and 4.2.3, `node-forge` 1.4.1, `postcss-selector-parser` 6.1.5, `serialize-javascript` 7.1.3.
- Accepted (`auditConfig.ignoreGhsas`): all inside dev or build tools, never in the server image, the web bundle or the app; no patch in the same major:

| GHSA | Package | Where | Why accepted |
|---|---|---|---|
| GHSA-mrhx-c7xc-m3w5 (high) | zod 3.25 | `@expo/cli` | CLI input validation on the developer's machine |
| GHSA-3g3m-2fjr-6pw4 | glob 11/13 | `@expo/cli`, `workbox-build` | build-time globbing of our own files |
| GHSA-g3hv-75wg-m249 | minimatch 5/10 | eslint, `@expo/cli` | build-time |
| GHSA-w5hq-g745-h8pq | uuid 7 | `xcode` (`@expo/config-plugins`) | only with a caller-supplied buffer; prebuild only |
| GHSA-gcqx-w48m-w2h4 | deepmerge 4.3.1 | `@expo/config` | no fixed version; config merging at build time |
| GHSA-g7r4-m6w7-qqqr | esbuild 0.27 | `tsup` | affects esbuild's dev server, which we never run |

- After: `pnpm audit` exits 0. Review this table whenever Expo, tsup or workbox are upgraded.

### Rust (`cargo deny check`, deny.toml)
- RUSTSEC-2026-0385: `ctutils` 0.4.3 (non-constant-time mask generation; under vodozemac, argon2, chacha20poly1305). Fixed: `cargo update -p ctutils` → 0.4.7; WASM and Android libraries rebuilt.
- After: advisories, bans, licenses, sources ok, for every shipped target (wasm32, Android arm64/x86_64, iOS targets for Phase 28).

### Licenses
- npm: `pnpm licenses:check` (`scripts/check-licenses.mjs`): 1,112 packages, all MIT / Apache-2.0 / ISC / BSD / 0BSD / Unlicense / BlueOak / MPL-2.0 / Python-2.0, or dual-licensed with one of them (`node-forge`: BSD-3-Clause OR GPL-2.0 → BSD). One exception: `caniuse-lite` (CC-BY-4.0 data, build tools only).
- Rust: `cargo deny check licenses` (allow list in deny.toml).
- Native Android: Media3, AndroidX and Kotlin stdlib (Apache-2.0); no Play Services (CHANGES 2026-10-31).
- All compatible with AGPL-3.0-or-later (ADR 0001).

## 3. Web: CSP and security headers
- Page policy (`apps/web/vite.config.ts`): `default-src 'self'`, `script-src 'self' 'wasm-unsafe-eval'`, `style-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `connect-src` = self + the API and WS origins.
- Pages headers (`_headers`): the same policy plus `frame-ancestors 'none'`, HSTS (1 year), `Referrer-Policy: no-referrer`, `nosniff`, `X-Frame-Options: DENY`, COOP `same-origin`, `Permissions-Policy` (camera/microphone self only), no-cache for `sw.js`.
- API (Caddy): HSTS, nosniff, no referrer, `X-Frame-Options: DENY`, `default-src 'none'; frame-ancestors 'none'`, CORP `same-site`, no `Server` header, no access log.
- Locked by `apps/web/src/security-headers.test.ts`. Result: pass. Not added: `require-trusted-types-for` (would need a React/Vite trusted-types policy; revisit).

## 4. Secret scanning
- gitleaks v8.30.1 over the whole history (30 commits): 18 findings, all false positives (published test vectors in `packages/test-fixtures/`, `packages/protocol/src/vectors.ts`, `turn.test.ts`; SecureStore item names in `apps/mobile/src/crypto/secrets.ts`). Allowlisted narrowly in `.gitleaks.toml`; re-scan: no leaks.
- A working-tree scan also flags ed25519-dalek's documentation PEMs inside `target/` (git-ignored build output).
- CI: the `security` job runs gitleaks on every push and pull request.

## 5. Crypto bindings and key hygiene
- **Drift check** (CI `bindings` job): regenerates the `wasm2` (web/Node) and `jsi2` (Android) bindings with ubrn and diffs the committed TypeScript. Local run: both regenerate identically.
- **Build paths:** the committed WASM held 84 copies of `C:\Users\<name>\.cargo\registry\…` (panic locations). `build:wasm` now remaps paths (`scripts/remap-rust-paths.mjs`); CI fails if the module contains a host path. The Android `.so` still carries them (ADR 0030; low).
- **Pickle keys:** wiped in Rust (`Zeroizing`) after each FFI call. JavaScript copies cannot be wiped reliably (accepted; threat model §6).

## 6. Retention and deletion
- `node dist/retention-audit.js` (docs/ops/retention-audit.md) checks TTL indexes and that no envelope, OTP, session, pairing request, device challenge, phone-transfer request, security event, abuse report, staged attachment (record or file) or Redis mailbox key outlived its limit. Dev data: pass. **Staging: not run yet (user step).**
- Backups (`deploy/scripts/mongo-backup.sh`) now also exclude `attachments`, `email_otps` and `job_locks`, next to the mailbox and request collections. They still hold security events and abuse reports up to 7 days past their TTL; the privacy policy says so.
- Valkey's append-only file and the hosting provider's VPS snapshots can hold deleted (still encrypted) envelopes and attachment ciphertext for a while; the privacy policy says so (REQ §18).

## 7. Abuse
| Case | Control | Test |
|---|---|---|
| Mass large uploads | 100 MB per file, 1 GiB per user, 30 GiB total, expiry | `attachments.int.test.ts` |
| Never-delivered queues | **New:** 5,000 envelopes per recipient device and 32 MiB per sender per day (ADR 0030); 14-day expiry | `abuse.int.test.ts` |
| WS flood | 300 frames / 10 s per socket, typing and ephemeral budgets, 64 sends in flight, 60 upgrades / 15 min per IP | `abuse.int.test.ts`, `gateway.int.test.ts` |
| OTP / login brute force | 5 OTP attempts per code, 15 checks per hour, 5 failed logins per 15 min, per-IP limits | `auth-register.int.test.ts`, `auth-session.int.test.ts`, `platform.int.test.ts` |
| Pairing spam | 30 requests / 15 min per IP, 2-minute expiry | `pairing.int.test.ts` |
| Mesh spam | per-origin quotas and rates, 250 MB relay cap, TTL and hops | `mesh/mesh.test.ts` |
| Key-claim exhaustion | 500 claims per hour per account | `keys.int.test.ts` |

Residual: many accounts from many IPs; unauthenticated mesh delivered-ID lists (ADR 0025); abuse reports have no review tool yet (a Mongo query in docs/ops/incidents.md).
