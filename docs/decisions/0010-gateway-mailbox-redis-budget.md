# 0010 — Realtime gateway, delivery mailbox and the Redis budget

- **Status:** Accepted (the provider recommendation is input to Phase 20, which decides)
- **Date:** 2026-10-19
- **Phase:** 08
- **Approved by user:** n.a.

## Context
REQ §9 (mailbox lifecycle, reliability, monitoring), §15 (gateway, delivery, worker), §16.3, §18 and §19.2, with ARCHITECTURE A2–A4. The phase also had to measure Redis command usage, because Upstash's free tier allows 500K commands a month (A9, REQ §21), and recommend Upstash or self-hosted Valkey.

## Options considered
| Question | Option | Pros | Cons |
|---|---|---|---|
| Low one-time-key notice | **Event-driven: on connect, and after claims of an online device's keys** | Exact; no polling; no Redis | Not a scheduler job, as the phase sketched |
| | A worker job polling online devices | As sketched | Polls Mongo for every online device; the worker has no sockets when it runs out of process |
| ACK deletes | **Coalesced per connection (50 ms)** | One Redis transaction per burst of ACKs (sim-client: 229 → 115 commands for 20 messages) | Deletes land ≤ 50 ms later (the client already holds the envelope) |
| | One delete per ACK frame | Simplest | 6 commands per message for clients that ACK one by one |
| Redis orphan cleanup | **Inside the migration (every staged ID is in `due`) and lazily on fetch** | No extra polling commands | `mbx` orphans wait for the device's next fetch |
| | A reaper sweep of Redis | Independent | SCAN-style sweeps cost commands every interval |
| Mailbox gauges | **Refreshed by each migration run (4 pipelined reads)** | Fixed cost per poll | Up to one poll interval stale |
| | Read on every `/metrics` scrape | Fresh | A scrape every minute would cost ~170K commands a month |
| WS route path | **`/v1/ws`** (as the phase says) | Versioned like REST | Changed the `PUBLIC_WS_URL` / `EXPO_PUBLIC_WS_URL` defaults from `/ws` |

## Decision
1. **Gateway** (`modules/gateway`):
   - `@fastify/websocket` 11.3.4 (MIT); max frame = `limitsFor(ENVELOPE_MAX_BYTES).frame`.
   - Binary protobuf frames only. The first frame is `Auth` within 5 s; the gateway checks the JWT, the active session (`DEVICE_REQUIRED` without a device) and the active device.
   - One socket per device in an in-memory registry: the old one gets `CONNECTION_REPLACED` and close code 4002.
   - Per socket:
     - 300 frames and 30 typing frames per 10 s, and 64 sends in flight;
     - WS pings every 30 s (a missed pong terminates the socket);
     - a session re-check every 60 s, so a logout or revocation closes it (4001);
     - typing and ephemeral frames are dropped when more than 1 MiB is queued.
   - Close codes: 4001 unauthenticated, 4002 replaced, 4003 revoked, 4008 overloaded, 1002 protocol.
   - Revocation pushes `Revoked` and closes (4003).
   - `OtkLow` goes out when fewer than 20 one-time keys remain: checked after `AuthOk` and after claims of the device's keys.
   - Typing and ephemeral packets are relayed in memory to online devices only. An offline ephemeral recipient gets `RECIPIENT_OFFLINE`, and a successful relay has no reply.
2. **Send.** The gateway decodes the frame, then `DeliveryService.prepare` checks the envelope:
   - `dst` = recipient (`MALFORMED_FRAME`);
   - the sender device is the socket's device (`FORBIDDEN`);
   - the recipient device exists and is active (`RECIPIENT_UNKNOWN`);
   - a block-list hook, for Phase 11.

   The server sets `createdAt` = receive time and `expiresAt` = min(the packet's expiry, `createdAt` + retention), so it never extends a sender's expiry. Then:
   - **Online:** `Deliver` → transport ACK within `MESSAGE_ONLINE_ACK_TIMEOUT_MS` → `Accepted{DELIVERED_TRANSPORT}`; nothing is stored.
   - **Offline:** dedupe against Mongo; Redis MULTI with every write NX (a duplicate changes nothing); `Accepted{STORED}`; then a push wake (a no-op `PushNotifier` until Phase 12).
   - **Redis down:** write to Mongo. **Both down:** `MAILBOX_UNAVAILABLE` (retryable).
3. **Redis keys** (A3), under a configurable prefix (tests use one per server):
   - `env:{id}`, with a safety TTL of (due − now) + GRACE;
   - `mbx:{device}`, scored by `createdAt`;
   - `due`, scored by min(`createdAt` + STAGE, `expiresAt`);
   - `lock:{id}`.
4. **Fetch on connect.**
   - Merge Redis (`ZRANGE` + `MGET`) with Mongo, dedupe, order by `createdAt`, in batches of 50. Each next batch waits for the previous batch's ACKs (30 s; a client that stops ACKing gets the rest on its next connection).
   - `mbx` IDs whose record expired are dropped while fetching.
   - An ACK deletes from Redis only for envelopes fetched from Redis (or of unknown origin), and always from Mongo. The always-Mongo part closes the fetch → migrate → ACK race.
5. **Migration** (every `MESSAGE_MIGRATION_POLL_SECONDS`, Mongo-leased job). For each due ID:
   1. Take the `lock` (NX PX) and `GET` the record.
   2. If the record is gone (acknowledged), drop it from `due`. If it is past `expiresAt`, delete it instead of migrating.
   3. Otherwise upsert into `pending_envelopes` (`$setOnInsert`, `w: majority`, the original `createdAt` and `expiresAt`) and read it back. Up to 3 attempts per run, with 200/400 ms backoff. A failure stops the run and keeps the Redis copy.
   4. `MULTI DEL env + ZREM mbx + ZREM due`. If the `DEL` found nothing, an ACK raced the migration, so the new Mongo copy is deleted too.

   It then records the stage gauges. **Overdue** means due for more than half the grace period, so the alert fires while the Redis copy still exists (the issue text said STAGE + GRACE, by which time the data is gone).
6. **Reaper** (every `MESSAGE_REAPER_INTERVAL_SECONDS`): `deleteMany({expiresAt ≤ now})` on Mongo, backing up the TTL index. It makes no Redis calls (see the options above).
7. **Metrics** (`/metrics`, `METRICS_TOKEN` bearer, 404 when unset; `prom-client` 15.1.3, Apache-2.0, a registry per app):
   - counters: envelopes accepted by path (online/redis/mongo), duplicates, rejected sends by code, ACKs, migrations, migration failures, expired deletes by store, deletion failures by store;
   - gauges: WS connections, Redis commands, Redis stage count and oldest age, due backlog, overdue, Mongo pending count and oldest age.
8. **Redis persistence:** an `Accepted{STORED}` envelope lives only in Redis until migration, so Redis must persist it. Self-hosted Valkey runs with `appendonly yes`, `appendfsync everysec` (docker-compose now does), which loses at most about a second of writes on a crash. Upstash persists by default.

## Redis budget (measured)
The app's Redis handle counts every command. It matched Valkey's own `total_commands_processed` exactly (MULTI/EXEC and pipelines included), and Upstash bills each command inside a transaction or pipeline too. Numbers come from `test/redis-budget.int.test.ts`, whose ceilings now guard them:

| Operation | Commands |
|---|---|
| Store one offline envelope (MULTI, SET, 2×ZADD, EXEC) | 5 |
| Online delivery | 0 |
| Fetch: a non-empty batch (ZRANGE + MGET) | 2 per batch |
| Fetch: connect with an empty Redis stage | 1 |
| ACK batch (ZMSCORE, MULTI, DEL, 2×ZREM, EXEC), plus the stream's final ZRANGE | 6 + 1 |
| ACK of Mongo-held envelopes | 0 (+1 final ZRANGE) |
| Migrate one envelope (SET lock, GET, MULTI, DEL, 2×ZREM, EXEC) | 7 |
| Migration run overhead (ZRANGEBYSCORE + 4-read snapshot) | 5 |
| Idle at the default 300 s poll | 5 × 288 × 30.4 ≈ **44K / month** |
| Redis (re)connection handshake (HELLO, CLIENT ×2, INFO) | 4 per process start |

The sim-client, which ACKs each message separately, measured 115 commands for 20 offline messages (5.8 per message) against the dev server.

**Projection.** Assumptions per active user per day:
- 40 messages received, on one device. Phase 16 linked browsers add one envelope per extra device.
- 70 % take the offline path: until push wakes and background sockets (Phase 12), most phones are backgrounded.
- 20 app opens, half of which find mail.
- 2 % wait past the 14-hour stage and migrate.

That gives 28×5 + 10×9 + 10×1 + 0.56×7 ≈ **244 commands/day ≈ 7,400 per user per month**, plus the fixed 44K idle cost.

| Active users | Commands / month | Upstash free (500K) | Upstash pay-as-you-go ($0.20 / 100K) | Self-hosted Valkey |
|---|---|---|---|---|
| 10 | ≈ 118K | fits (24 %) | — | $0 |
| 100 | ≈ 784K | **exceeds** (fits ≈ 60 users) | ≈ $1.6 / month | $0 |
| 1,000 | ≈ 7.4M | exceeds | ≈ $15 / month (a fixed plan starts at $10 / month) | $0 |

Memory is small either way: a staged envelope takes about 1.5 KB with keys, so even 10,000 waiting envelopes use about 15 MB (Upstash free: 256 MB).

**Recommendation for Phase 20:** **self-hosted Valkey on the API's VM, with AOF.**
- It costs nothing at any scale here and needs only tens of MB of RAM.
- Upstash free suits development and a pilot of up to about 50 active users. Beyond that it needs a credit card: about $1.6–15 a month at 100–1,000 users.
- If the VM is too small for Valkey, use Upstash pay-as-you-go with a budget cap (Upstash then rate-limits instead of billing more). That needs the user's approval, since it costs money.
- Levers if the budget gets tight:
  - `MESSAGE_MIGRATION_POLL_SECONDS` = 600 halves the idle cost (needs GRACE ≥ 1800);
  - Lua scripts for store and ACK (one EVALSHA each). Upstash's per-script billing is not documented, so measure first.

## Consequences
- The server depends on `@fastify/websocket`, `ws` (`@types/ws` for development) and `prom-client`. `tools/sim-client` is a new workspace package.
- `PUBLIC_WS_URL` and the client examples now end in `/v1/ws`.
- Phase 9 builds the client message engine on these frames. It must dedupe on `message_id`, and should batch ACKs (the server coalesces anyway).
- Phase 10 runs the socket in the app.
- Phase 11 adds block lists, and presence and typing scoped to contacts.
- Phase 12 implements `PushNotifier`.
- Phase 20 picks the Redis provider and sets AOF, and decides on the worker's metrics when it runs out of process.

## Evidence
- `pnpm --filter @pingdost/server test:int`: 95/95. They cover:
  - all 9 REQ §19.2 scenarios (`test/mailbox.int.test.ts`), including a failing Mongo during migration, ACKs racing the migration, a restart holding a stale lock, absolute expiry after a late migration, the Redis-down fallback and both stores down;
  - the gateway (auth, replacement, revocation, online path and timeout fallback, validation, relays, `OtkLow`, `/metrics`);
  - the budget ceilings.
- Sim-client against `pnpm --filter @pingdost/server dev`: 20 stored, delivered once each, acknowledged and gone; 20 delivered online.
- Upstash pricing and billing checked 2026-10-19: upstash.com/pricing/redis and upstash.com/docs/redis/overall/billing (500K commands and 256 MB free; $0.20 per 100K; commands inside pipelines and transactions billed individually; fixed plans from $10/month).
