# Alerts and what to do

Three sources, all free: **healthchecks.io** (two checks), **UptimeRobot** (outside-in HTTP), and the providers' own usage alerts. `dc` = `docker compose -f compose.staging.yml` in `/srv/pingdost`.

## healthchecks.io: `pingdost jobs` is late
The server's job loop pings `HEARTBEAT_URL` every 5 minutes after taking its Mongo lease, so silence means the server is down, its jobs stopped, or Mongo is unreachable.
1. `dc ps` and `dc logs --tail 100 server`.
2. `curl -fsS https://api.pingdost.com/readyz`: `mongo: fail` means Atlas (status page, Network Access IP list, the paused-cluster banner); a stopped container means `dc up -d`.
3. Test it on purpose: `dc stop server` → the alert arrives within about 15 minutes → `dc start server` → it clears.

## healthchecks.io: `pingdost thresholds` failed (one line per problem)
`scripts/monitor.sh` runs every 5 minutes. A late check (no ping at all) means the VPS, cron or Docker is down.

| Line | Meaning | Do |
|---|---|---|
| `metrics: the server did not answer /metrics` | Server down, or `METRICS_TOKEN` differs between `.env` and the running container | `dc ps`; `dc up -d server` |
| `mailbox: N envelopes overdue …` | The migration or expiry job is behind (`pingdost_mailbox_due_overdue`) | Server logs (`component: mailbox`); check Mongo and Valkey |
| `mailbox: an envelope has been in Valkey for …s` | Migration to Mongo is not running | As above; `readyz` |
| `mailbox: an envelope is older than the retention` | The reaper is not deleting expired envelopes | Server logs; REQ §9 promises deletion at expiry |
| `attachments: a staged file is older than the retention` | The attachment janitor is failing | Logs (`attachment-janitor`); disk permissions on the `attachments` volume |
| `attachments: staging is over 80% of its cap` | Many large uploads waiting for recipients (abuse?) | `ATTACHMENT_TOTAL_QUOTA_BYTES`; per-user quota; disk space |
| `pingdost_…_failures_total rose …` | Deletions or migrations failed since the last run | Logs; they retry, but repeated rises need a look |
| `valkey: X of Y bytes used` | Valkey above 80% of `maxmemory` (256 MB). Full Valkey refuses writes and new envelopes go to Mongo | `dc exec valkey valkey-cli info memory`; consider a shorter `MESSAGE_REDIS_STAGE_SECONDS` or more `maxmemory` (and the server's memory limit) |
| `valkey: no answer` | Valkey down | `dc up -d valkey`; the AOF replays on start |
| `disk: N% used` | Above 85% | `docker system prune -f`; `du -sh /srv/pingdost/backups`; staged attachments |
| `ram: only N MB available` | Below 300 MB | `docker stats --no-stream`; `free -m`; KVM 2 upgrade in hPanel if it persists |
| `container X is not running` | A service stopped | `dc up -d`; `dc logs X` |

## UptimeRobot: `api …/readyz` or `app …` down
1. From your PC: `curl -I https://api.pingdost.com/readyz`. A TLS error after a VPS move means DNS; a timeout means the VPS or its firewall.
2. hPanel → VPS: running? CPU or network graphs flat?
3. `app.` down: Cloudflare status page; Pages → Deployments (a failed build keeps the last good one live).

## Provider usage alerts
- **Atlas** logical size above 400 MB (of 0.5 GB): check `security_events` and `one_time_keys` sizes; the Free tier cannot grow, so plan a move (Atlas Flex needs a card: ask first) or Mongo on the VPS (KVM 2).
- **Atlas** connections above 400 (of 500): one server instance uses a small pool; many connections mean leaked clients or another app on the cluster.
- **Atlas** operations above 60 per second for 10 minutes (Free allows 100; Phase 27): the mailbox or logins are near the throttle. Check `pingdost_envelopes_accepted_total{path="redis"}` and the migration logs (`migrated a backlog`). Thresholds and the upgrade rule: [capacity.md](capacity.md).
- **Mailbox budget**: a burst of `pingdost_send_rejected_total{code="RATE_LIMITED"}` from one account is a sender over its daily mailbox budget (ADR 0030); see [incidents.md](incidents.md) → "Mailbox filling up".
- **Hostinger** transfer near 4 TB a month: attachments and (from Phase 25) relayed calls; check `pingdost_attachments_staged_bytes` trends.
- **Pages** build failures: Pages → Deployments → the log.

## Test the alerts (Phase 20 "Done when")
1. `dc stop server`: within 15 minutes healthchecks sends `pingdost jobs` late **and** `pingdost thresholds` failed (`metrics…`, `container server is not running`); UptimeRobot reports `/readyz` down.
2. `dc start server`: all three recover.
