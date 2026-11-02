# Capacity, cost and alert thresholds (Phase 27)

Measured 2026-11-02 on the dev PC (Windows 11, Docker Desktop: Mongo 8.0 single-node replica set, Valkey 8.1; the API in Node 24 under `tsx`; k6 2.3.0 in Docker on the same machine, so the numbers are conservative). Tools: `apps/server/test/load-server.ts` (the real API and jobs with relaxed per-IP limits), `pnpm --filter @pingdost/sim-client load-prep` (real accounts and devices) and `k6/ws-load.js` (see `k6/README.md`). Re-run on the VPS before a public launch (§5).

## 1. Measurements

| Scenario | Load | Result |
|---|---|---|
| Idle sockets | 500 authenticated WebSockets, pings every 25 s, connects spread over 5 s | 100 % auth, p95 170 ms; heap +21 MiB, RSS +70 MiB (≈ 140 KB per socket at most); CPU ≈ 1 % |
| Connect burst | 500 sockets at once | 87 % succeeded through Docker Desktop's port forwarding, auth p95 2.5 s; no server error (a local network limit) |
| Online messages | 20 pairs × 10/s (200 msg/s), 600-byte ciphertext | 4,000 delivered; Accepted p50 17 ms, p95 34 ms |
| Online messages | 250 pairs × 2/s (≈ 500 msg/s) | 10,000 delivered; Accepted p50 348 ms, p95 797 ms; **72–85 % of one core** (≈ 1.6 ms CPU per message incl. the recipient's delivery and ACK) |
| Offline (mailbox) | 100 pairs × 5/s (≈ 500 msg/s) to offline devices | 10,000 stored; Accepted p50 816 ms / p95 1,137 ms before the device-owner cache, **13 ms / 109 ms** after (ADR 0030) |
| Valkey per envelope | 10,000 staged | +15.4 MB → **≈ 1.55 KB** per envelope (600 B ciphertext; record + two index entries) |
| Mongo per envelope | 10,000 migrated | 986 B document + ≈ 330 B indexes → **≈ 1.3 KB** |
| Mongo per device | 1,140 users with one device each | one-time keys 18.3 KB (50 per device), device 0.7 KB, session 0.4 KB, user 0.5 KB, security events 0.5 KB (90 days) → **≈ 20 KB per device** plus indexes |
| Migration backlog | 10,000 due at once, 60 s grace (test setting), 20 s poll | Before: **600 migrated, 9,400 lost** (one batch per poll). Drain, one envelope at a time: 4,000. **Drain + bulk writes: all 10,000 in ≈ 45 s**, 0.4 s per 200 |

## 2. Limits that bind first

1. **Atlas Free (M0): 100 operations per second** and 512 MB ([MongoDB docs](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/), checked 2026-11-02).
   - Steady-state Mongo operations: a stored (offline) envelope costs 1 (the duplicate check); online sends cost 0 once the device-owner and block caches are warm; migration costs 2 per 200 envelopes; a reconnect that fetches from Mongo costs 2 per 50; a WS connect costs about 2 (session, device).
   - So M0 sustains roughly **60–80 offline envelopes per second** next to logins and key claims. Short bursts above that are throttled by Atlas (slower, not lost: the sender's outbox retries).
   - Storage: 512 MB ≈ **18,000 devices** with room for ≈ 100,000 migrated envelopes (130 MB). One-time keys are 90 % of the per-device size.
2. **VPS CPU (KVM 1: 1 vCPU)**: about **400–500 messages per second** at saturation (one core here). With ~300 envelopes per active user per day (messages, receipts, edits) and a 10× evening peak, that is ≈ 15,000 daily active users.
3. **VPS RAM (4 GB)**: API ≈ 170 MiB idle + ≈ 140 KB per socket → 5,000 sockets ≈ 0.9 GB; Valkey: the 14-hour stage at 1.55 KB per envelope; its `maxmemory` is 256 MB (`deploy/compose.staging.yml`, `noeviction`) ≈ **165,000 staged envelopes**, after which writes go straight to Mongo (by design, nothing is evicted). coturn is bandwidth-bound, not RAM.
4. **VPS disk (50 GB)**: attachment staging quota 30 GiB (`ATTACHMENT_TOTAL_QUOTA_BYTES`), Docker images and logs ≈ 5 GB, Valkey AOF, Mongo dumps (7 × a few MB).
5. **Monthly transfer**: relayed calls dominate. A relayed 720p call is ≈ 1.5–2.5 Mbit/s each way through coturn (≈ 25–35 MB per minute in + out); Phase 25 measured 0.7 MB in 29 s for the 320×240 test pattern. Most calls connect directly (no VPS traffic).

## 3. Decision: KVM 1 or KVM 2

**Stay on KVM 1 (no change, no new cost).** For internal testing and the first months, the binding limit is Atlas M0, not the VPS. Upgrade when one of these holds for a week (then tell the user first; KVM 2 costs more):
- API + jobs CPU above 60 % at the evening peak, or Accepted p95 above 500 ms;
- RAM available under 15 % (`monitor.sh` alert) or Valkey `used_memory` above 70 % of `maxmemory`;
- moving Mongo onto the VPS (ADR 0013 says KVM 2 then).

**Atlas M0 → paid tier or self-hosted Mongo** (both cost money or RAM; ask the user): when the data size passes 400 MB, or Atlas throttling shows (operations near 100/s in Atlas metrics, mailbox Accepted latency rising).

## 4. Alert thresholds

Added to `docs/ops/alerts.md` (Phase 20 has the mechanics):

| Signal | Warn | Act |
|---|---|---|
| Atlas data size (Atlas UI alert, free) | 350 MB | 450 MB: prune, or plan the move (ask the user) |
| Atlas operations per second (Atlas alert) | 60 for 10 min | 85 for 10 min |
| `pingdost_mailbox_due_overdue` | > 0 | > 0 for 2 polls: migration is behind (incidents runbook) |
| `pingdost_mailbox_mongo_pending_count` | 100,000 | 200,000 |
| Valkey `used_memory` / `maxmemory` | 70 % | 85 % |
| VPS RAM available | 20 % | 10 % |
| VPS disk free | 25 % | 15 % |
| `pingdost_attachments_staged_bytes` | 20 GiB | 27 GiB (quota 30 GiB) |
| Monthly transfer (Hostinger panel) | 60 % of plan | 80 % of plan |
| `pingdost_send_rejected_total{code="RATE_LIMITED"}` (mailbox budget) | any burst | sustained from one account: abuse (incidents runbook) |

## 5. Re-running on staging
Per-IP route limits stay on in production, so one machine cannot open hundreds of sockets against staging. Run the harness on the VPS itself against a scratch database instead (same CPU, same disk):
1. `ssh` to the VPS; `cd /srv/pingdost`.
2. Run a one-off container of the server image with `LOAD_MONGODB_URI` pointing to a scratch database on Atlas (never the real one), `MESSAGE_REDIS_STAGE_SECONDS=60`, `MESSAGE_MIGRATION_GRACE_SECONDS=60`, `MESSAGE_MIGRATION_POLL_SECONDS=20`, and Mailpit for OTPs (or prepare accounts in dev and copy only the tokens, which are tied to the signing key).
3. Run k6 from another machine on the same network, or on the VPS with `--cpus` limited.
4. Record the table in §1 again here; delete the scratch database afterwards.
