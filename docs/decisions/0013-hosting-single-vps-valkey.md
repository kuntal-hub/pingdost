# 0013 — Hosting: one Hostinger KVM VPS, self-hosted Valkey, no Upstash

- **Status:** Accepted (Phase 20 implements it and records the verified plan and measurements)
- **Date:** 2026-10-19
- **Phase:** change (before 20)
- **Approved by user:** yes (2026-10-19: one Hostinger KVM 1 or 2 VPS, no other paid service; drop Upstash)

## Context
REQ §2, §4, §17 and §22 name Upstash Redis for the hot mailbox. ARCHITECTURE A9 left the host to Phase 20, with Oracle Always Free ARM as the main candidate. ADR 0010 measured about 7,400 Redis commands per active user per month plus 44K a month idle, so Upstash's free tier (500K commands a month) fits only about 50–60 active users before it needs a card.

The user has one paid VPS, Hostinger KVM 1 or KVM 2, and will not buy any other service. Everything else must stay on free tiers (A9, CLAUDE.md budget rule).

## Options considered
| Option | Pros | Cons | License | Cost |
|---|---|---|---|---|
| **Valkey on the VPS** | No command quota; sub-millisecond latency next to the API; already the dev, CI and integration-test path | We run it: persistence, auth, memory; losing the VPS loses envelopes still in the Redis stage | BSD-3-Clause | $0 (VPS RAM) |
| Upstash free | Managed; survives the VPS | 500K commands/month ≈ 50–60 users; a card beyond that; a second provider | Service | $0, then ≈ $1.6–15/month |
| **Mongo on Atlas M0** | Free; accounts, devices and keys survive the loss of the VPS; no Mongo RAM on the VPS | 512 MB; shared tier; network hop (same region keeps it small) | Service | $0 |
| Mongo on the VPS | Self-contained; no 512 MB cap | About 1 GB more RAM (needs KVM 2); off-box backups become our job | SSPL server (already used in dev) | $0 |

## Decision
1. **Host:** one Hostinger KVM VPS, `x86_64`. The user picks and buys the plan, and should compare renewal prices, not only the first-term price.
   - **KVM 1** (1 vCPU, 4 GB RAM, 50 GB NVMe, 4 TB transfer) is enough while Mongo stays on Atlas.
   - **KVM 2** (2 vCPU, 8 GB, 100 GB, 8 TB) if Mongo moves onto the VPS, or when load or relayed calls need it. Upgrade the plan in place from hPanel.
   - Use the data center nearest the users; the Atlas cluster uses the same region.
2. **Redis is self-hosted Valkey only. Upstash is not used.**
   - Settings: `appendonly yes`, `appendfsync everysec`, `maxmemory 256mb`, `maxmemory-policy noeviction`, `requirepass`.
   - No published port: only the internal Compose network reaches it. Data lives in a named volume.
   - `REDIS_URL` carries the password (`redis://:<password>@valkey:6379`). `loadServerConfig` refuses a passwordless `REDIS_URL` in production.
3. **One Docker Compose stack on the VPS:**
   - **Caddy:** the only service that publishes ports (80/443); automatic Let's Encrypt TLS and the WebSocket proxy.
   - **server:** API, gateway and jobs in one process (`RUN_WORKER_IN_PROCESS=true`), exactly one instance (in-memory presence, rate limits and connection registry).
   - **Valkey**, as above.
   - **Attachment staging:** `ATTACHMENT_STORE=fs` on a volume.
   - **coturn** from Phase 25.
   - Every service gets a memory limit. The VPS gets a 2 GB swap file.
4. **Off the VPS, free tiers only:** MongoDB Atlas M0, Cloudflare DNS and Pages (the web app), GitHub Actions and GHCR, ZeptoMail or Brevo, FCM and Web Push, UptimeRobot or healthchecks.io.
   - `api.` and `turn.` start as DNS-only records: Cloudflare's proxy caps uploads at 100 MB and does not carry TURN's UDP.
5. **Deploys:** CI builds a `linux/amd64` image only and pushes it to GHCR. The VPS only pulls (`docker compose pull && docker compose up -d`). A few seconds of downtime per deploy is accepted: clients reconnect, and messages wait in the mailbox.
6. **Network hardening:**
   - Hostinger's panel firewall allows only 22 (SSH keys only), 80 and 443, plus coturn's ports from Phase 25. Docker-published ports bypass `ufw`, so the panel firewall is the one that counts.
   - Unattended security upgrades; a non-root deploy user.
7. **Backups:**
   - Hostinger VPS backups on, and a snapshot before risky changes.
   - A nightly `mongodump` of Atlas to the VPS, excluding `pending_envelopes`, keeping 7 days.
   - Atlas and the VPS then back each other up.
8. **Staging and production share the VPS.** Phase 27 promotes the staging stack to production. There is no second stack on KVM 1.

## Consequences
- The thing to watch is Valkey memory, VPS RAM, disk and monthly transfer, not a command quota. The command counter and `test/redis-budget.int.test.ts` stay as efficiency guards.
- **Losing the VPS** loses only envelopes still in the Redis stage (up to 14 h) and staged attachments. Accounts, devices and keys are in Atlas.
  - Recovery: a new VPS, the `.env`, `compose up`, and a DNS change.
  - This matches "no permanent server-side chat history".
- The old REQ names `UPSTASH_REDIS_URL` and `UPSTASH_REDIS_TOKEN` stay rejected by `@pingdost/config`.
- **Code changed with this ADR:**
  - the config requires a password in a production `REDIS_URL`;
  - the dev `docker-compose.yml` sets `noeviction` explicitly;
  - comments no longer mention Upstash.
- **Docs updated:** ARCHITECTURE A2, A9 and A11; ADR 0010's status; `docs/CHANGES.md`; phase files 14 (`fs` is the production store), 20 (rewritten around this ADR), 25 (coturn on the same VPS) and 27 (production on the same VPS; load test against VPS limits).

## Evidence
- ADR 0010's measured command budget.
- Hostinger plan specs checked 2026-10-19 (hostinger.com/vps-hosting, vpsbenchmarks.com KVM 1 and KVM 2 pages): KVM 1 = 1 vCPU / 4 GB / 50 GB NVMe / 4 TB; KVM 2 = 2 vCPU / 8 GB / 100 GB NVMe / 8 TB. Prices differ by term and between sources; Phase 20 re-checks them.
- RAM estimate, **not yet measured** (Phase 20 measures it):

  | Item | RAM |
  |---|---|
  | OS + Docker | ≈ 0.4 GB |
  | server | 0.25–0.4 GB |
  | Valkey | ≤ 0.26 GB |
  | Caddy | ≈ 0.05 GB |
  | coturn | ≈ 0.05 GB |
  | **Total** | **≈ 1–1.3 GB of 4 GB** |
