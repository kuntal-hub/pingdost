# @pingdost/server

The Fastify modular monolith (ARCHITECTURE A2). Entrypoints: `src/main.ts` (API; it also runs the jobs when `RUN_WORKER_IN_PROCESS=true`) and `src/worker.ts` (jobs only).

- `src/infra/`: config startup, Mongo (indexes), lazy Redis, the pino logger with redaction, problem+json errors, rate-limit budgets, in-memory counters and the Mongo-leased job scheduler.
- `src/modules/`:
  - `auth`: register, OTP, login, refresh, logout, password reset/change (ADR 0007), Google sign-in (ADR 0008);
  - `account`: `/v1/me`, username lookup, Cloudinary avatar signing;
  - `device`: registration with proof of possession and device certificate, list, revoke;
  - `keys`: signed one-time/fallback keys, directory, atomic claims (ADR 0008);
  - `email` (console / smtp / zeptomail), `security` (audit events), `health`.

```sh
pnpm infra:up                               # Mongo, Valkey, Mailpit
pnpm --filter @pingdost/server dev          # http://localhost:3000; OTP emails at http://localhost:8025
pnpm --filter @pingdost/server test         # unit tests
pnpm --filter @pingdost/server test:int     # integration tests (needs infra)
```
