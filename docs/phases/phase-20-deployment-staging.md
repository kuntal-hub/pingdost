# Phase 20 — Deployment (staging) on free/low-cost infrastructure

**Depends on:** 12, 14 · **Platforms:** infra · Can be pulled earlier if real-network testing is needed.

## Goal
Choose the host and stand up a public staging environment: API + worker + TLS + Mongo Atlas + Redis/Valkey + attachment storage + web hosting + monitoring and cost alerts. Phones and browsers then work over real networks.

## Read first
- REQ §17, §18, §22, §21 (rows "Free tiers change", "Free Redis tier")
- ARCHITECTURE A2, A9, A11
- ADRs: Redis budget (Phase 8), attachment staging (Phase 14)

## Tasks
- [ ] **Re-verify the free tiers** (web search, record dates): Oracle Cloud Always Free (ARM shape limits, idle reclamation policy, egress), MongoDB Atlas M0, Upstash, Cloudflare Pages/Tunnel, ZeptoMail/Brevo, GitHub Actions/GHCR.
- [ ] **Ask the user to choose the host** (AskUserQuestion: Oracle Always Free / a cheap paid VPS / another). Write the hosting ADR with the topology. **Call out every step that needs a credit card before the user does it.**
- [ ] **Containers:**
  - multi-stage `apps/server/Dockerfile` (Node 24 slim/distroless, non-root, `linux/arm64` + `amd64` via buildx);
  - `deploy/compose.staging.yml` with these services:
    - server (worker in-process or a separate service);
    - **Caddy** (automatic TLS, WS proxy, security headers, request size limits);
    - Valkey (if chosen over Upstash; AOF on, maxmemory policy `noeviction`);
    - a volume for `ATTACHMENT_FS_ROOT`, with disk alerts.
  - coturn arrives in Phase 25, but reserve its ports in the firewall plan.
- [ ] **CI/CD:** a GitHub Actions workflow builds and pushes the image to GHCR on tags, then deploys over SSH (`docker compose pull && up -d`). Secrets go in GitHub Environments and in the server's `.env` (chmod 600). No secrets in the repo.
- [ ] **Databases:**
  - Atlas M0 cluster: IP allowlist = VPS IP, least-privilege user, TLS.
  - **Backup note:** the M0 backup policy and the fact that temporary `pending_envelopes` ciphertext could appear in provider snapshots. Reflect this in the privacy wording (REQ §18 last bullet).
- [ ] **Web:** Cloudflare Pages project from GitHub (`apps/web` build), with a `_headers` file holding a strict CSP, HSTS, COOP/COEP as needed by WASM, and Permissions-Policy.
- [ ] **DNS** (Cloudflare): `api.` (and `ws.` if separate), `app.` (web), and the root landing page (optional).
- [ ] **Mobile:** a staging build profile (app config env → staging URLs). Create the release keystore (**the user stores it safely; never commit it**) and build a release APK locally for testers.
- [ ] **Email:** configure the chosen provider (SPF/DKIM DNS records via Cloudflare). Send a test OTP.
- [ ] **Monitoring (free):**
  - uptime checks (UptimeRobot or healthchecks.io) on `/readyz`, and a worker heartbeat ping;
  - `/metrics` scraped by Grafana Cloud free **or** a small cron script that alerts by email/Telegram on thresholds (mailbox backlog, oldest item age, disk usage, Redis command usage vs quota, attachment bytes);
  - provider usage and cost alerts (Atlas, Upstash, Cloudflare) configured by the user (steps given);
  - log retention of 7 days with redaction verified.
- [ ] **Runbooks:** `docs/ops/deploy.md` (deploy, rollback, rotate secrets) and `docs/ops/alerts.md` (what each alert means and what to do).

## Key files
`apps/server/Dockerfile`, `deploy/compose.staging.yml`, `deploy/Caddyfile`, `.github/workflows/deploy.yml`, `apps/web/public/_headers`, `docs/ops/*`

## Out of scope
coturn (25); production launch (27).

## Done when
- Two phones on **mobile data** register, chat, and send an attachment through staging.
- The web at the staging URL pairs and chats.
- Uptime and metrics alerts fire in a test (e.g. stop the worker → heartbeat alert).
- The hosting ADR is accepted by the user.

## Handoff notes
**From Phase 5 (ADR 0007):**
- Behind Caddy/nginx set `TRUST_PROXY=true`, or every client shares the proxy's IP for rate limits.
- Rate limits and login lockouts are in memory per instance: run one API instance, or move them to a shared store.
- With ZeptoMail, set `ZEPTOMAIL_API_URL` to the host shown in the account's mail agent setup (regional).
**From Phase 8 (ADR 0010):**
- The Redis provider: the recommendation is self-hosted Valkey on the API's VM with `appendonly yes` / `appendfsync everysec`. Upstash free fits about 50 active users; above that, pay-as-you-go (needs the user's approval).
- The connection registry is in memory, so run a single API instance.
- The reverse proxy must pass WebSocket upgrades on `/v1/ws`. Set `TRUST_PROXY`.
- Set `METRICS_TOKEN` and scrape `/metrics`.
- Alert on `pingdost_mailbox_due_overdue > 0`, the migration failure rate and Redis commands per month.
- A separate worker process has no metrics endpoint yet: run the jobs in process (`RUN_WORKER_IN_PROCESS=true`), or add one.
