# Deploying and operating staging

The stack lives in `/srv/pingdost` on the VPS: `compose.staging.yml`, `Caddyfile`, `.env` (chmod 600, only on the VPS), `scripts/`, `backups/`. All commands below run as `deploy` in that folder; `dc` means `docker compose -f compose.staging.yml`.

## Deploy
1. On your PC, after the change is on `main`: `git tag v0.20.1 && git push origin v0.20.1` (the push policy: you push tags by hand).
2. GitHub → Actions → **Deploy staging** builds the image (`linux/amd64`), pushes `:v0.20.1` and `:staging`, copies the stack files, then on the VPS sets `SERVER_TAG`, pulls, `up -d`, reloads Caddy and waits for `/readyz`.
3. A deploy restarts the server for a few seconds: clients reconnect and messages wait in the mailbox.

## Roll back
1. `cd /srv/pingdost && sed -i 's/^SERVER_TAG=.*/SERVER_TAG=v0.20.0/' .env` (the last good tag; `docker image ls ghcr.io/*/pingdost-server` lists what is on the VPS).
2. `dc pull server && dc up -d server`, then `curl -fsS https://api.pingdost.com/readyz`.
3. Protocol and data changes are add-only, so an older server reads newer records; check `docs/CHANGES.md` for anything that says otherwise.

## Logs
- `dc logs --tail 200 server` (also `valkey`, `caddy`). Logs never contain message content, keys, tokens, OTPs or query strings (ADR 0007, A10); Caddy keeps no access log.
- Retention: the `local` log driver keeps 5 × 10 MB per container (about a week at staging volume). Check `docker system df` monthly.
- Redaction check after any logging change: `dc logs server | grep -Ei 'bearer|sig=|otp|password'` must find nothing.

## Rotate secrets
Each needs `dc up -d` afterwards (it re-reads `.env`).
- `METRICS_TOKEN`, `HEARTBEAT_URL`, `MONITOR_PING_URL`: replace freely.
- `ACCESS_TOKEN_SIGNING_KEY`: every access token stops working; apps refresh silently.
- `SERVER_HMAC_PEPPER`: **every refresh token, pending OTP and signed attachment URL stops working**, so every user signs in again. Only after a leak.
- `VALKEY_PASSWORD`: change it in both `VALKEY_PASSWORD` and `REDIS_URL`, then `dc up -d valkey server`.
- Atlas password: Atlas → Database Access → edit user → new password → update `MONGODB_URI`.
- Email token, FCM service account, VAPID keys: replace in `.env`. New VAPID keys also need a web rebuild (`VITE_WEB_PUSH_PUBLIC_KEY`), and browsers turn notifications on again.
- The GitHub deploy key: make a new pair, put the public half in `authorized_keys`, the private half in the `staging` environment secret, then remove the old line.

## Rebuild on a new VPS
Losing the VPS loses only what is still in transit: envelopes in the Valkey stage (up to 14 h) and staged attachments (ADR 0013). Accounts, devices and keys are in Atlas.
1. A new VPS: `docs/ops/vps-setup.md` parts 1–2 (firewall, `vps-setup.sh`).
2. Atlas → Network Access: add the new IP, remove the old one.
3. Copy `.env` from your password manager (or recreate it from `deploy/env.staging.example` with the **same** `SERVER_HMAC_PEPPER` and `ACCESS_TOKEN_SIGNING_KEY`, or users must sign in again).
4. Update the `STAGING_SSH_HOST` variable and `STAGING_SSH_KNOWN_HOSTS` secret, then re-run the last **Deploy staging** workflow (or copy the files and `dc up -d` by hand).
5. Cloudflare DNS: point `api` at the new IP. Caddy fetches a new certificate on the first request.
6. Restore Mongo only if Atlas itself lost data: `docker run --rm -i -e URI="$(grep ^MONGODB_URI= .env | cut -d= -f2-)" -v /srv/pingdost/backups:/b mongo:8.0.34 sh -c 'mongorestore --uri="$URI" --gzip --archive=/b/mongo-YYYY-MM-DD.archive.gz'`.

## Backups and the privacy wording (REQ §18)
- **Nightly Mongo dump** (`scripts/mongo-backup.sh`, 03:30 UTC, 7 days in `/srv/pingdost/backups`): account metadata and public keys only. It leaves out `pending_envelopes`, `primary_transfer_requests`, `pairing_requests` and `device_challenges`, so no undelivered message ciphertext is kept for 7 days.
- **Hostinger VPS backups** copy the whole disk, so they can hold the Valkey AOF (envelopes still in the hot stage) and staged attachments: **ciphertext only, for as long as Hostinger keeps the backup**. **Atlas snapshots** (if enabled) can hold `pending_envelopes` for up to 4 days. All of it is end-to-end encrypted and expires there, which is why the wording stays "no permanent server-side chat history", never "nothing touches our servers".
- Take a snapshot in hPanel before risky changes (migrations, OS upgrades).
