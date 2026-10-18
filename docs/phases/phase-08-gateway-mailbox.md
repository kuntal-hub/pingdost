# Phase 08 — Realtime gateway & delivery mailbox (+ Redis budget spike)

**Depends on:** 06 · **Platforms:** Node server, tools

## Goal
Build an authenticated WebSocket gateway and a reliable ciphertext delivery mailbox. It covers the online direct path, the Redis hot stage, Mongo migration, ACK deletion and absolute expiry, all observable and idempotent. Also measure Redis command usage to settle Upstash vs Valkey.

## Read first
- REQ §5.3, §8.1 (idempotency bullets), §9 (all), §15 (Realtime gateway, Delivery, Background worker), §16.3, §18, §19.2
- ARCHITECTURE A2, A3, A4

## Tasks
- [ ] **WS endpoint `/v1/ws`** (`@fastify/websocket`):
  - The first frame must be `Auth{accessToken}` within 5 s (no tokens in the URL); verify the JWT, the session and that the device is active.
  - One live socket per device: a newer one replaces the old, which receives `Error{code:REPLACED}`.
  - Ping/pong heartbeat, max frame size, per-socket rate limits (in-memory), and backpressure handling.
  - The in-memory connection registry `deviceId → socket`.
  - Hook up `Revoked` from Phase 6 to close revoked devices' sockets.
- [ ] **Send path** `Send{envelopes[]}`. For each envelope:
  1. Check the sender device equals the socket device, the recipient device exists and is active, the size is ≤ `ENVELOPE_MAX_BYTES`, and the sender is not blocked by the recipient (block list arrives in Phase 11; leave a hook).
  2. **Server sets `createdAt` = receive time and `expiresAt` = createdAt + `MESSAGE_MAX_RETENTION_SECONDS`.**
  3. **Dedupe** by envelopeId: if it is already stored, re-acknowledge with the same status.
  4. **Online path:** recipient connected → `Deliver` → wait for `Ack` up to `MESSAGE_ONLINE_ACK_TIMEOUT_MS` → reply `Accepted{DELIVERED_TRANSPORT}`. On timeout, fall through to offline.
  5. **Offline path:** a Redis MULTI per A3 (`env:`, `mbx:`, `due`), then `Accepted{STORED}`, then `PushNotifier.wake(recipientDeviceId)` (a no-op interface until Phase 12).
  6. Redis down → write directly to Mongo `pending_envelopes` → `Accepted{STORED}`.
  7. Both down → `Error{retryable:true}`. The client keeps it in its outbox.
- [ ] **Fetch on (re)connect:** after `AuthOk`, stream pending envelopes from Redis + Mongo, merged, deduped and ordered by createdAt, in batches with flow control.
  - Clients `Ack{envelopeIds[]}`. The ACK deletes from Redis (MULTI DEL/ZREM/ZREM) and Mongo (deleteMany by `_id`). It is idempotent.
- [ ] **Mongo `pending_envelopes`** (REQ §16.3): unique `_id` = envelopeId; indexes `{recipientDeviceId, createdAt}` and TTL `{expiresAt}` with expireAfterSeconds 0. It holds no plaintext fields.
- [ ] **Worker jobs** (scheduler from Phase 5):
  - **migration** (A3 algorithm, with lease, `$setOnInsert`, majority write, read-back verify, then delete from Redis; bounded batch; retries with backoff);
  - **reaper** (Mongo `deleteMany({expiresAt<now})`; ZSET orphan cleanup; alert metric if any `due` item is older than STAGE + GRACE);
  - **OTK low-water** notice (`OtkLow` to online devices below threshold).
- [ ] **Metrics** `/metrics` (Prometheus text, `METRICS_TOKEN` bearer). Counters and gauges listed in A3, built on `prom-client`.
- [ ] **`tools/sim-client`**: a headless Node client (api-client + WS + protocol codecs). It registers a user and device (test OTP via Mailpit, or a test-only server hook gated to `NODE_ENV=test`) and sends **opaque fake ciphertext**. Real crypto arrives in Phase 9.
- [ ] **Integration tests** (small env values, e.g. STAGE=2 s, GRACE=9 s, POLL=1 s), covering every REQ §19.2 bullet:
  1. offline message lands in Redis;
  2. migrated at the stage boundary; Redis copy deleted only after the verified Mongo write;
  3. **Mongo unavailable during migration** (inject a failing repo) → the Redis copy remains; a retry succeeds; no loss;
  4. **delivery races migration** → exactly one logical delivery (client-side dedupe) and no leftovers in either store;
  5. ACK removes the envelope from both stores; a later fetch does not return it;
  6. expiry is absolute from creation, not from migration;
  7. server/worker restart mid-migration resumes safely;
  8. Redis down on send → Mongo fallback;
  9. duplicate send → a single stored copy.
- [ ] **Redis budget spike:** use the command counter to measure commands per offline message (store + fetch + ack + migrate) and per idle hour (worker polling). Project monthly usage for 10, 100 and 1,000 users. Write an ADR (Redis budget & provider) recommending Upstash vs Valkey; the decision itself lands in Phase 20.

## Key files
`apps/server/src/modules/{gateway/*,delivery/*}`, `apps/server/src/jobs/{migrate.ts,reap.ts,otkLow.ts}`, `apps/server/src/infra/metrics.ts`, `tools/sim-client/*`

## Out of scope
Real E2EE payloads (09), push (12), groups routing (13), attachments (14).

## Done when
- All 9 integration scenarios pass (`pnpm --filter @pingdost/server test:int`).
- `/metrics` exposes the A3 metrics.
- The Redis budget ADR is written with measured numbers.
- `pnpm lint typecheck test` passes.
