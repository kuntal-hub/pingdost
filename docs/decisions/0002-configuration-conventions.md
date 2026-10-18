# 0002 — Configuration conventions (`@pingdost/config`)

- **Status:** Accepted
- **Date:** 2026-10-18
- **Phase:** 01
- **Approved by user:** n.a.

## Context
REQ §17 and ARCHITECTURE A11 list the env variables. REQ §9.1 asks for bounded positive integers. REQ §17 and A10 require production fail-fast and no server secrets in clients. Every later phase adds variables, so the conventions must be fixed now.

## Options considered
| Option | Pros | Cons | License | Cost |
|---|---|---|---|---|
| Zod schema + hand-written checks (chosen) | One typed source of truth; readable issues; Zod already used for DTOs | Some manual cross-field code | MIT | Free |
| envalid / t3-env | Less code | Another dependency; weaker cross-field and group support | MIT | Free |

## Decision
1. **Two entry points.**
   - `@pingdost/config` is server-only: `loadServerConfig(env = process.env)`.
   - `@pingdost/config/public` is client-safe: `loadPublicConfig(env, 'EXPO_PUBLIC_' | 'VITE_')`, `BYTES_PER_MB` and `DEFAULT_LIMITS`.
   - `public.ts` may import only `zod` and `./errors`. An ESLint rule and a unit test enforce this.
   - ESLint also forbids `apps/mobile` and `apps/web` from importing `@pingdost/config`; only `/public` is allowed there.
2. **Blank means unset.** `KEY=` in an `.env` file behaves as if the variable were absent.
3. **Defaults.**
   - Outside production, unset values fall back to dev defaults that match `docker-compose.yml`, including built-in dev-only signing and pepper keys.
   - With `NODE_ENV=production`, there are no URL or secret defaults. Missing required variables fail startup with "is required when NODE_ENV=production", and the dev-only keys are rejected.
4. **Integers.**
   - Values must be whole numbers in decimal digits only (`^\d+$`) and lie within explicit inclusive bounds.
   - Strings like `1e3`, `0x10` or `-1` are rejected.
   - Every `_SECONDS/_MS/_BYTES/_KIB/_DAYS/…` variable is bounded, and a test enforces this generically.
5. **Booleans** accept only `true`, `false`, `1` or `0`. **Lists** are comma-separated and must be non-empty.
6. **Optional feature groups** are all-or-none: object store, SMTP, SMTP auth, Google, Facebook, Cloudinary, FCM, Web Push and TURN.
   - Selecting `ATTACHMENT_STORE=s3`, `EMAIL_PROVIDER=smtp` or `EMAIL_PROVIDER=zeptomail` requires the matching group.
7. **Output shape.**
   - Scalars keep their env names, for example `config.MESSAGE_MAX_RETENTION_SECONDS`.
   - Groups become typed optional objects, for example `config.smtp?.auth`, `config.turn?.urls` and `config.objectStore`.
8. **Cross-field rules:**
   - the four required by Phase 1: stage < retention; poll ≤ grace/3; attachment retention ≤ message retention; mesh hops 1–32;
   - plus quota ≥ max attachment size, access TTL < refresh TTL, and OTP cooldown < OTP TTL;
   - and no `EMAIL_CONSOLE_SHOW_CONTENT=true` in production.
9. **Errors.**
   - `ConfigError.issues` lists `KEY: problem` lines and never includes values, so it is safe to log.
   - REQ §17 names replaced by A11 (`UPSTASH_REDIS_URL`, `UPSTASH_REDIS_TOKEN`, `GOOGLE_CLIENT_ID`) are rejected with a pointer to the replacement.
   - Other unknown variables are ignored.
10. **`EMAIL_PROVIDER`** is one of `smtp` (Mailpit, Brevo or any SMTP), `zeptomail` (API key) or `console` (dev only).
11. **Secrets list.** `SERVER_SECRET_KEYS` lists the secret variable names. Phase 5 uses it to redact config in logs.

## Consequences
- **New variables** go into `server.ts` with bounds and, if secret, into `SERVER_SECRET_KEYS`. They are also added to `.env.example`. A test fails if `.env.example` misses a variable or fills in a real secret.
- **Client-visible limits** belong in `DEFAULT_LIMITS` (public), and the server schema reuses them as defaults.
- **Mobile:** Expo inlines only static `process.env.EXPO_PUBLIC_*` references, so the app passes an object literal to `loadPublicConfig`.

## Evidence
- `packages/config/src/*.test.ts`: 66 tests pass (2026-10-18).
- Zod 4.6.7 API checked on zod.dev on 2026-10-18.
