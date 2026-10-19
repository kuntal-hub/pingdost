# PingDost — Claude session guide

PingDost (pingdost.com) is a privacy-first, offline-capable messenger: E2EE 1:1 and group chat, encrypted attachments, Bluetooth nearby and mesh relay, QR-linked web clients, and 1:1 WebRTC calls.

- **Platforms:** Android + web now; iOS deferred.
- **Repo:** pnpm + Turborepo monorepo, Node 24, TypeScript strict.

## Where things are
- `privacy_first_messaging_app_requirements.md` (**REQ**): the baseline requirements. **Read only the § sections a phase file lists; never read the whole file.**
- `docs/ARCHITECTURE.md`: locked decisions A1–A12 (⚠ marks deviations from REQ). Read only the A-sections a phase lists.
- `docs/ROADMAP.md`: phase list, dependencies and status (⬜ todo · 🔄 in progress · ✅ done).
- `docs/phases/phase-NN-*.md`: the checklist for each phase.
- `docs/PROGRESS.md`: handoff log, newest entry first.
- `docs/CHANGES.md`: requirement changes and deviations, newest first.
- `docs/decisions/`: ADRs (see `docs/decisions/README.md` for the expected ones).

## Session protocol

### "start phase N"
1. Read `docs/ROADMAP.md`, the **top entry only** of `docs/PROGRESS.md`, `docs/CHANGES.md`, and `docs/phases/phase-NN-*.md`.
2. Check the phase's "Depends on" phases are ✅. If one is not, tell the user and stop, unless they say to proceed.
3. Read only the REQ §§, ARCHITECTURE A-sections and ADRs listed under "Read first". Look at existing code only where the phase touches it.
4. Mark the phase 🔄 in ROADMAP. Work through the task checklist. Stay inside the phase scope; anything else goes to "Handoff notes" for a later phase.
5. Record any new or changed decision as an ADR (copy `docs/decisions/0000-template.md`; next free number). Update `docs/ARCHITECTURE.md` if a locked decision changes.
6. Run every check under "Done when". Report results honestly: failures, skips, and device checks the user must do.
7. **Finish:**
   - prepend a handoff entry to `docs/PROGRESS.md` (template inside);
   - mark the phase ✅ (or leave 🔄 with the remaining items listed);
   - fix any later phase files this phase changed;
   - `git commit` with the message `phase NN: <title>`.
   - Pushing: see the "Git" rule below.

### "continue phase N"
Read the top PROGRESS entry (the partial checklist) and the phase file, then resume from the first unchecked item.

### "change: <description>"
A requirement changed.
1. Add an entry to `docs/CHANGES.md` (date, change, affected phases).
2. Update the affected phase files, ROADMAP, and ARCHITECTURE if needed.
3. Finished phases are not reworked unless the user asks. Instead, add a follow-up task to the next suitable phase.

### "status"
Summarize ROADMAP and the top PROGRESS entry in a few lines.

## Standing rules
- **Budget is very low.** Prefer free tiers and OSS. **Stop and tell the user before anything that costs money or needs a credit card.**
- **Manual steps.** For anything the user must do by hand (account signups, Google/Firebase consoles, phone settings), give short numbered steps.
- **Privacy and security (ARCHITECTURE A10):**
  - no plaintext, keys, OTPs, tokens, recovery phrases or ciphertext in logs;
  - no custom cryptography;
  - server secrets never go into client bundles;
  - privacy wording is "no permanent server-side chat history".
- **Licenses.** Dependencies must use permissive or OSI licenses. Check the license before adding a dependency.
- **Versions.** Before installing a library, check its current version and API in the docs or via web search; the plan was written in Oct 2026, so do not trust memory. Pin exact versions.
- **Expo work.** Load the `expo:expo-overview` skill before touching `apps/mobile`.
- **Tokens.**
  - Keep exploration narrow.
  - Don't re-read files you just wrote.
  - Prefer targeted test runs (`pnpm --filter <pkg> test`) over full builds while iterating.
  - Avoid spawning subagents unless a task truly needs parallel search.
- **Environment.** Windows 11; use PowerShell or Git Bash. Docker Desktop provides the local infra. Android phones are attached over adb. There is no Mac.
  - **The repo lives in `C:\Users\Km799\OneDrive\Desktop\pingdost`** (the user's choice; work only here). React Native's CMake builds nest the repo path twice in object paths, so Android builds at this path need the one-time long-path setup below (ADR 0005). OneDrive also syncs `node_modules`, Gradle and Rust output (several GB). `C:\dev\pd` is a stale Phase 3 copy.
  - Gradle downloads time out over IPv6 here: set `$env:JAVA_TOOL_OPTIONS='-Djava.net.preferIPv4Stack=true'` before Android builds.
  - One-time Windows setup for Android builds (done on this PC 2026-10-19; ADR 0005): `LongPathsEnabled=1` (`HKLM\SYSTEM\CurrentControlSet\Control\FileSystem`, admin) and Ninja ≥ 1.12 in place of the SDK's `cmake\3.22.1\bin\ninja.exe` (now 1.13.2; the original is `ninja.exe.1.10.2.bak`). Without both, React Native codegen fails with `ninja: error: mkdir(...)` or "build.ninja still dirty".
  - `CI=1 expo start` disables Metro's file watching: restart Metro (`--clear`) after edits when it runs that way.
  - A native Windows **MongoDB Server** service (found 2026-10-19) listens on `127.0.0.1:27017` beside Docker's Mongo (`0.0.0.0`/`::1`). Clients then reach two different mongods: after a Docker Mongo restart the server's client can land on the standalone one and never recover. Stop and disable that service (admin) before trusting Mongo-restart behaviour.
- **Git:** commit at the end of every phase (the user pre-authorized this). Push only if Phase 1 recorded that the user approved end-of-phase pushes; see the "Git remote" line below.

## Git remote
- Push policy: **do not push.** Commit at the end of each phase; the user pushes manually (decided 2026-10-18, Phase 1).
- Remote: the user creates a public GitHub repo `pingdost` by hand (no `gh` CLI on this PC); add it as `origin` once they share the URL.
- License: **AGPL-3.0-or-later**.

## Commands
- `pnpm install`: install everything (pnpm 10.28.1 via `packageManager`). Shared exact versions live in the `catalog:` in `pnpm-workspace.yaml`.
  - `pnpm add` can rewrite `pnpm-workspace.yaml` and drop its comments; restore them (`git diff`) afterwards.
- `pnpm infra:up` / `pnpm infra:down` / `pnpm infra:logs`: MongoDB 8.0 (replica set `rs0`), Valkey 8.1, Mailpit (SMTP :1025, UI http://localhost:8025). `up` waits for healthchecks. Start Docker Desktop first.
- `pnpm lint` / `pnpm typecheck` / `pnpm test`: Turborepo across packages (ESLint typed lint, `tsc --noEmit`, Vitest unit tests).
- `pnpm test:int`: integration tests (`src/**/*.int.test.ts`, via a package's `test:int` script) against the docker-compose services.
- `pnpm --filter @pingdost/<pkg> test`: one package's unit tests (preferred while iterating). `pnpm test:watch`: all unit projects in watch mode.
- `pnpm format` / `pnpm format:check`: Prettier (Markdown is excluded).
- Add `--force` to a `pnpm turbo run …` call to bypass the Turbo cache.
- **Server** (`apps/server`, Fastify; ADR 0007):
  - `pnpm --filter @pingdost/server dev`: API on :3000 (tsx watch; reads the root `.env` if present, else the dev defaults; binds 0.0.0.0 so phones on the LAN can reach it). `dev:worker` runs the jobs process alone; `build` + `start` run the tsup bundle.
  - `pnpm --filter @pingdost/server test:int` needs `pnpm infra:up`. OTP emails land in Mailpit (http://localhost:8025).
  - Probe it with `127.0.0.1`, not `localhost`: Windows tries `::1` first and the server listens on IPv4.
  - WebSocket gateway: `ws://<host>:3000/v1/ws` (protobuf frames; the first must be `Auth`). `/metrics` (Prometheus) needs `METRICS_TOKEN` set on the server and `Authorization: Bearer <token>`.
  - `pnpm --filter @pingdost/sim-client start -- --messages 20 [--metrics-token <token>]` runs two headless devices against the dev server (offline then online delivery, fake ciphertext; needs Mailpit). With the token it prints Redis commands per stored message.
  - `test/redis-budget.int.test.ts` prints `REDIS_BUDGET {...}` and fails if an operation costs more Redis commands than ADR 0010 allows.
- **Protocol** (`packages/protocol`, ADR 0006):
  - `pnpm --filter @pingdost/protocol gen` regenerates `src/gen/` from `proto/` (committed; never hand-edit). CI fails if the committed code differs.
  - The package's `lint` also runs `buf lint`.
  - `pnpm --filter @pingdost/protocol make-vectors` rewrites `packages/test-fixtures/protocol/v1.json`; run it only for a deliberate wire change.
- **Rust / crypto** (toolchain pinned in `rust-toolchain.toml`; needs VS 2022 Build Tools C++ for the MSVC linker):
  - `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo clippy --workspace --target wasm32-unknown-unknown -- -D warnings`, the same with `--target aarch64-linux-android`, `cargo fmt --all`;
  - `pnpm --filter @pingdost/crypto build:wasm` rebuilds the WASM module and regenerates `packages/crypto/src/generated/` (committed; never hand-edit). It needs `wasm-bindgen-cli` at the exact `wasm-bindgen` version in `Cargo.lock` (now 0.2.129: `cargo install wasm-bindgen-cli --version 0.2.129 --locked`);
  - `pnpm --filter @pingdost/crypto test` runs the WASM interop tests in Node.
  - `pnpm --filter @pingdost/crypto-native build:android` cross-compiles `libpingdost_crypto.so` (arm64-v8a, x86_64; git-ignored) with `cargo-ndk` 4.1.2 (`cargo install cargo-ndk --version 4.1.2 --locked`) and regenerates `packages/crypto-native/src/generated/` (committed; never hand-edit). ubrn `jsi2` flavour, ADR 0005. Run it before the first Android build and after any Rust change.
    - First set `$env:ANDROID_NDK_HOME = "$env:ANDROID_HOME\ndk\27.1.12297006"`: the 26.1 and 28.0 NDK folders on this PC are incomplete installs, and cargo-ndk otherwise picks the newest ("Error detecting NDK version").
  - If `cargo` is not found in an older shell, prepend `$env:USERPROFILE\.cargo\bin` to `PATH` (rustup added it for new shells).
- **Android app** (`apps/mobile`, Expo SDK 58 dev build; never Expo Go):
  - `pnpm --filter @pingdost/mobile android`: prebuild (`android/` is generated and git-ignored), Gradle build, install on the attached device/emulator, start Metro. `pnpm --filter @pingdost/mobile start` when the build is already installed.
  - `pnpm --filter @pingdost/mobile android:release`: a release build (for APK size checks).
  - `apps/mobile/.env` (git-ignored) sets `EXPO_PUBLIC_API_URL` / `EXPO_PUBLIC_WS_URL` to the PC's LAN IP (`http://192.168.1.2:3000` on 2026-10-19) and the optional `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`. Metro inlines them: restart it with `--clear` after a change.
  - Typed routes (`.expo/types/router.d.ts`, git-ignored) are regenerated only by `expo start`. `tsc` errors about unknown `href`s mean they are stale.
  - After changing `app.json` plugins or native deps: `npx expo prebuild --platform android --clean` in `apps/mobile`.
  - Crypto interop proof: `pnpm --filter @pingdost/crypto interop-server`, `adb reverse tcp:8787 tcp:8787`, then the app's **Crypto interop (dev)** screen. `pnpm --filter @pingdost/crypto make-vectors` regenerates the test vectors (only when vodozemac changes).
  - Emulators: `Pixel_8_API_35` (x86_64). Install packages with `npx expo install` semantics but pin the exact version it picks.
- Test conventions:
  - unit tests are `src/**/*.test.ts`, and each package with tests has a `vitest.config.ts` using `defineProject` (copy `packages/config/vitest.config.ts`);
  - integration tests are `*.int.test.ts`, with a `vitest.int.config.ts` and the script `"test:int": "vitest run --config vitest.int.config.ts"`;
  - env vars that `test:int` needs must be listed in `passThroughEnv` in `turbo.json` (Turbo strict env mode).
- Tooling notes: TypeScript is pinned to 6.0.x because typescript-eslint 8.71 supports `<6.1`; TS 6 defaults `types` to `[]`, so a package that needs Node types sets `"types": ["node"]`. Git Bash failed to fork in this environment (2026-10-18), so use PowerShell.
  - Windows PowerShell 5.1: `Set-Content -Encoding utf8` writes a BOM (breaks `package.json`), and `Get-Content -Raw` without `-Encoding utf8` mangles non-ASCII. Edit files with the Write/Edit tools instead.
