# Staging setup (one time)

PingDost staging runs on **one Hostinger KVM VPS** (ADR 0013); everything else stays on free tiers. Do the parts in order. Names used below: API `api.pingdost.com`, web `app.pingdost.com`; replace them if your domain differs.

> **Money:** only the VPS is paid (your choice, ADR 0013). None of the other steps should ask for a card. **If any signup below asks for a card, stop there and decide first:** that is not expected for these free tiers.

## 1. The VPS (Hostinger hPanel) — paid
1. Buy **KVM 1** (1 vCPU, 4 GB, 50 GB) or **KVM 2**. Compare the **renewal** price at checkout, not only the first term (third-party reviews, 2026-10: KVM 1 $6.49 → $11.99/month, KVM 2 $8.99 → $14.99). Choose the data center nearest your users.
2. OS: **Ubuntu 24.04 LTS** (plain, no panel). Set a long root password; you will switch to SSH keys next.
3. hPanel → VPS → **Backups**: check what your plan includes (weekly backups and a snapshot are commonly listed; we could not confirm it on Hostinger's own pages) and turn automatic backups on.
4. hPanel → VPS → **Security → Firewall**: create a group, add **accept** rules for TCP **22**, **80**, **443** and UDP **443** (HTTP/3), activate it on the VPS. Hostinger's firewall drops everything else by default. (Docker's published ports bypass `ufw`, so this panel firewall is the one that counts.)
5. Same group, for calls (coturn, ADR 0028): accept UDP **3478**, TCP **3478** and UDP **49160–49400** (the relay range). Add TCP **5349** only if you set up "TURN over TLS" below.

## 2. First login and hardening
1. On your PC (PowerShell), make a key if you have none: `ssh-keygen -t ed25519 -C pingdost-staging`. Show the public key: `Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub`.
2. Copy the setup script to the VPS and run it with your public key:
   ```powershell
   scp deploy/scripts/vps-setup.sh root@<vps-ip>:/root/
   ssh root@<vps-ip> "bash /root/vps-setup.sh 'ssh-ed25519 AAAA… pingdost-staging'"
   ```
   It creates the `deploy` user (SSH key only), turns off password and root logins, enables unattended security upgrades, adds a 2 GB swap file, installs Docker with the Compose plugin, creates `/srv/pingdost`, and installs the cron jobs (monitor every 5 minutes, Mongo backup at 03:30 UTC).
3. **In a second terminal**, before closing the root session: `ssh deploy@<vps-ip>` must work. Then `docker run --rm hello-world`.

## 3. MongoDB Atlas (free)
1. cloud.mongodb.com → new project `pingdost` → **Create cluster → Free** (0.5 GB, 500 connections, 100 ops/s, 10 GB in and 10 GB out per 7 days). Provider and **region nearest the VPS**.
2. **Database Access**: user `pingdost-api`, a generated password, role **readWrite on database `pingdost`** only (Custom role / "Specific privileges").
3. **Network Access**: add the **VPS's IPv4 address** only (no `0.0.0.0/0`).
4. **Connect → Drivers**: copy the `mongodb+srv://…` string, put the password in, add the database: `…mongodb.net/pingdost?retryWrites=true&w=majority`. TLS is on by default for `+srv`.
5. Optional: Atlas → cluster → **Backup** (Free clusters can keep 4 daily snapshots). The VPS also keeps 7 nightly dumps (step 7).
6. Note: Atlas pauses a Free cluster after 30 days with no connections; staging keeps it busy.

## 4. Cloudflare (free): DNS and the web app
1. If the domain is not on Cloudflare yet: Add a site → Free plan → change the nameservers at your registrar to the two Cloudflare shows.
2. **DNS → Add record**: `A api <vps-ipv4>`, **Proxy status: DNS only (grey cloud)** (the proxy would cap uploads at 100 MB). Add `AAAA api <vps-ipv6>` too if the VPS has IPv6.
   - For calls: `A turn <vps-ipv4>`, also **DNS only** (Cloudflare's proxy carries no UDP, and TURN must reach the VPS itself).
3. **Workers & Pages → Create → Pages → Connect to Git** → the `pingdost` repo:
   - Build command: `pnpm install --frozen-lockfile && pnpm --filter @pingdost/web build`
   - Build output directory: `apps/web/dist`
   - Environment variables (Production): `VITE_API_URL=https://api.pingdost.com`, `VITE_WS_URL=wss://api.pingdost.com/v1/ws`, `NODE_VERSION=24`, plus `VITE_WEB_PUSH_PUBLIC_KEY` if you set up Web Push.
   - The build writes `_headers` (CSP with `frame-ancestors 'none'`, HSTS, no referrer, COOP, Permissions-Policy) from the same values.
4. Pages project → **Custom domains → app.pingdost.com** (Cloudflare adds the DNS record).
5. Free plan limits to know: 500 builds a month, 20,000 files, 25 MiB per file.

## 5. Email (free): OTP codes
Pick one.
- **ZeptoMail:** add the domain, publish the **SPF**, **DKIM** (and the bounce CNAME) records it shows in Cloudflare DNS (DNS only), verify, create a Mail Agent and its **Send Mail token** → `EMAIL_PROVIDER=zeptomail`, `EMAIL_API_KEY`, and `ZEPTOMAIL_API_URL` as the agent shows (regional host). Third-party sources say the first 10,000-email credit is free and expires after 6 months; **buying more credits needs a card**.
- **Brevo:** Senders & domains → add the domain, publish its **DKIM** and **Brevo code** TXT records (and SPF `include:spf.brevo.com`), verify; SMTP & API → SMTP key → `EMAIL_PROVIDER=smtp`, `SMTP_HOST=smtp-relay.brevo.com`, `SMTP_PORT=587`, `SMTP_USER`, `SMTP_PASS`. Free: 300 emails a day.
- Either way add a DMARC record: `TXT _dmarc "v=DMARC1; p=none; rua=mailto:you@example.com"`.

## 6. Monitoring (free)
1. **healthchecks.io** (free: 20 checks). Create two checks and keep their ping URLs (they are secrets):
   - `pingdost jobs`: period 5 min, grace 10 min → `HEARTBEAT_URL` (the server's job loop pings it).
   - `pingdost thresholds`: period 5 min, grace 10 min → `MONITOR_PING_URL` (`scripts/monitor.sh`; problems arrive as a failure with one line each).
   - Integrations → Email: your address.
2. **UptimeRobot** (free: 50 monitors at 5-minute intervals; non-commercial use only — a paid plan or another checker when PingDost becomes commercial): HTTP(s) monitor on `https://api.pingdost.com/readyz`, and one on `https://app.pingdost.com/`.
3. Usage alerts to set by hand:
   - **Atlas**: Project → Alerts → add alerts for "Logical size" above 400 MB and "Connections" above 400.
   - **Cloudflare**: Notifications → add "Pages build failure" (Pages) and, if offered on your plan, usage notifications.
   - **Hostinger**: hPanel → VPS → Overview shows the monthly transfer (4 TB on KVM 1); check it monthly (`scripts/monitor.sh` watches disk and RAM).

## 7. The stack on the VPS
1. As `deploy`: `cd /srv/pingdost`, create `.env` from `deploy/env.staging.example` (copy its text), fill every value, then `chmod 600 .env`. Generate secrets on the VPS: `openssl rand -base64 32` (`ACCESS_TOKEN_SIGNING_KEY`, `SERVER_HMAC_PEPPER`), `openssl rand -hex 24` (`VALKEY_PASSWORD`, also inside `REDIS_URL`; `METRICS_TOKEN`).
2. Copy the stack's files once by hand (later deploys copy them): `scp deploy/compose.staging.yml deploy/Caddyfile deploy@<vps-ip>:/srv/pingdost/` and `scp deploy/scripts/*.sh deploy@<vps-ip>:/srv/pingdost/scripts/`, then `chmod 755 /srv/pingdost/scripts/*.sh`.
3. GitHub (no card): repo → **Settings → Environments → New environment `staging`**:
   - Variables: `STAGING_SSH_HOST` (VPS IP), `STAGING_SSH_USER` (`deploy`), `STAGING_API_DOMAIN` (`api.pingdost.com`).
   - Secrets: `STAGING_SSH_KEY` (a **new** key pair only for deploys: `ssh-keygen -t ed25519 -f pingdost-deploy -N ''`; add `pingdost-deploy.pub` to `/home/deploy/.ssh/authorized_keys`; paste the private key) and `STAGING_SSH_KNOWN_HOSTS` (the output of `ssh-keyscan -t ed25519 <vps-ip>`).
4. First image: push a tag from your PC: `git tag v0.20.0 && git push origin v0.20.0`. The **Deploy staging** workflow builds `ghcr.io/<owner>/pingdost-server`, copies the stack files, pulls and starts it, and waits for `/readyz`.
5. GHCR: GitHub → your profile → **Packages → pingdost-server → Package settings → Change visibility → Public** (public images are free and need no login on the VPS). Or keep it private and on the VPS run `docker login ghcr.io -u <user>` with a token that has only `read:packages`.
6. Check: `https://api.pingdost.com/readyz` answers `{"status":"ok",…}`; `ssh deploy@<vps-ip> /srv/pingdost/scripts/monitor.sh` prints nothing alarming (or pings healthchecks); from outside, only 22, 80 and 443 answer (`Test-NetConnection api.pingdost.com -Port 6379` and `-Port 3000` must fail).

### Calls (coturn, ADR 0028)
1. In `.env`: `TURN_SHARED_SECRET` (`openssl rand -hex 32`), `TURN_REALM=turn.pingdost.com`, `TURN_EXTERNAL_IP` (the VPS's public IPv4, hPanel → VPS → Overview), and `STUN_URLS`/`TURN_URLS` as in `deploy/env.staging.example`. The next deploy (or `docker compose -f compose.staging.yml up -d`) starts `coturn` with host networking; `deploy/coturn/turnserver.conf` comes with each deploy.
2. Check from your PC: `Test-NetConnection turn.pingdost.com -Port 3478` succeeds. In PingDost on the web, Settings → Calls → **Force relay (TURN)**, call a contact: the call must connect (with Force relay on, media can only go through coturn) and the call screen says "Relayed (TURN)". Turn it off again.
3. Relayed calls count against the monthly transfer: about 0.2 Mbit/s each way for a voice call, roughly 1–2.5 Mbit/s for 720p video (to be measured on staging; ADR 0028).

### TURN over TLS (optional)
Only for networks that block everything but TLS. coturn needs a certificate for `turn.pingdost.com` it can read (it runs as `nobody`; Caddy's own copies are root-only):
1. Add a site block `turn.pingdost.com { respond 404 }` to the Caddyfile so Caddy obtains the certificate, and deploy.
2. Copy it for coturn after each renewal (e.g. a weekly cron job as root): `install -o nobody -m 0400 <caddy-data>/caddy/certificates/acme-v02.api.letsencrypt.org-directory/turn.pingdost.com/turn.pingdost.com.{crt,key} /srv/pingdost/coturn/tls/` (`docker volume inspect pingdost_caddy-data` shows `<caddy-data>`), then `docker compose -f compose.staging.yml restart coturn`.
3. Mount `/srv/pingdost/coturn/tls` read-only at `/etc/coturn/tls` in `compose.staging.yml`, uncomment the TLS lines in `turnserver.conf` and delete `no-tls`, open TCP 5349, and add `turns:turn.pingdost.com:5349?transport=tcp` to `TURN_URLS`.

## 8. The apps
- Web: `https://app.pingdost.com` (Pages builds on every push to `main`).
- Android release build for testers: `docs/ops/mobile-release.md`.
