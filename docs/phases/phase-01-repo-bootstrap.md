# Phase 01 — Repo bootstrap

**Depends on:** — · **Platforms:** tooling only

## Goal
Create a working monorepo: tooling, the typed config package, local infra, CI and project hygiene files. Every later phase builds on this without revisiting it.

## Read first
- REQ §4.1, §4.2, §9.1, §17
- ARCHITECTURE A1, A8, A10, A11

## Tasks
- [x] **Ask the user** (one AskUserQuestion call):
  - (a) project license. Recommend **AGPL-3.0-or-later**: it keeps the libsignal option open and stops closed forks. Alternatives: MPL-2.0, Apache-2.0.
  - (b) whether a public GitHub repo exists or should be created (`gh repo create pingdost --public` if `gh` is installed and authenticated; otherwise give the user the steps).
  - (c) whether end-of-phase `git push` is OK.
  - Record (c) in `CLAUDE.md` under "Git remote".
- [x] `git init -b main`. Add `.gitignore` (node_modules, dist, .turbo, .expo, android/ios build dirs, `target/`, `.env*` except `.env.example`, `.data/`, `*.keystore`, `google-services.json`, coverage) and `.gitattributes` (`* text=auto eol=lf`).
- [x] **Root setup:**
  - `package.json`: private; `packageManager: pnpm@<installed>`; `engines.node >=24`; scripts `lint`, `typecheck`, `test`, `test:int`, `format`, `infra:up`, `infra:down`, `infra:logs`.
  - `pnpm-workspace.yaml`: `apps/*`, `packages/*`, `tools/*`.
  - `turbo.json` tasks: `lint`, `typecheck`, `test`, `test:int` (no cache), `build`, `dev` (persistent).
  - `.npmrc`: leave defaults. Phase 3 adjusts it if Expo/Metro needs `node-linker=hoisted`, following the Expo monorepo docs.
- [x] **Shared configs:**
  - `tsconfig.base.json`: strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` off, `moduleResolution: bundler`, `module: ESNext`, `target: ES2022`, `verbatimModuleSyntax`.
  - `eslint.config.js` (flat, typescript-eslint, import ordering) and `.prettierrc`.
  - Vitest root config with `projects`.
- [x] **Package skeletons** under `packages/`: `config`, `shared-types`, `protocol`, `crypto`, `message-engine`, `transport`, `mesh-protocol`, `attachments`, `auth`, `api-client`, `ui-tokens`, `test-fixtures`.
  - Each gets `package.json` (`name: @pingdost/<x>`, `type: module`, `exports` → `./src/index.ts`), `tsconfig.json`, `src/index.ts` and a one-line `README.md` with its purpose (ARCHITECTURE A1).
  - **Apps are created in their own phases:** mobile in 03, server in 05, web in 16, sim-client in 08.
- [x] **`packages/config`** (real code):
  - Zod schemas for **every** REQ §17 variable plus the ARCHITECTURE A11 additions.
  - `loadServerConfig(env = process.env)`: bounded positive-integer parsing for every TTL and limit.
  - **Cross-field rules:**
    - `STAGE < MAX_RETENTION`;
    - `MIGRATION_POLL ≤ GRACE/3`;
    - `ATTACHMENT_MAX_RETENTION ≤ MESSAGE_MAX_RETENTION`;
    - `MESH_PACKET_MAX_HOPS` between 1 and 32.
  - **Production fail-fast:** missing secrets fail startup when `NODE_ENV=production`.
  - Optional feature groups (Cloudinary, FCM, Google, SMTP, ZeptoMail) are either complete or entirely absent.
  - The `@pingdost/config/public` export holds client-safe constants and `EXPO_PUBLIC_*`/`VITE_*` parsing. It must **never** import server-secret schemas.
  - Unit tests: defaults, bounds, cross-field failures, production fail-fast, and that the public export contains no secret keys.
- [x] **`docker-compose.yml`:**
  - `mongo:8` with `--replSet rs0` and an init healthcheck that runs `rs.initiate()`;
  - `valkey/valkey:8`;
  - `axllent/mailpit` (SMTP 1025, UI 8025);
  - named volumes and healthchecks.
- [x] `.env.example`: every variable with a short comment and safe dev defaults (e.g. `EMAIL_PROVIDER=smtp` → Mailpit, `REDIS_URL=redis://localhost:6379`, `MONGODB_URI=mongodb://localhost:27017/pingdost?replicaSet=rs0`).
- [x] **`.github/workflows/ci.yml`:** pnpm/action-setup + setup-node 24 with cache, then `pnpm install --frozen-lockfile`, then `pnpm turbo lint typecheck test`. Add a `test:int` job with Mongo (replica set) and Valkey service containers, even if it is mostly empty for now.
- [x] **Project files:**
  - `README.md`: what PingDost is, the privacy promise wording (REQ §1, verbatim spirit), status, quick start, and links to docs.
  - `LICENSE` (user's choice), `SECURITY.md` (private vulnerability reporting via GitHub advisories), a short `CONTRIBUTING.md`.
- [x] Fill the "Commands" section of `CLAUDE.md`.
- [x] Initial commit `phase 01: repo bootstrap`. This includes the planning docs and the REQ file. Push if approved.

## Key files
`package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `eslint.config.js`, `docker-compose.yml`, `.env.example`, `packages/config/src/{server.ts,public.ts,index.ts}`, `.github/workflows/ci.yml`

## Out of scope
Any app code (server, mobile, web); protobuf; crypto.

## Done when
- `pnpm install && pnpm lint && pnpm typecheck && pnpm test` pass locally.
- `pnpm infra:up` brings Mongo (replica set initiated), Valkey and Mailpit to healthy (`docker compose ps`).
- `packages/config` tests cover bounds, cross-field rules and public/secret separation.
- CI is green on GitHub, if the remote is set up.

## Handoff notes
- Record the chosen license and push policy in PROGRESS and in `CLAUDE.md`.
