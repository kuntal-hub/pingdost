# PingDost — Progress / Handoff Log

Newest entry first. Each session prepends one entry. Keep it short: the next session reads **only the top entry**. Detail belongs in the phase files, ADRs or code.

<!-- TEMPLATE (copy above the latest entry)
## YYYY-MM-DD — Phase NN: <title> — ✅ done | 🔄 partial
**Done:**
- …
**Remaining (if partial):** checklist items still open, in order
- [ ] …
**Deviations / decisions:** (link ADRs, CHANGES entries)
- …
**Verification results:** commands run + pass/fail; device checks done or pending for the user
- …
**Known issues / tech debt:**
- …
**Next:** phase NN, plus anything the next session must know first
-->

## 2026-10-19 — Phase 05: Server foundation + password auth — ✅ done
**Done:**
- `apps/server` (Fastify 5.12.7 + fastify-type-provider-zod 7, tsx dev, tsup 8.5.1 build): `buildApp(config, deps)`, `main.ts` (API, plus jobs when `RUN_WORKER_IN_PROCESS`) and `worker.ts`.
- Infra:
  - Mongo (driver 7.7, small pool, index registry) and a lazy ioredis 6 handle with a command counter;
  - pino 10 with a deep field scrub (no headers, query strings, IPs or emails in logs) and problem+json errors for AppError, Zod, Fastify 4xx and 404;
  - `@fastify/rate-limit` per-route budgets, in-memory `WindowCounter`s, and a `Scheduler` with `job_locks` leases;
  - graceful shutdown, plus config redaction for logs.
- `/healthz`, `/readyz` (Mongo ping with a 2 s cap; Redis once used).
- Email: `console` / `smtp` (nodemailer 10) / `zeptomail` (HTTP; regional `ZEPTOMAIL_API_URL`), with OTP templates.
- Auth (ADR 0007):
  - register (reserved names; unverified accounts expire after 24 h) → email OTP verify → session;
  - login with a dummy-hash path and a lockout after 5 failures per 15 min;
  - access JWT plus session check on every request; refresh rotation with reuse detection that revokes the family;
  - logout, password forgot/reset (revokes all sessions) and change (revokes the others);
  - security events with hashed IPs, and `GET /v1/me`.
- `@pingdost/api-client` `authApi()`; new codes `OTP_ATTEMPTS_EXCEEDED` and `ACCOUNT_DISABLED`; config adds `LOG_LEVEL`, `TRUST_PROXY`, `ZEPTOMAIL_API_URL` and `UNVERIFIED_ACCOUNT_TTL_SECONDS`.
- CI integration job starts Mailpit too; `MAILPIT_URL` added to turbo `passThroughEnv`. Docs: ADR 0007, A11, CLAUDE.md, handoff notes in phases 06, 08, 16, 20.

**Deviations / decisions (ADR 0007; no REQ changes):** `EMAIL_TAKEN` is returned for verified accounts (an unverified registration is replaced instead). No CORS yet (Phase 16). Phase 5 has no scheduled jobs: TTL indexes expire OTPs, unverified accounts, sessions and security events.

**Verification results:**
- `pnpm turbo run lint typecheck test --force`: 38/38 tasks, 219 unit tests (server 17, config 67). `pnpm format:check` passes.
- `pnpm test:int`: 35/35 against Mongo 8.0 + Valkey + Mailpit. They cover:
  - OTP expiry, reuse, over-attempts and resend cooldown; refresh reuse; lockout; route and per-email 429s;
  - log redaction; readyz with Mongo unreachable (503 in under 3 s); the api-client end to end.
- Manual: `pnpm --filter @pingdost/server dev` starts and `/readyz` returns 200. With the Mongo container stopped it returns 503 after 2 s while `/healthz` stays 200. The tsup bundle starts and `/readyz` returns 200.
- **Mongo restart on this PC:** the server's client did **not** recover after the Docker Mongo came back. Cause: a native Windows "MongoDB Server" service also listens on `127.0.0.1:27017`. Pinned to Docker's Mongo, the client recovered 9 s after the outage. The user should stop and disable that service (CLAUDE.md).
- **Not run:** GitHub CI (no remote yet).

**Known issues / tech debt:**
- Rate limits and lockouts are in memory per instance (one API instance until Phase 20 decides).
- Earlier items still open: binding drift check, pickle-key zeroization (Phase 27), placeholder `OWNER` in `repository.url`, stale `C:\dev\pd`.

**Next:** Phase 06 (Google sign-in, devices, key directory, profiles). It needs Google OAuth client IDs for Phase 7: see its handoff notes.

## 2026-10-19 — Phase 04: Protocol & shared contracts — ✅ done
**Done:**
- `packages/protocol`:
  - buf v2 config and `proto/pingdost/v1/{packet,envelope,content,ws,mesh}.proto`, with protoc-gen-es output committed in `src/gen/`;
  - codecs (`encode*`/`decode*` for TransportPacket, Envelope, Content, ClientFrame, ServerFrame) and `ProtocolError`;
  - Content padding buckets, ID helpers (`uuidv7`, `envelopeIdFor`, UUID/base64), and 44 golden vectors in `packages/test-fixtures/protocol/v1.json`.
- `packages/shared-types`: Zod v4 DTO stubs (auth, profile, devices, keys, groups, attachments, pairing, health), `ErrorCode` + `ERROR_STATUS`, problem+json, pagination, `MessageState` + transitions.
- `packages/api-client`: `createApiClient` (problem+json → `ApiError`, timeouts, GET retries, shared token refresh) + `health()`.
- `packages/crypto`: `CryptoProvider` marked final; `runCryptoConformance(provider, vectors)` (14 scenarios + 3 stored vectors) runs on WASM in Vitest.
- CI: `buf lint` (in the protocol `lint`), a job that fails if regenerated code differs from the commit, and `buf breaking` against main on pull requests.
- Docs: ADR 0006, ARCHITECTURE A4/A8, CLAUDE.md commands; handoff notes in phases 05, 06, 08, 09, 10 (Phase 8's `Send` now carries one packet per frame).

**Deviations / decisions (ADR 0006; no REQ changes):**
- int64 is `bigint` in the generated TS (protobuf-es has no `number` mapping); REST/app code keeps `number` ms.
- Users and devices use UUIDv7 too; device IDs are client-generated.
- `PACKET_KIND_EPHEMERAL` marks never-stored packets; the `flags` bitmask defines `URGENT` (call wake), not EPHEMERAL.
- The WS error frame is `ServerError`, with string `ErrorCode`s shared with REST.
- New deps (licenses checked): `@bufbuild/buf` 1.74.0, `@bufbuild/protobuf` and `@bufbuild/protoc-gen-es` 2.16.0, `uuid` 14.0.3. `@bufbuild/buf`'s postinstall is skipped (`allowBuilds: false`).

**Verification results:**
- `pnpm turbo run lint typecheck test --force`: 35/35 tasks, 201 tests (protocol 77, config 66, crypto 22, shared-types 14, api-client 12, mobile 7, ui-tokens 3). `pnpm format:check` passes.
- `buf lint` is clean, and `buf generate` reproduces the committed code byte for byte.
- `buf breaking` against this commit (`.git#ref=HEAD`) passes; see the commit check below.
- **Not run:** GitHub CI (no remote yet). The `buf breaking` step needs the public repo URL and runs on pull requests only.

**Known issues / tech debt:**
- `pnpm add` rewrote `pnpm-workspace.yaml` without its comments (restored; noted in CLAUDE.md).
- One turbo run failed with a transient "Unexpected end of JSON input" in an unchanged package; the re-run passed (likely a OneDrive sync race).
- The mobile app does not use `@pingdost/protocol` yet; it needs `TextDecoder` and `getRandomValues` polyfills first (Phase 10 handoff).
- Earlier items still open: binding drift check, pickle-key zeroization (Phase 27), placeholder `OWNER` in `repository.url`, stale `C:\dev\pd`.

**Next:** Phase 05 (server foundation + password auth). Phase 21 (nearby spike) can also run any time.

## 2026-10-19 — Phase 03: Crypto spike B (mobile shell + native crypto) — ✅ done
**Crypto gate closed.** The REQ §7.1 proof now covers Android (real phone) and web/Node. On a vivo V2437 (Android 16, arm64) and the x86_64 emulator, all of these pass: the 14 Phase 2 scenarios, the 3 WASM-made vectors, and all 6 phone ↔ Node interop steps (Olm and Megolm, both directions).

**Done:**
- **Repo location:** the phase was finished in a copy at `C:\dev\pd`. The user then chose to keep working in `C:\Users\Km799\OneDrive\Desktop\pingdost`, which was fast-forwarded to the phase commit. A dev build from there works on the phone (long paths + Ninja 1.13.2). `C:\dev\pd` is now stale.
- `apps/mobile` (Expo SDK 58.0.14, RN 0.88, Expo Router `src/app`, NativeWind 4.2.7 + `@pingdost/ui-tokens` light/dark):
  - SQLCipher DB (`src/db/open.ts` with step-named errors, `migrate.ts` + tests);
  - SecureStore secrets; the Olm account store; bootstrap timings;
  - a Phase 3 home screen and the dev-only `(dev)/crypto` screen.
- `packages/crypto-native` (ubrn `jsi2` + the `@ubjs/react-native` player). `createBindingsProvider` (`@pingdost/crypto/core`) is shared by WASM and native.
- `@pingdost/crypto/conformance`: scenarios, vectors and the interop protocol. Also `scripts/interop-server.ts` and `scripts/make-vectors.ts`, with vectors in `packages/test-fixtures/crypto/`.
- Docs: ADR 0005 (with measurements), ARCHITECTURE A5/A6, CHANGES, CLAUDE.md (commands, Windows setup), phases 07/10/27. CI: clippy for `aarch64-linux-android`.

**Deviations / decisions (ADR 0005, CHANGES 2026-10-18):**
- ubrn `jsi2` rather than classic `jsi`, so 64-bit ABIs only. `allowBackup: false`.
- pnpm `nodeLinker: hoisted`. Windows `LongPathsEnabled=1` plus Ninja 1.13.2 swapped into the SDK's CMake 3.22.1 (user-approved).
- `react-native-gesture-handler` 3.3.0 and `react-native-css-interop` 0.2.7 are direct deps. `crypto-native` has no `codegenConfig`.
- Migrations use `BEGIN IMMEDIATE` on the keyed connection: expo-sqlite's exclusive transactions open an unkeyed connection.

**Verification results:**
- `pnpm turbo run lint typecheck test --force`: 32/32 (config 66, crypto 20, mobile 7, ui-tokens 3). `pnpm format:check` passes.
- `cargo fmt --check` passes; clippy is clean on host, wasm32 and aarch64-linux-android; `cargo test` 5/5.
- Device (dev build): restart gives the same identity key ("restored from pickle"). The DB and WAL pulled via `run-as` fail with "file is not a database" and contain no plaintext schema (phone and emulator). SQLCipher 4.17.0.
- Release, on the phone: crypto ready in a median of 64 ms on restore (48–144 ms) and 88–125 ms on first run; activity launch median 678 ms.
- Size: per arm64 slice, the crypto module adds 1.70 MB and SQLCipher 5.06 MB. The two-ABI release APK is 71.4 MB (60.9 MB without SQLCipher).
- **Not run:** GitHub CI (still no remote).

**Known issues / tech debt:**
- `C:\dev\pd` is a stale copy; delete it when convenient. `git stash list` in this folder holds the pre-move working copy (superseded; drop it with `git stash drop`).
- OneDrive syncs `node_modules`, Gradle and Rust output (several GB); watch the OneDrive quota.
- vivo hides `ReactNativeJS` logcat output; read on-screen text instead (`uiautomator dump`).
- Earlier items still open: binding drift check, pickle-key zeroization (Phase 27), placeholder `OWNER` in `repository.url`.

**Next:** Phase 04 (protocol & contracts) or 05. Phase 21 (nearby spike) is now unblocked as well.

## 2026-10-18 — Phase 02: Crypto spike A (gate) — ✅ done
**Done:**
- **Crypto gate (web/Node half) passed; the user approved ADR 0003 and ADR 0004.**
- `crates/pingdost-crypto`: a narrow uniffi 0.31.2 wrapper over vodozemac 0.11.1:
  - Olm `Account`/`Session` and Megolm `GroupSession`/`InboundGroupSession`, with pickles;
  - `ed25519_verify` and `prekey_message_session_id`;
  - a flat `CryptoError` with fixed messages (no key material) and no panics across the FFI.
- `packages/crypto`:
  - the draft `CryptoProvider` (`src/types.ts`; Phase 4 finalizes it);
  - `createWasmCryptoProvider()` (`src/wasm.ts`, which maps errors to `CryptoOperationError`);
  - ubrn `wasm2` bindings plus the `.wasm`, committed in `src/generated/`;
  - 9 interop scenarios plus signature checks in `test/interop.test.ts`.
- Docs:
  - [crypto-license-matrix.md](decisions/crypto-license-matrix.md);
  - ADR 0003 (vodozemac Olm/Megolm, account identity key + device certificates, replay/rotation/backup rules, safety-number proposal);
  - ADR 0004 (attachments: XChaCha20-Poly1305 STREAM in the Rust crate).
- ARCHITECTURE A5 updated. Phases 03, 06, 09, 10, 13, 14, 16 and 19 updated to match.
- CI: a new `rust` job (fmt, clippy for host + wasm32, tests). Rust/crypto commands are in `CLAUDE.md`.

**Deviations / decisions:**
- **Attachments:** libsodium secretstream was dropped (react-native-libsodium 1.7.0 exposes it only on web); ADR 0004 uses RustCrypto instead.
- **Identity:** an account identity key separate from device Olm accounts (ADR 0003). Backups never restore Olm/ratchet state.
- **Tests:** they live in `packages/crypto/test/` (as the phase asked), so the Vitest config includes `test/**`.
- **ubrn needs `repository.url`** in `packages/crypto/package.json`. A placeholder `git+https://github.com/OWNER/pingdost.git` is there for now; **replace it once the GitHub remote exists.**

**Toolchain (exact, for Phase 3):**
1. `winget install --id Rustlang.Rustup -e`: rustup 1.29.1, stable 1.99.1 `x86_64-pc-windows-msvc` (pinned in `rust-toolchain.toml` with clippy, rustfmt and wasm32).
2. `winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --wait --norestart --nocache --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`: MSVC 14.44.35207 + Windows SDK 10.0.26100. Needs one UAC click and about 25 minutes.
3. `cargo install wasm-bindgen-cli --version 0.2.129 --locked` (must match `Cargo.lock`).
4. npm (exact): `uniffi-bindgen-react-native`, `@ubjs/core` and `@ubjs/wasm` 0.31.0-6. Cargo: `uniffi`/`uniffi_core` =0.31.2, `uniffi-runtime-wasm` =0.31.0-6, `vodozemac` =0.11.1 (`wasm_js` feature on wasm32).
5. Android NDK 26.1 / 27.1 / 28.0 were already present (`%ANDROID_HOME%\ndk`). `C:\MinGW` (32-bit GCC 6.3) is on PATH; avoid Rust's GNU toolchain because of it.

**Verification results:**
- `pnpm turbo run lint typecheck test --force`: 26/26 tasks. Crypto: 14/14 tests (all 9 scenarios). Config: 66/66.
- `pnpm format:check` passes.
- `cargo test`: 5/5. `cargo clippy -D warnings` is clean on the host and on wasm32. `cargo fmt --check` passes.
- ubrn `build wasm2 --release` works on Windows. The WASM module is 988 KB raw / 254 KB gzip / 203 KB Brotli.
- **Not run:** GitHub CI, because there is still no remote.

**Known issues / tech debt:**
- **Binding drift:** generated bindings could drift from the Rust source. CI does not rebuild them; add a drift check later (it needs ubrn + wasm-bindgen-cli in CI).
- **Pickle-key copies:** pickle keys are copied as plain `[u8; 32]` in Rust and `Uint8Array` in JS, and are not zeroized. Revisit in Phase 27.
- **WASM size:** could shrink with `wasm-opt` or by dropping `precomputed-tables` (slower signing). Decide in Phase 16.
- **Wrapper scope:** the wrapper has no Ed25519 signing-key object yet. Phase 6 adds it for the account identity key.

**Next:** Phase 03 (crypto spike B: the Android native build of the same crate + an Expo dev build). Read its new Handoff notes first. Phase 04 can also run now.

## 2026-10-18 — Phase 01: Repo bootstrap — ✅ done
**Done:**
- User decisions:
  - license **AGPL-3.0-or-later** (ADR 0001);
  - **no pushes by Claude**: the user pushes manually;
  - the user will create the GitHub repo by hand (no `gh` CLI).
  - All three are recorded in `CLAUDE.md` → "Git remote".
- **Tooling and layout:**
  - `git init -b main`; root tooling: pnpm workspace with a `catalog:` of exact versions, Turborepo (transit-node pattern), `tsconfig.base.json`, ESLint 10 flat config (typed lint, import-x ordering, A10 import guards), Prettier, and a root Vitest `projects` config;
  - 11 skeleton packages plus a real `packages/config`;
  - `docker-compose.yml`: `mongo:8.0.34` (rs0, auto-initiated by the healthcheck), `valkey/valkey:8.1.10-alpine`, `axllent/mailpit:v1.31.6`;
  - `.env.example`, CI workflow, README / LICENSE / SECURITY / CONTRIBUTING, and the `CLAUDE.md` Commands section.
- **`@pingdost/config`:** all REQ §17 + A11 variables, bounded integers, cross-field rules, all-or-none feature groups, production fail-fast (dev-only keys rejected), value-free errors, and a `/public` client entry. Conventions are in ADR 0002.

**Deviations / decisions:**
- ADR 0001 (license) and ADR 0002 (config conventions). ARCHITECTURE A1 (CI) and A10 (license) were updated.
- **TypeScript 6.0.3, not 7.0.2.** typescript-eslint 8.71.2 supports TS `<6.1`. TS 6 defaults `types: []`, so packages opt in (`"types": ["node"]`).
- **CI integration job:** it uses `docker compose up -d --wait mongo valkey` instead of GitHub service containers, because service containers can't pass `--replSet`.
- **Vitest:** each package with tests has its own `vitest.config.ts`; the root config globs `{apps,packages,tools}/*/vitest.config.ts`.
- **Build scripts:** pnpm `allowBuilds: { unrs-resolver: false }` (its postinstall is only a binary check). `ignoredBuiltDependencies` is deprecated in pnpm 10.26+.
- **Extra cross-field rules** beyond the phase list: quota ≥ max attachment size, access TTL < refresh TTL, OTP cooldown < OTP TTL, and no `EMAIL_CONSOLE_SHOW_CONTENT` in production.

**Verification results:**
- `pnpm install --frozen-lockfile` (clean reinstall), then `pnpm turbo run lint typecheck test --force`: 25/25 tasks pass, with 66 config tests.
- `pnpm format:check` passes.
- `pnpm test:int` runs, but there are no integration tests yet ("no tasks").
- Root `pnpm exec vitest run`: 66 pass.
- `pnpm infra:up`: all three containers healthy.
  - Mongo: `setName=rs0`, PRIMARY, majority write OK via `?replicaSet=rs0`.
  - Valkey: PONG.
  - Mailpit: `/readyz` returns 200.
  - Host ports 27017, 6379, 1025 and 8025 are reachable.
- ESLint guard verified: importing `./server` from `public.ts` errors.
- **Not run:** GitHub CI, because there is no remote yet. The user must create the repo and push, then check the Actions tab.

**Known issues / tech debt:**
- Git Bash fails to fork on this PC (`fork: Resource temporarily unavailable`). Use PowerShell.
- Docker Desktop doesn't auto-start; launch it before `pnpm infra:up`.
- Root config files (`eslint.config.js`, `vitest.config.ts`) are formatted by Prettier but not linted or typechecked.
- `turbo.json` `test:int` passes through only `MONGODB_URI` and `REDIS_URL`; Phase 5 adds more. The Phase 5 file was updated with this and the Mailpit CI step.
- pnpm is pinned to the installed 10.28.1 (latest is 12.x); upgrade only deliberately.

**Next:** Phase 02 (crypto spike A).
- Rust is **not installed**. The user needs rustup, and likely the MSVC C++ Build Tools (free); give them numbered steps first.
- Also check the license of every crate and npm package against AGPL-3.0 (ADR 0001).

## 2026-10-18 — Planning session — ✅ done
**Done:**
- Read the REQ doc. Asked the user four questions:
  - test devices: 2+ Android phones, focus on Android + web;
  - hosting: decide later;
  - social login: Google only;
  - license: open source.
- Created `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md` (30 phases), `docs/CHANGES.md`, `docs/decisions/`, and `docs/phases/phase-01…30`.

**Deviations / decisions:** see `docs/CHANGES.md` (initial entries) and the ⚠ items in ARCHITECTURE.

**Verification results:** documentation only; no code yet. The repo is not yet a git repository (Phase 1 runs `git init`).

**Machine facts:**
- Installed: Node 24.11, pnpm 10.28, Docker 29.4, git 2.52, Android SDK (adb 1.0.41), JDK 17 (OpenLogic), Python 3.11.
- **Not installed:** Rust (needed in Phase 2), plus likely MSVC C++ Build Tools and the Android NDK (Phases 2–3).

**Next:** "start phase 1".
