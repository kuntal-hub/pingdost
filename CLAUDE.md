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
- **Hosting (ADR 0013):** one Hostinger KVM VPS is the only paid service. It runs the whole server side in one Docker Compose stack (API + worker, self-hosted Valkey, Caddy, attachments, coturn). There is no Upstash. Mongo stays on Atlas M0, the web app on Cloudflare Pages.
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

## Design system (ADR 0035)
- **`@pingdost/ui-tokens` is the source of truth:** schemes, appearance options and prefs, surfaces, bubble corners, wallpapers, scales. Do not hardcode colors or sizes in screens.
- **Colors:** `primary` is a *fill* (with `on-primary`); use `accent` for text and icons on a background. `pnpm --filter @pingdost/ui-tokens test` checks every scheme against WCAG contrast.
- **Phone:** all text goes through `Text`/`TextInput` from `@/components/text` (no inherited font in React Native; `font-display` is the headline face). Icons come from `@/components/icon` (per-icon Lucide imports; add new ones to its list). Use the primitives in `src/components`: `Tap`, `Button`, `IconButton`, `ListRow`, `ActionSheet`, `Toggle`, `Segmented`, `Chip`, `SwipeAction`, `EmptyState`. Motion goes through `useMotion()` and `haptic()` in `@/theme/motion`, so the user's Motion and Haptics settings hold.
- **Phone spacing:** a class outside the scale in `ui-tokens` (`h-13`) silently does nothing. Add a step or use `h-[52px]`.
- **Web:** `theme.ts` sets `--pd-*` variables through the CSSOM. Motion classes are `pd-*` in `styles.css`, with Calm and Off handled there. `pd-card`, `pd-floating` and `bg-brand` follow the chosen look.
- Emoji are content only (reactions, messages). Everything else is an icon.

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
  - `pnpm --filter @pingdost/sim-client start -- --messages 20 [--metrics-token <token>]` runs two headless devices with real E2EE (message engine + WASM crypto) against the dev server: offline then online delivery, receipts, and a plaintext-marker scan of every WS frame. It needs Mailpit. With the token it prints Redis commands per message.
  - `test/engine.int.test.ts` runs the Phase 9 engine scenarios through a listening test server (`SimClient` from `@pingdost/sim-client`).
  - `test/security.int.test.ts` covers blocks (silently dropped sends, typing and presence scope) and reports (Phase 11, ADR 0014).
  - Groups (ADR 0016): `test/groups.int.test.ts` covers the REST roles and limits, the gateway's member-only routing, and sim clients in Megolm groups (removal, late joiner, two devices, a key after its message). Engine-level group tests: `packages/message-engine/src/groups/*.test.ts`.
  - Push (ADR 0015): `test/push.int.test.ts` runs the real FCM sender against a fake Google and checks the exact request body. Real pushes need `FCM_PROJECT_ID` + `FCM_SERVICE_ACCOUNT_JSON_BASE64` in the root `.env` (setup steps in `docs/phases/phase-12-push-notifications.md`).
  - APNs (ADR 0032): `ApnsSender` is tested against `test/fake-apns.ts` (cleartext HTTP/2 on 127.0.0.1, records every request) in `src/modules/push/apns.test.ts` and the APNs block of `push.int.test.ts`. Real sends need the `APNS_*` group (Apple account; steps in `docs/phases/phase-29-ios-push-calls.md`).
  - `test/redis-budget.int.test.ts` prints `REDIS_BUDGET {...}` and fails if an operation costs more Redis commands than ADR 0010 allows.
  - History sync (ADR 0021): `test/history-sync.int.test.ts` runs a phone and a Dexie-backed browser through disconnects on both sides and proves no Redis or Mongo writes (`startTestServer({ monitorMongo: true })` records Mongo commands). Engine-level sync tests: `packages/message-engine/src/sync/*.test.ts`.
- **Web app** (`apps/web`, Vite 8 + React 19 + Tailwind 4; ADR 0019):
  - `pnpm --filter @pingdost/web dev` (http://localhost:5173, the server's default `WEB_ORIGIN`), `build`, `test`. Copy `apps/web/.env.example` to `apps/web/.env` (`VITE_API_URL`, `VITE_WS_URL`; public values only).
  - The page carries a strict CSP built in `vite.config.ts`. Dev adds a fixed nonce for Vite's own tags. Never add inline scripts or styles; set theme colours through the CSSOM (`theme.ts`).
  - Pairing without a phone: open the dev page, copy "Pairing code as text (dev)", then run `pnpm --filter @pingdost/sim-client phone -- --code '<code>' [--revoke-after 30]`. It registers a simulated primary phone and approves the browser (and revokes it after N s).
  - Web unit tests run in Node with `fake-indexeddb` and Node's Web Crypto.
  - Chat (ADR 0020):
    - the engine runs in the tab holding the Web Lock (`src/chat/leader.ts`); other tabs call it over BroadcastChannel (`src/chat/bus.ts`);
    - storage is `packages/web-store` (`DexieEngineStore`, vault), shared labels are in `packages/chat-core`;
    - the phone↔web check over the real server is `apps/server/test/web.int.test.ts`.
  - History sync and files (ADR 0021): the leader runs the sync (`historySync` engine option; window in Settings) and attachment transfers (`src/attachments/transfers.ts`); the cache is `FileCache` in `packages/web-store` (Dexie version 3). Files sent before pairing come from the phone (`fetchFromPhone`), so the phone app must be open.
  - Notifications and PWA exist only in builds. Run `pnpm --filter @pingdost/server vapid-keys`, put the keys in `.env` and `apps/web/.env` (`VITE_WEB_PUSH_PUBLIC_KEY`), then `pnpm --filter @pingdost/web build` and `preview` (also on :5173).
- **Pairing** (server `modules/pairing`, ADR 0019): `test/pairing.int.test.ts`. `SimClient.linkedDevice(options, owner)` links a second device through the real flow.
- **Backup and phone replacement** (`packages/backup`, server `modules/device/primary-transfer.ts`; ADR 0022):
  - `pnpm --filter @pingdost/backup test`: the `.pdbk` format, phrase, export/restore over `EngineStore`, and a restore → `SessionReset` → resend scenario on the engine's fake server.
  - `test/recovery.int.test.ts`: the three ways to replace the primary (old phone approves, backup + email code, start fresh) with sim clients. `SimClient.newPhone(options, old, { mode })` drives them.
  - Android: `src/backup/*` (create, restore, phrase in SecureStore, reminder), `src/recovery/*` (new-phone flows, approvals, Remove data). Argon2id runs in the Rust crate: after changing it, rebuild WASM and `build:android`.
- **Attachments** (`packages/attachments`, server `modules/attachments`; ADR 0004, 0017):
  - `docker compose --profile s3 up -d --wait` adds SeaweedFS (local S3 on :8333, dev credentials in `docker-compose.yml`). The `s3` halves of `test/attachments.int.test.ts` run only while it is up; `fs` always runs. `pnpm infra:down` leaves it running: stop it with `docker compose --profile s3 down`.
  - The 100 MiB spike is tagged slow: `$env:PINGDOST_SLOW='1'; pnpm --filter @pingdost/server exec vitest run --config vitest.int.config.ts test/attachments-100mb --silent=false`. It prints `ATTACHMENT_SPIKE {...}` (about 45 s for both stores).
  - `pnpm --filter @pingdost/crypto make-attachment-vectors` rewrites `packages/test-fixtures/crypto/attachment-stream-v1.json`. Run it only when the attachment format changes.
  - Android (ADR 0018):
    - `apps/mobile/src/attachments/*` holds the vault, transfers and storage controls. Each local copy is the STREAM ciphertext at `<documents>/attachments/<id>`.
    - Video compression is the local Kotlin module `apps/mobile/modules/pingdost-media` (Media3, autolinked). To compile just it, run `.\gradlew.bat :pingdost-media:compileDebugKotlin` in `apps/mobile/android` after a prebuild.
  - **Nearby (ADR 0023):**
    - `apps/mobile/modules/nearby` is a local Kotlin module on Android's BLE APIs: GATT links, framing, credit flow control, the `connectedDevice` foreground service. There is no Play Services. JS is in `modules/nearby/src` (types, `parseInbound`, `createBleTransport`).
    - JVM tests (framing, flow control): `.\gradlew.bat :nearby:testDebugUnitTest` in `apps/mobile/android` (about 4 minutes the first time). The TS tests run with `pnpm --filter @pingdost/mobile test`.
    - iOS (Phase 30, ADR 0033): `modules/nearby/ios` (Swift). `Core/` (framing, link, policy, inbound queue) has no Apple imports: test it with `docker run --rm -v "${PWD}/apps/mobile/modules/nearby/ios:/src:ro" swift:6.4.2-noble bash -c "cp -r /src /pkg && cd /pkg && swift test"` (the copy keeps SwiftPM's `.build` out of the OneDrive folder). `BleEngine.swift` (CoreBluetooth) compiles only in `ios.yml`. The iPhone connects to every peer it is not linked to (iOS cannot advertise its token). Device matrix: `docs/ops/nearby-ios-matrix.md`.
    - Dev screen: Settings → Developer → **Nearby spike (dev)**. It needs two real phones, since BLE does not work in the emulator. ADR 0023 has the measurement steps; **Share report** exports the results. Turn Nearby messaging off first: both read the same native queue.
  - **Nearby messaging (ADR 0024):**
    - `NearbyPeerTransport` (`packages/transport/src/nearby.ts`) runs the signed two-step `Hello` and per-envelope `Ack`. `TransportRouter.route()` chooses Internet, then nearby, else `waiting_for_nearby_route`.
    - The engine side is `createNearbyIdentity` plus outbox routing; the app side is `apps/mobile/src/nearby/` (the toggle in Settings → Nearby messaging, off by default).
    - Tests: `pnpm --filter @pingdost/transport test` and `pnpm --filter @pingdost/message-engine exec vitest run src/routing` (two engines in airplane mode over `@pingdost/transport/testing`'s in-memory radio).
  - **Mesh relay (ADR 0025):**
    - `MeshRelay` (`packages/transport/src/mesh.ts`) runs on the proved nearby links: daily routing tokens, signed `MESH_ENVELOPE`s, binary spray-and-wait, signed `MeshAck`s, `MeshSummary`. Limits, the seen-cache and `RelayStore` live in `packages/mesh-protocol` (`pnpm --filter @pingdost/mesh-protocol test`).
    - The router's `mesh` tier answers `held`: the engine keeps the item and marks rows `relayed` with `relays: N` on `onRelayed`.
    - Simulation: `pnpm --filter @pingdost/message-engine exec vitest run src/mesh` (`MeshSim`: virtual phones with real engines, `meet`/`part`, mobility schedules; A→B→C, tamper, duplicates, hops, expiry, quotas, rates).
    - Android: `src/nearby/relay*.ts` (pause rules, `SqliteMeshPersistence` on migration 008's `mesh_relay_packets`), Settings → **Nearby relay** (off by default; needs Nearby messaging on), Storage → Nearby relay cache. Native: `setRelayNotification`, `setRestartReminder` (`BootReceiver`); a new build is needed for them.
  - **Files over the mesh (ADR 0027):**
    - A `mesh` manifest plus signed `MESH_CHUNK`s (one STREAM chunk each). `MeshRelay.sendFile`/`withdrawFile`, `MeshFileReceiver` (`@pingdost/attachments`: bitmaps, durable chunks, `verifyMeshFile`), `engine.confirmMeshFile` (the receipt waits for full verification), `engine.routesTo`.
    - Tests: `pnpm --filter @pingdost/message-engine exec vitest run src/mesh/files.test.ts` (10 MB A→B→C with drops and resume, corrupt chunk, quota, pause/cancel; `MeshSim` phones with `files: true`).
    - Android: `src/nearby/files.ts` (send decision `meshRecipients`, rows `via = 'mesh'`, pause/resume/cancel) and `chunk-store.ts` (migration 009); the limit is in Settings → Nearby messaging (default 25 MB).
    - Compare large byte arrays in tests with `Buffer.equals`, not `toEqual` (vitest's element-wise diff of 10 MB took 40 s).
- **Calls** (`packages/call-engine`, server `modules/calls`, web `src/features/calls`; ADR 0028):
  - `pnpm --filter @pingdost/call-engine test`: the state machine and `CallManager` scenarios over `@pingdost/call-engine/testing` (fake signaling hub, fake WebRTC network).
  - Dev coturn: `docker compose --profile calls up -d --wait` (relay ports 49160–49200; `PINGDOST_TURN_IP=<LAN IP>` for phones). Put the dev TURN values from `.env.example` ("Calls") in `.env` (process env vars also work).
  - `test/calls.int.test.ts` (TURN route, credentials checked by the running coturn, call pushes) and `test/calls-webrtc.int.test.ts` (two werift sim clients, direct and TURN-forced, frame scan; prints `CALL_SPIKE {...}` with `--silent=false`). The coturn halves skip when it is not up.
  - `pnpm --filter @pingdost/sim-client peer` answers calls with a werift echo (`--relay`, `--answer-after N`, `--dial-user <user ID> [--video]`; `PINGDOST_CALL_DEBUG=1` times werift's steps).
  - Web: Settings → Calls → **Force relay (TURN)**, and **Test media (dev)** (a generated tone and picture, so calls need no camera or permission prompt). Chrome's mDNS host candidates make werift wait 10 s each; the manager adds candidates in the background.
  - In-call changes (Phase 32, ADR 0037): voice ↔ video (`requestVideo`/`acceptVideo`/`switchToVoice`), screen sharing (`startScreenShare('app' | 'screen')`), all by `replaceTrack` on the video section every call has. The sim peer agrees to every switch to video and echoes a shared screen back. Web Test media also stands in for the screen picker. Android: picture-in-picture is `CallPip` in `modules/pingdost-calls` + `plugins/with-call-pip.js`; the mini window and PiP view are `src/screens/calls/call-overlays.tsx`.
  - Camera effects (Phase 33, ADR 0038): the shaders are `packages/call-engine/src/effects.ts` (GLSL ES 1.00; sample only through `sample(`). Android runs them in `modules/pingdost-calls` `CallEffects.kt` (react-native-webrtc processor `pingdost-effects`; face tracking with Android's `FaceDetector`), the web in `src/features/calls/effects.ts` (insertable streams, Chrome/Edge). After changing a shader, compile all of them in Chrome: on the dev page's console, `(await import('/src/features/calls/effects.ts')).checkEffectShaders()` must return `[]`.
- **Staging deployment** (ADR 0013; runbooks in `docs/ops/`: `vps-setup.md`, `deploy.md`, `alerts.md`, `mobile-release.md`):
  - Image: `docker build -f apps/server/Dockerfile --platform linux/amd64 -t pingdost-server:local .` from the repo root (about 6 minutes; `.dockerignore` keeps `.env` and build output out).
  - Stack: `deploy/compose.staging.yml` + `deploy/Caddyfile` + a `.env` from `deploy/env.staging.example`. To rehearse locally, use another project name (`-p pingdost-stage`; the dev stack is also `pingdost`), an override that swaps in the local image and maps Caddy to `8088:80`, `API_DOMAIN=http://localhost`, and send `Host: localhost` (Caddy answers other hosts with an empty 200).
  - Scripts (`deploy/scripts/`: `vps-setup.sh`, `monitor.sh`, `mongo-backup.sh`): lint with `docker run --rm -v "${PWD}/deploy/scripts:/mnt:ro" koalaman/shellcheck:stable -S warning /mnt/*.sh`.
  - Deploys: pushing a `v*` tag runs `.github/workflows/deploy.yml` (GHCR image, SSH to the VPS). The `staging` GitHub environment holds the SSH variables and secrets.
  - Android release signing: `apps/mobile/plugins/with-release-signing.js` reads `PINGDOST_UPLOAD_*` Gradle properties from `%USERPROFILE%\.gradle\gradle.properties`; staging URLs go in `apps/mobile/.env.production`.
- **Hardening & release** (Phase 27, ADR 0030; `docs/security/`, `docs/ops/`, `docs/release/`):
  - Audits (CI runs them too): `pnpm audit` (accepted GHSAs in `pnpm-workspace.yaml` `auditConfig`; patch fixes as `overrides`), `pnpm licenses:check`, `cargo deny check` (`cargo install cargo-deny --version 0.20.2 --locked`; deny.toml), gitleaks: `docker run --rm -v "${PWD}:/repo:ro" ghcr.io/gitleaks/gitleaks:v8.30.1 git /repo --config /repo/.gitleaks.toml --redact --no-banner`.
  - `build:wasm` goes through `scripts/remap-rust-paths.mjs` (no build-machine paths in the committed WASM; CI checks).
  - Retention audit: `pnpm --filter @pingdost/server retention-audit` (dev) or `docker compose -f compose.staging.yml exec server node dist/retention-audit.js` (VPS); exit 1 on a violation.
  - Load: `apps/server/test/load-server.ts` (dev harness, relaxed per-IP limits, DB `pingdost_load`), `pnpm --filter @pingdost/sim-client load-prep`, then k6 2.3.0 in Docker (`k6/README.md`). Results: `docs/ops/capacity.md`.
  - `test/abuse.int.test.ts` (mailbox budget, WS flood), `test/retention.int.test.ts`; `engine.int.test.ts` 10 scans debug logs; `log-hygiene.test.ts` (mobile, web) require `__DEV__` / `import.meta.env.DEV` around every `console.*`.
  - The frozen backup fixture `packages/test-fixtures/backup/pdbk-v1.*` must keep restoring (`packages/backup/src/compat.test.ts`); never regenerate it (`make-fixture` only for a new format version).
  - The in-app privacy explainer text is `packages/chat-core/src/privacy.ts` (phone and web); keep it in step with `docs/legal/privacy-policy.md`.
- **iOS groundwork** (Phase 28, ADR 0031; no Mac here):
  - Compile check: `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`, then `cargo clippy --workspace --target aarch64-apple-ios -- -D warnings` (and `-sim`).
  - Expo refuses iOS prebuild on Windows; run it in Linux: `docker run --rm -v "${PWD}:/repo" -w /repo/apps/mobile -e CI=1 node:24-bookworm-slim node /repo/node_modules/expo/bin/cli prebuild --platform ios --no-install` (about 10 minutes through the bind mount; `apps/mobile/ios/` is git-ignored). JS: `npx expo export --platform ios --output-dir <tmp>` in `apps/mobile`.
  - The xcframework (`pnpm --filter @pingdost/crypto-native build:ios`) and real builds need macOS: `.github/workflows/ios.yml` (manual `workflow_dispatch`).
  - Android-only local modules must load with `requireOptionalNativeModule` (a `requireNativeModule` at import crashes iOS).
  - iOS calls (Phase 29, ADR 0032): `modules/pingdost-calls/ios` (Swift: `CallKitCenter`, `CallsAppDelegate`, `CallsModule`; podspec in `ios/`), JS `src/calls/callkit.ts` (unit-tested bridge) and `src/calls/voip.ts` (loaded by `index.ts`). Swift compiles only in `ios.yml`. `PINGDOST_APS_ENVIRONMENT=production` for TestFlight/App Store builds.
  - `create-expo-module add-platform-support` hung here without output (2026-11-03): write a local module's `ios/` (podspec + Swift) by hand, modelled on `node_modules/expo-keep-awake/ios`.- **Message engine** (`packages/message-engine`, `packages/transport`; ADR 0011): `pnpm --filter @pingdost/message-engine test` runs the engine over an in-memory fake server with real vodozemac. `@pingdost/message-engine/testing` exports `runEngineStoreContract` (every `EngineStore` must pass it) and `FakeServer`.
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
  - **EAS dev build** (ADR 0034; project `@kuntal-hub/pingdost`, Free plan: 15 Android builds/month): in `apps/mobile`, `npx eas-cli@27.3.0 build -p android -e development`. One APK holds arm64-v8a + x86_64 (phone and emulator); install it with `adb install`, then `pnpm --filter @pingdost/mobile start`. Rebuild only after native changes. The root `.easignore` replaces every `.gitignore` for the upload (keep it in step) and ships the local `libpingdost_crypto.so`: run `build:android` first if the Rust crate changed. Check the upload with `eas build:inspect -p android -e development --stage archive --output <dir>`. The user's step-by-step for the emulator and several phones (`adb reverse`, Wi-Fi mode, chat test) is `docs/ops/run-on-devices.md`.
  - `apps/mobile/.env` (git-ignored) sets `EXPO_PUBLIC_API_URL` / `EXPO_PUBLIC_WS_URL` to the PC's LAN IP (`http://192.168.1.2:3000` on 2026-10-19) and the optional `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`. Metro inlines them: restart it with `--clear` after a change.
  - Typed routes (`.expo/types/router.d.ts`, git-ignored) are regenerated only by `expo start`, and only with file watching on (`CI` unset; `CI=1` skips it). `tsc` errors about unknown `href`s mean they are stale.
  - After changing `app.json` plugins or native deps: `npx expo prebuild --platform android --clean` in `apps/mobile`.
  - The entry is `apps/mobile/index.ts` (polyfills → push wake task → `expo-router/entry`): a push can start the bundle headless to run only the task. `apps/mobile/google-services.json` (git-ignored, optional) enables FCM; `app.config.js` adds it only when present.
  - Crypto interop proof: `pnpm --filter @pingdost/crypto interop-server`, `adb reverse tcp:8787 tcp:8787`, then the app's **Crypto interop (dev)** screen. `pnpm --filter @pingdost/crypto make-vectors` regenerates the test vectors (only when vodozemac changes).
  - Emulators: `Pixel_8_API_35` (x86_64). Install packages with `npx expo install` semantics but pin the exact version it picks.
  - **Calls (ADR 0029):** `src/calls/*` (runtime, react-native-webrtc platform, call wake), `/call` screen, Calls tab. Native: `modules/pingdost-calls` (incoming call notification with full-screen intent, `phoneCall` foreground service, audio routes, proximity, lock screen); compile just it with `.\gradlew.bat :pingdost-calls:compileDebugKotlin` after a prebuild. Single-phone call checks: `sim-client peer` answers (and `--dial-user <your user ID> [--video]` rings the phone). The emulator reaches the PC as `10.0.2.2`: start Metro with `$env:EXPO_PUBLIC_API_URL='http://10.0.2.2:3000'` (process env beats `.env`). If two phones cannot reach each other (ICE failed, e.g. one phone is the other's hotspot), relay over USB: `docker compose --profile calls up -d --wait`, start the server with `$env:TURN_URLS='turn:127.0.0.1:3478?transport=tcp'` and the dev `TURN_SHARED_SECRET` from `.env.example`, and run `adb reverse tcp:3478 tcp:3478` on each phone.
  - **Device checks without a second phone:** `pnpm --filter @pingdost/sim-client peer` starts a headless E2EE contact (prints its username; shows online, sends read receipts, types, then echoes every message as a reply). Messages starting with `!react` / `!edit` / `!delete` make it react 👍, edit its echo, or delete its echo for everyone; it logs your edits, deletes and reactions. This PC cannot run two emulators next to Docker, Metro and the server: it runs out of RAM and the second emulator's display freezes. Use a phone plus one emulator.
  - A debug build contains only the ABI of the device it was built for: an APK built for a phone (arm64) crashes on the x86_64 emulator (`libreactnative.so` not found). Rebuild for the emulator with `npx expo run:android --no-bundler --device emulator-5554` in `apps/mobile`.
  - Routes are lazy bundles in dev. To check a screen compiles without a device, ask the running Metro for it: `http://127.0.0.1:8081/apps/mobile/src/app/<route>.bundle?platform=android&dev=true` (path from the monorepo root, URL-encoded).
  - UI automation over adb works (`uiautomator dump` plus `input tap/text`). Pull screenshots with `adb shell screencap -p /sdcard/x.png; adb pull …`: PowerShell's `>` mangles binary output.
- Test conventions:
  - unit tests are `src/**/*.test.ts`, and each package with tests has a `vitest.config.ts` using `defineProject` (copy `packages/config/vitest.config.ts`);
  - integration tests are `*.int.test.ts`, with a `vitest.int.config.ts` and the script `"test:int": "vitest run --config vitest.int.config.ts"`;
  - env vars that `test:int` needs must be listed in `passThroughEnv` in `turbo.json` (Turbo strict env mode).
- Tooling notes: TypeScript is pinned to 6.0.x because typescript-eslint 8.71 supports `<6.1`; TS 6 defaults `types` to `[]`, so a package that needs Node types sets `"types": ["node"]`. Git Bash failed to fork in this environment (2026-10-18), so use PowerShell.
  - Windows PowerShell 5.1: `Set-Content -Encoding utf8` writes a BOM (breaks `package.json`), and `Get-Content -Raw` without `-Encoding utf8` mangles non-ASCII. Edit files with the Write/Edit tools instead.
