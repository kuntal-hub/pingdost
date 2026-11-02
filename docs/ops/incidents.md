# Incident runbooks (Phase 27)

All commands run as `deploy` in `/srv/pingdost` on the VPS; `dc` = `docker compose -f compose.staging.yml`. Alerts and their first checks: [alerts.md](alerts.md). Capacity and thresholds: [capacity.md](capacity.md).

**Rules during any incident**
- Never paste message data, tokens, keys, OTPs or full logs into chats or issues; the logs are already redacted, but copy only the lines you need.
- Undelivered messages are safe in senders' outboxes as long as the server answers errors instead of `Accepted`: prefer refusing writes over accepting and losing them.
- Write a short note afterwards (what, when, impact, fix) in an issue or the PROGRESS log.

## Valkey (Redis) full or down
Symptoms: `mailbox: redis store failed, writing to mongo` warnings; `pingdost_envelopes_accepted_total{path="mongo"}` rising; `/readyz` may still be ok (Valkey is not a readiness dependency).
1. `dc ps valkey` and `dc logs --tail 100 valkey`. `OOM command not allowed` = full (256 MB, `noeviction`, by design: nothing is evicted).
2. Full: is the migration running? `dc logs --tail 200 server | grep -E 'migrat|overdue'`. A healthy drain logs `migrated a backlog`. If it fails, see "Mongo down" (envelopes cannot leave Valkey).
3. Down: `dc up -d valkey`. The AOF reloads staged envelopes. Sends fell back to Mongo meanwhile; nothing is lost unless both were down (then senders retried).
4. If the stage keeps filling (abuse): see "Mailbox filling up".
5. Last resort for space: raise `--maxmemory` in `compose.staging.yml` within the VPS's free RAM, `dc up -d valkey`.

## Mongo (Atlas) full, throttled or down
Symptoms: `/readyz` not ok; `mailbox: migration write failed`; `pingdost_mailbox_due_overdue` > 0; Atlas emails.
1. Atlas UI → cluster → Metrics: connections, operations per second (Free: 100), data size (Free: 512 MB).
2. **Down / unreachable**: check Atlas status and Network Access (the VPS IP must be listed). The server keeps Redis copies while Mongo is down (`mailbox.int` scenario 3); the Redis safety TTL is one grace period (15 min) past the due time, so a Mongo outage longer than that **loses envelopes that came due during it**. If the outage will be long, raise `MESSAGE_MIGRATION_GRACE_SECONDS` (≤ 1 day) in `.env` and `dc up -d server` before the grace runs out: new envelopes get the longer safety TTL.
3. **Throttled** (ops near 100/s): the mailbox slows, nothing is lost (senders retry). Find the source: `pingdost_envelopes_accepted_total` by path, login spikes (`security_events`), a client stuck reconnecting. Block the abuser (see below). Long term: capacity.md §3 (ask the user before paying for a tier).
4. **Full** (512 MB): writes fail. Sizes: `db.getCollectionNames().map(c => [c, db.getCollection(c).stats().size])` in `mongosh`.
   - `pending_envelopes` large: "Mailbox filling up".
   - `one_time_keys` large (≈ 18 KB per device): delete keys of devices revoked or unseen for months (`db.one_time_keys.deleteMany({deviceId: {$in: [...]}})` for revoked devices only).
   - `security_events`: lower `SECURITY_EVENT_RETENTION_SECONDS` (minimum 1 day) and update the privacy policy's number.
   - Then plan a move (Atlas paid tier needs a card: ask the user; or Mongo on the VPS with KVM 2).

## Mailbox filling up (never-delivered queues, abuse)
1. Who: `db.pending_envelopes.aggregate([{$group: {_id: "$senderDeviceId", n: {$sum: 1}, bytes: {$sum: {$binarySize: "$packet"}}}}, {$sort: {bytes: -1}}, {$limit: 10}])`; Redis side: `pingdost_send_rejected_total{code="RATE_LIMITED"}` bursts mean senders hit their daily budget (ADR 0030).
2. Map device → user: `db.devices.findOne({_id: "<deviceId>"}, {userId: 1})`.
3. Stop it: disable the account (`db.users.updateOne({_id: "<userId>"}, {$set: {status: "disabled"}})`: logins answer `ACCOUNT_DISABLED`), end its sessions (`db.sessions.deleteMany({userId: "<userId>"})`), and `dc restart server` so open sockets and the in-memory caches drop it. Access tokens already issued die within `ACCESS_TOKEN_TTL_SECONDS` (15 min).
4. Remove its queued envelopes: `db.pending_envelopes.deleteMany({senderDeviceId: "<deviceId>"})`. Redis copies expire with their stage; to drop them now, restart nothing and let migration move them, then delete in Mongo again.
5. Tighten `storedPerRecipientDevice` / `storedBytesPerSender` in `src/infra/throttles.ts` if the default budget was the problem (a code change and deploy).

## Disk full
Symptoms: `monitor.sh` disk alert; Valkey AOF write errors; attachment uploads failing.
1. `df -h /`, `docker system df`, `du -sh /srv/pingdost/backups`, `docker volume ls`.
2. Old images: `docker image prune -a --filter "until=168h"` (keeps the running ones).
3. Logs: container logs rotate (`json-file` limits in the compose file); `journalctl --vacuum-time=7d`.
4. Staged attachments: `pingdost_attachments_staged_bytes`. The janitor deletes expired/orphaned ones every 5 minutes; check it runs (`dc logs server | grep janitor`). Lower `ATTACHMENT_TOTAL_QUOTA_BYTES` so uploads are refused before the disk fills.
5. Valkey AOF large: `dc exec valkey valkey-cli BGREWRITEAOF`.
6. Then run the [retention audit](retention-audit.md).

## Provider limit hit
| Provider | Limit | What happens | Do |
|---|---|---|---|
| Atlas Free | 100 ops/s, 512 MB, 500 connections | throttling / write errors | above |
| ZeptoMail / Brevo | monthly or daily quota | OTP emails fail (`email` errors in logs) | switch `EMAIL_PROVIDER`/SMTP to the other free provider; tell users to retry later |
| FCM | per-project quotas (generous) | wakes delayed | nothing; messages wait in the mailbox |
| Cloudflare Pages | 500 builds/month | deploys fail | deploy less often |
| Hostinger transfer | plan's monthly TB | throttled network | check relayed call volume (coturn `total-quota`/`bps-capacity` in `turnserver.conf`) and attachments |
| healthchecks.io / UptimeRobot | check counts | alerts stop | keep the check list small |

## Key or secret compromise
1. Contain: rotate the leaked secret (deploy.md → "Rotate secrets"). `SERVER_HMAC_PEPPER` or `ACCESS_TOKEN_SIGNING_KEY` leaked → rotate both; every user signs in again (refresh tokens become invalid).
2. VPS compromised: assume every `.env` value and the Valkey/attachment data (ciphertext) are known. Rotate everything, rebuild the VPS from scratch (deploy.md → "Rebuild"), revoke the GitHub deploy key and GHCR tokens, check the GitHub audit log.
3. **Message content stays safe** under a server compromise (E2EE), but the attacker may try to add devices or serve fake keys: tell users to check safety numbers with their contacts and to review linked devices (Settings → Linked devices). An attacker with server access sees metadata (threat model §5) for as long as they had it.
4. Upload key leaked: Play upload key reset (deploy.md). App signing key is held by Google.
5. A client-side crypto bug (vodozemac advisory): follow the upstream advisory, ship an update, force-update if needed (minimum version check is a future feature: note it).
6. Disclose: users affected → a short honest notice (what leaked, what did not, what to do). Security reports come in via SECURITY.md.

## TURN abuse
Symptoms: transfer spike in hPanel, coturn CPU high, `pingdost_call_pushes_total` normal (abuse does not ring anyone).
1. `dc logs --tail 200 coturn` (problem lines name the TURN username = `<expiry>:<user ID>`).
2. Credentials are short-lived HMACs (`TURN_CREDENTIAL_TTL_SECONDS`): a leaked pair works only until it expires. Repeated abuse from one user ID: revoke that account's devices (above) so it cannot fetch new credentials.
3. Broad abuse: rotate `TURN_SHARED_SECRET` (deploy.md), lower `bps-capacity`/`user-quota` in `deploy/coturn/turnserver.conf`, deploy.
4. coturn already refuses private ranges (SSRF) and needs credentials; never switch on `no-auth`.

## Restoring the metadata DB
See [restore-metadata-db.md](restore-metadata-db.md).
