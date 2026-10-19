# 0007 — Auth sessions, OTPs and abuse throttles

- **Status:** Accepted
- **Date:** 2026-10-19
- **Phase:** 05
- **Approved by user:** n.a.

## Context
REQ §6.1 asks for email + password registration with OTP verification (short expiry, one-time use, attempt limits, resend cooldown, rate limits), login, and throttling of every auth step. ARCHITECTURE A2 fixes the tools (Argon2id, HS256 JWTs, HMAC-hashed rotating refresh tokens with family revocation, in-memory rate limits on one instance). Phase 5 had to fix the remaining behaviour.

## Options considered
| Question | Option | Pros | Cons |
|---|---|---|---|
| Refresh-token family | **One `sessions` document per sign-in: current hash + recent rotated-out hashes** | One lookup; reuse detection and revocation on the same document | The remembered list is bounded (50) |
| | A document per token | Unlimited history | More writes and a join to revoke |
| Registering an email that is taken | **`EMAIL_TAKEN` for verified accounts; an unverified registration is replaced** | Simple client flow; a typo'd or squatted email cannot block its owner | Reveals that a verified account uses the address (usernames are public anyway) |
| | Always "check your inbox" | No enumeration | Confusing flow; extra email type |
| Login abuse | **Per-identifier lock after 5 failures for the rest of a 15-minute window, plus per-IP limits** | Stops online guessing; bounded lock | Someone can lock an account for ≤ 15 min |
| | Exponential per-account delay | Gentler | More state; same DoS concern |

## Decision
1. **Accounts.**
   - Usernames: 3–20 characters of `[a-z0-9_.]`, stored lowercase, unique, with a reserved list plus the `pingdost*` prefix (`USERNAME_RESERVED`).
   - Emails are trimmed and lowercased.
   - New accounts are `pending_verification`, with `pendingExpiresAt` = now + `UNVERIFIED_ACCOUNT_TTL_SECONDS` (default 24 h). A TTL index deletes them after that.
   - Registering an address that belongs to an unverified account replaces that account.
2. **Passwords.**
   - 10–128 characters, hashed with Argon2id at the configured parameters. Hashes made with older parameters are upgraded at the next successful login.
   - When there is no account (or no password), login still verifies against a dummy hash, so response time does not reveal which accounts exist.
3. **OTPs** (`email_otps`).
   - One live code per (purpose, email): `verify_email` or `password_reset`. A purpose's code never works for the other.
   - Codes are 6 digits from the CSPRNG, stored as `HMAC(pepper, "otp" ‖ purpose:email:code)`.
   - Lifetime is `EMAIL_OTP_TTL_SECONDS`. Every check counts as an attempt, atomically and before the comparison. After `EMAIL_OTP_MAX_ATTEMPTS` the code is deleted (`OTP_ATTEMPTS_EXCEEDED`). A correct code is deleted on use.
   - Resending replaces the code; the cooldown is `EMAIL_OTP_RESEND_COOLDOWN_SECONDS`.
   - If the email cannot be sent, the code is dropped and the request fails with a retryable `UNAVAILABLE`.
4. **Sessions and tokens.**
   - A sign-in creates a `sessions` document (UUIDv7 `sid`). Access tokens are HS256 JWTs (`sub`, `sid`; `iss` pingdost; `aud` pingdost-api).
   - Every authenticated request checks that its session is still active, so revocation takes effect immediately rather than at token expiry.
   - Refresh tokens are 32 random bytes. Each refresh rotates the token and slides `expiresAt` by `REFRESH_TOKEN_TTL_SECONDS`.
   - Presenting a rotated-out token revokes the whole session (`TOKEN_REUSED`) and records `refresh_reuse`. Clients must therefore never refresh twice in parallel; `@pingdost/api-client` shares one refresh.
   - Logout revokes its own session. A password reset revokes every session. A password change revokes all sessions except the current one.
5. **Enumeration.** Login failures are identical for unknown accounts and wrong passwords. Resend-verification and forgot-password always answer 204, and send nothing for unknown, verified (resend) or unverified (forgot) addresses.
6. **Throttles.**
   - Per IP (`@fastify/rate-limit`, in memory), per route: register 10/h, verify 30/15 min, resend 10/h, login 30/15 min, refresh 60/15 min, logout 60/15 min, forgot 10/h, reset 30/15 min, change 10/15 min, me 300/15 min.
   - Per identifier/email (in-memory `WindowCounter`): login lock after 5 failures per 15 min (`ACCOUNT_LOCKED`, 423); OTP emails 5/h per address; OTP checks 15/h per address and purpose.
   - Every limit answers problem+json with `retryAfterSeconds` and `Retry-After`.
   - `TRUST_PROXY=true` behind a reverse proxy, so limits see the real client IP.
7. **Audit and logs.**
   - `security_events` has a TTL of `SECURITY_EVENT_RETENTION_SECONDS` and stores the type, user ID, `HMAC(pepper, "ip" ‖ ip)` and the first 128 characters of the user agent. Types: register, login_ok, login_fail, otp_fail, refresh_reuse, password_reset, password_change, logout.
   - Logs scrub sensitive field names at any depth: passwords, tokens, secrets, `*Key`, OTP, code, ciphertext, payload, SDP, authorization, cookie, email, to. Request logs carry method, path (no query string) and status only, with no IPs or headers.
8. **Email.**
   - The `console`, `smtp` (nodemailer) and `zeptomail` adapters have timeouts. ZeptoMail is retried up to 3 times on network errors, 429 and 5xx.
   - `ZEPTOMAIL_API_URL` selects the account's regional host (default `https://api.zeptomail.com/v1.1/email`).

## Consequences
- New env: `LOG_LEVEL`, `TRUST_PROXY`, `ZEPTOMAIL_API_URL` and `UNVERIFIED_ACCOUNT_TTL_SECONDS` (ARCHITECTURE A11). New error codes: `OTP_ATTEMPTS_EXCEEDED`, `ACCOUNT_DISABLED`.
- In-memory limits reset on restart and are per instance. A second API instance would need a shared store (Phase 20 decides).
- Phase 6 binds sessions to devices (`deviceId`, the `did` claim). Phase 16 adds CORS for `WEB_ORIGIN`.

## Evidence
- `pnpm --filter @pingdost/server test:int`: 35 tests (register/OTP, sessions, passwords, platform, scheduler) against Mongo 8.0, Valkey and Mailpit.
- ZeptoMail API checked on 2026-10-19 (zoho.com/zeptomail/help/api/email-sending.html). The documented host varies by region, hence the URL setting.
