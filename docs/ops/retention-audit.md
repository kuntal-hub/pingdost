# Retention audit (Phase 27)

Checks that no temporary record outlived its limit (REQ §5, §18, §23.3). It reads counts, ages and TTLs only, never contents, so its JSON is safe to paste into an issue. It creates no indexes: a missing TTL index is reported, not repaired.

## Run it
- Staging/production, on the VPS (`cd /srv/pingdost`):
  ```sh
  docker compose -f compose.staging.yml exec server node dist/retention-audit.js; echo "exit $?"
  ```
- Dev: `pnpm --filter @pingdost/server retention-audit` (reads the root `.env`).

Exit codes: `0` all checks pass · `1` a violation (`"ok": false`) · `2` the audit itself failed (no database, …).

## What it checks
| Check | Limit |
|---|---|
| TTL indexes on `pending_envelopes`, `email_otps`, `sessions`, `pairing_requests`, `primary_transfer_requests`, `device_challenges`, `security_events`, `abuse_reports` (`expiresAt`) and `users` (`pendingExpiresAt`) | present |
| Documents past their `expiresAt` / `pendingExpiresAt` | ≤ 15 min late (Mongo's TTL monitor runs every 60 s) |
| `pending_envelopes` older than `MESSAGE_MAX_RETENTION_SECONDS`, or expiring later than creation + retention | none |
| `security_events`, `abuse_reports` older than their retention settings | none |
| `attachments` records past `expiresAt` | ≤ janitor interval + 15 min |
| Staged attachment files (`ATTACHMENT_FS_ROOT`) without a record past `ATTACHMENT_ORPHAN_SECONDS`, or older than the retention | none |
| Valkey `env:*` and `lock:*` keys | every key has a TTL ≤ stage + grace |

## When
- Monthly, and after any change to the mailbox, attachments, auth or the jobs.
- After an incident where jobs stopped (the `pingdost jobs` heartbeat alert).

## A violation
1. Read which check failed and `worstOverdueSeconds`.
2. Jobs stopped? `dc logs --tail 200 server | grep -E 'job|mailbox|janitor'`; the heartbeat alert should have fired.
3. A missing TTL index: restart the server (indexes are created at start-up), then run the audit again.
4. Files on disk: the janitor sweeps them on its next run (`ATTACHMENT_JANITOR_INTERVAL_SECONDS`); if they stay, see [incidents.md](incidents.md) → "Disk full".
5. Record the result and the fix in the PROGRESS entry or an issue (no contents, just the report).

## Backups and copies outside the audit
- The nightly Mongo dump leaves out every delivery collection (deploy.md → "Backups"); it holds security events and abuse reports for up to 7 days past their TTL.
- Valkey's append-only file keeps deleted keys' history until its next rewrite (automatic when the file doubles; `dc exec valkey valkey-cli -a "$VALKEY_PASSWORD" BGREWRITEAOF` forces one).
- Hostinger's VPS snapshots copy the whole disk (Valkey data, staged attachments): ciphertext only, kept as long as Hostinger keeps the snapshot. The privacy policy states this.
