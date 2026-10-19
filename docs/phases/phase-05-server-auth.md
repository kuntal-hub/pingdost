# Phase 05 — Server foundation + password auth

**Depends on:** 01, 04 · **Platforms:** Node server

## Goal
Stand up the Fastify modular monolith with its foundations: config, Mongo, logging with redaction, errors, health checks, worker scheduler. On top of that, build complete email/password auth with OTP verification, token rotation, rate limits and audit events.

## Read first
- REQ §5.1, §6.1, §15 (Auth, Account, Security, Background worker), §16.1, §17, §18
- ARCHITECTURE A2, A10, A11

## Tasks
- [x] Create `apps/server` (TS; `tsx` for dev; `tsup` for build).
  - `src/app.ts`: `buildApp(config, deps)` registers the plugins.
  - Entrypoints: `src/main.ts` (API) and `src/worker.ts` (jobs). With `RUN_WORKER_IN_PROCESS=true`, `main.ts` also starts the jobs.
- [x] **Infra:**
  - `src/infra/mongo.ts`: client, small pool, `ensureIndexes` registry;
  - `src/infra/redis.ts`: ioredis client with a command-counter wrapper. It is unused until Phase 8; it may be created lazily;
  - `src/infra/logger.ts`: pino with the A2 redaction list and request IDs;
  - `src/infra/errors.ts`: problem+json handler mapping Zod and `AppError`;
  - `src/infra/scheduler.ts`: interval jobs with a Mongo `job_locks` lease (owner, expiresAt), jitter and graceful stop.
- [x] **Health:** `/healthz` (liveness) and `/readyz` (Mongo ping; Redis ping once used). Graceful shutdown closes the HTTP server, sockets and DB clients.
- [x] **Email module:** the `EmailProvider` interface plus `console`, `smtp` (nodemailer) and `zeptomail` (HTTP API; check current API docs) adapters, chosen by `EMAIL_PROVIDER`. Plain-text + simple-HTML templates for OTP verification and password reset.
- [x] **Auth module**, collections `users`, `sessions`, `email_otps`, `security_events`:
  - **Register** `POST /v1/auth/register`:
    - username rules: 3–20 chars, `[a-z0-9_.]`, case-insensitive unique, reserved list;
    - email normalized and unique;
    - password 10–128 chars;
    - Argon2id hash.
    - The user starts as `pending_verification`; send an OTP.
  - **OTP:** `POST /v1/auth/email/verify`, `POST /v1/auth/email/resend`.
    - 6 digits, stored as `HMAC(pepper, otp)`;
    - TTL `EMAIL_OTP_TTL_SECONDS`, max attempts `EMAIL_OTP_MAX_ATTEMPTS`, resend cooldown;
    - single-use; TTL index on expiry.
  - **Login** `POST /v1/auth/login` (email or username + password): constant-time-ish failure path, uniform error, and lockout or backoff after repeated failures.
    - Issues an access JWT (`sub`, `sid`; `did` is added in Phase 6) and a refresh token.
  - **Refresh** `POST /v1/auth/refresh`: rotation. Reuse of an old token revokes the whole family and logs a security event.
  - **Logout** `POST /v1/auth/logout`, which revokes the session.
  - **Password reset:** `POST /v1/auth/password/forgot` sends an OTP; `POST /v1/auth/password/reset` takes the OTP + new password and revokes all sessions. Also `POST /v1/auth/password/change`.
  - **Auth guard:** a Fastify `authenticate` decorator verifying the JWT and that the session is active.
- [x] **Rate limits:** `@fastify/rate-limit` (in-memory store) with per-route budgets, plus per-account and per-email counters (in-memory LRU) for login, OTP send, OTP verify, register and reset.
- [x] **Security events:** `security_events` with a TTL of `SECURITY_EVENT_RETENTION_SECONDS`. Types: register, login_ok, login_fail, otp_fail, refresh_reuse, password_reset. Store only minimal metadata: a hash of the IP and a truncated user agent.
- [x] **Account module (minimal):** `GET /v1/me` and account status. Profile fields come in Phase 6.
- [x] **Tests** (`pnpm test:int`, against docker-compose Mongo + Mailpit; read OTPs via the Mailpit HTTP API) for every flow above, including:
  - expired, reused and over-attempt OTPs;
  - resend cooldown;
  - refresh reuse detection;
  - rate-limit 429s;
  - a **log redaction test**: capture logger output during login/OTP and assert that no password, OTP or token appears.
- [x] **Phase 1 wiring** (ADR 0002):
  - Load config with `loadServerConfig()` from `@pingdost/config`, and redact `SERVER_SECRET_KEYS` and group secrets from any logged config.
  - Integration tests go in `src/**/*.int.test.ts` (or `test/**/*.int.test.ts`), with a `vitest.int.config.ts` and `"test:int": "vitest run --config vitest.int.config.ts"`.
  - CI: add `mailpit` to the `docker compose up -d --wait` line in `.github/workflows/ci.yml`, and add any extra env the tests need to `passThroughEnv` of `test:int` in `turbo.json`.
- [x] Add the server dev command to `CLAUDE.md`, and the new env vars to config and `.env.example`.

## Key files
`apps/server/src/{app.ts,main.ts,worker.ts,infra/*,modules/auth/*,modules/email/*,modules/account/*,modules/security/*}`, `apps/server/test/*`

## Out of scope
Google, devices and keys (06); WebSocket (08).

## Done when
- `pnpm --filter @pingdost/server test:int` is green for all auth flows; OTP emails are visible in Mailpit.
- `pnpm --filter @pingdost/server dev` starts; `/readyz` returns OK with infra up and fails cleanly with Mongo down.
- `pnpm lint typecheck test` passes.

## Handoff notes
**From Phase 4 (ADR 0006):**
- `@pingdost/shared-types` already has stub DTOs for these routes (`auth.ts`, `profile.ts`, `health.ts`), plus `ErrorCode`, `ERROR_STATUS`, `ProblemSchema` and `problemType()`. Finalize them here: add codes freely, but never rename one.
- User IDs are UUIDv7 strings (canonical lowercase).
- `@pingdost/api-client` `createApiClient` exists (health only); add the auth endpoint functions to it.