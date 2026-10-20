# Phase 20 — Deployment (staging) on one Hostinger VPS

**Depends on:** 12, 14 · **Platforms:** infra · Can be pulled earlier if real-network testing is needed.

## Goal
Stand up a public staging environment on the user's single Hostinger KVM VPS (ADR 0013). One Docker Compose stack runs the API, worker, Valkey, Caddy (TLS) and attachment storage. MongoDB Atlas M0, Cloudflare (DNS, Pages), monitoring and backups stay on free tiers. Phones and browsers then work over real networks.

## Read first
- REQ §17, §18, §22, §21 (row "Free tiers change")
- ARCHITECTURE A2, A9, A11
- ADRs: 0010 (Redis budget), **0013 (hosting)**, attachment staging (Phase 14)

## Tasks
- [ ] **Re-verify** (web search; record the dates in ADR 0013):
  - the Hostinger KVM plan the user bought: specs, renewal price, included backups, panel firewall, in-place upgrade;
  - MongoDB Atlas M0: limits, backups, regions;
  - Cloudflare Pages/DNS, ZeptoMail/Brevo, GitHub Actions/GHCR.
  - **Call out every step that needs a credit card before the user does it.**
- [ ] **VPS setup** (numbered manual steps for the user wherever hPanel is needed):
  - Ubuntu LTS, Docker Engine with the Compose plugin;
  - a non-root deploy user; SSH keys only (no password login, no root login);
  - unattended security upgrades; a 2 GB swap file.
  - **Hostinger panel firewall:** allow 22, 80 and 443 only. coturn's ports come in Phase 25. Docker-published ports bypass `ufw`, so only Caddy publishes ports.
  - Use the data center nearest the users; the Atlas cluster uses the same region.
- [ ] **Containers:**
  - multi-stage `apps/server/Dockerfile` (Node 24 slim/distroless, non-root, `linux/amd64`);
  - `deploy/compose.staging.yml`, one stack, with a memory limit on every service:
    - **server:** one instance, `RUN_WORKER_IN_PROCESS=true`, `TRUST_PROXY=true`;
    - **Caddy:** the only service with published ports (80/443); automatic TLS, the WebSocket proxy for `/v1/ws`, security headers, request size limits;
    - **Valkey:**
      - no published port;
      - `appendonly yes`, `appendfsync everysec`, `maxmemory 256mb`, `maxmemory-policy noeviction`;
      - `requirepass` from `.env`, and the same password in `REDIS_URL` (the config refuses a production URL without one);
      - a named volume;
    - a volume for `ATTACHMENT_FS_ROOT` (`ATTACHMENT_STORE=fs`), with disk alerts.
  - Measure each service's RAM, idle and under the sim-client, and record it in ADR 0013 to confirm that KVM 1 is enough.
- [ ] **CI/CD:**
  - A GitHub Actions workflow builds the `amd64` image and pushes it to GHCR on tags, then deploys over SSH (`docker compose pull && up -d`).
  - Secrets go in GitHub Environments and in the server's `.env` (chmod 600). No secrets in the repo.
  - The user pushes tags by hand (push policy in CLAUDE.md).
- [ ] **Databases:**
  - Atlas M0 cluster in the VPS's region: IP allowlist = VPS IP, least-privilege user, TLS.
  - **Backups:**
    - turn on Hostinger's VPS backups;
    - a nightly `mongodump` of Atlas to the VPS, excluding `pending_envelopes`, keeping 7 days;
    - a snapshot before risky changes.
  - **Backup note:** VPS backups can contain the Valkey AOF and staged attachments, both ciphertext; Atlas backups (if M0 has any) can contain `pending_envelopes`. Reflect this in the privacy wording (REQ §18 last bullet).
- [ ] **Web:** Cloudflare Pages project from GitHub (`apps/web` build), with a `_headers` file holding a strict CSP, HSTS, COOP/COEP as needed by WASM, and Permissions-Policy.
- [ ] **DNS** (Cloudflare):
  - `api.` starts DNS-only (grey cloud): the proxy caps uploads at 100 MB.
  - `app.` for the web app; the root landing page is optional.
  - `turn.` arrives in Phase 25.
- [ ] **Mobile:** a staging build profile (app config env → staging URLs). Create the release keystore (**the user stores it safely; never commit it**) and build a release APK locally for testers.
- [ ] **Email:** configure the chosen provider (SPF/DKIM DNS records via Cloudflare). Send a test OTP.
- [ ] **Monitoring (free):**
  - uptime checks (UptimeRobot or healthchecks.io) on `/readyz`, and a worker heartbeat ping;
  - `/metrics` scraped by Grafana Cloud free **or** a small cron script on the VPS that alerts by email or Telegram on thresholds:
    - mailbox backlog, oldest item age, overdue;
    - disk use, VPS RAM, Valkey memory against `maxmemory`;
    - attachment bytes;
  - usage alerts the user configures (Atlas, Cloudflare, Hostinger monthly transfer), with steps given;
  - log retention of 7 days with redaction verified.
- [ ] **Runbooks:**
  - `docs/ops/deploy.md`: deploy, rollback, rotate secrets, and **rebuild on a new VPS** (new VPS, `.env`, `compose up`, DNS);
  - `docs/ops/alerts.md`: what each alert means and what to do.

## Key files
`apps/server/Dockerfile`, `deploy/compose.staging.yml`, `deploy/Caddyfile`, `.github/workflows/deploy.yml`, `apps/web/public/_headers`, `docs/ops/*`

## Out of scope
coturn (25); production launch (27, on the same VPS).

## Done when
- Two phones on **mobile data** register, chat, and send an attachment through staging.
- The web at the staging URL pairs and chats.
- Uptime and metrics alerts fire in a test (e.g. stop the worker → heartbeat alert).
- From outside, only ports 22, 80 and 443 answer; Valkey and the server port are unreachable directly.
- ADR 0013 records the verified plan, limits and measured RAM, and the user confirms it.

## Handoff notes
**From Phase 5 (ADR 0007):**
- Behind Caddy/nginx set `TRUST_PROXY=true`, or every client shares the proxy's IP for rate limits.
- Rate limits and login lockouts are in memory per instance: run one API instance, or move them to a shared store.
- With ZeptoMail, set `ZEPTOMAIL_API_URL` to the host shown in the account's mail agent setup (regional).

**From Phase 8 (ADR 0010):**
- The Redis provider is self-hosted Valkey on the VPS (decided by ADR 0013).
- The connection registry is in memory, so run a single API instance.
- The reverse proxy must pass WebSocket upgrades on `/v1/ws`. Set `TRUST_PROXY`.
- Set `METRICS_TOKEN` and scrape `/metrics`.
- Alert on `pingdost_mailbox_due_overdue > 0`, the migration failure rate and Valkey memory.
- A separate worker process has no metrics endpoint yet: run the jobs in process (`RUN_WORKER_IN_PROCESS=true`), or add one.

**From the 2026-10-19 hosting change (ADR 0013):**
- `loadServerConfig` refuses a production `REDIS_URL` without a password.
- The dev `docker-compose.yml` Valkey already runs AOF + `noeviction`; staging adds `maxmemory` and `requirepass`.

**From Phases 12–13 (ADR 0015, 0016):**
- Push: set `FCM_PROJECT_ID` + `FCM_SERVICE_ACCOUNT_JSON_BASE64` (and later the `WEB_PUSH_*` VAPID trio) on the VPS; `PUSH_WAKE_THROTTLE_SECONDS` defaults to 10. Watch `pingdost_push_wakes_total{result="failed"|"invalid_token"}`.
- The Android release build needs `apps/mobile/google-services.json` at build time (`app.config.js` adds it only when present).
- Groups: `GROUP_MAX_MEMBERS` (64). Group messages cost one envelope per member device in the mailbox budget.

**From Phase 14 (ADR 0017):**
- Attachments stage on the VPS disk: `ATTACHMENT_STORE=fs`, `ATTACHMENT_FS_ROOT` on a named Docker volume. Size its headroom against `ATTACHMENT_TOTAL_QUOTA_BYTES` (30 GiB default on KVM 1's 50 GB). `PUBLIC_API_URL` must be the public HTTPS origin: signed part and download URLs carry it.
- Caddy:
  - allow request bodies of at least one part (16 × 65,552 B ≈ 1 MiB, plus headers) on `PUT /v1/attachments/*/parts/*`;
  - do not buffer `GET …/blob` responses (range and streaming);
  - keep `TRUST_PROXY=true` for the per-IP limits.
- Jobs: `attachment-janitor` runs every `ATTACHMENT_JANITOR_INTERVAL_SECONDS` (300). Alert on `pingdost_attachment_deletion_failures_total` increasing, `pingdost_attachments_oldest_age_seconds` above `ATTACHMENT_MAX_RETENTION_SECONDS`, and staged bytes near the total cap.
- R2 (`ATTACHMENT_STORE=s3`, `ATTACHMENT_OBJECT_STORE_REGION=auto`) needs a card even on the free tier: only with the user's go-ahead.
