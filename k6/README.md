# k6 load tests (Phase 27)

[k6](https://k6.io) (AGPL-3.0, run from its Docker image; not a project dependency) replays WebSocket frames for real accounts. Results and thresholds: [docs/ops/capacity.md](../docs/ops/capacity.md).

## Run locally
1. `pnpm infra:up` (Mongo, Valkey, Mailpit).
2. Start the load harness: the real API and jobs with relaxed per-IP limits and their own database `pingdost_load` (dev only):
   ```powershell
   cd apps/server
   $env:LOG_LEVEL='warn'; $env:ACCESS_TOKEN_TTL_SECONDS='7200'
   # optional, to watch migration: $env:MESSAGE_REDIS_STAGE_SECONDS='60'; $env:MESSAGE_MIGRATION_GRACE_SECONDS='60'; $env:MESSAGE_MIGRATION_POLL_SECONDS='20'
   pnpm exec tsx --env-file-if-exists=../../.env test/load-server.ts
   ```
   It prints `LOAD_STATS {...}` (sockets, RSS, heap, CPU of the last 10 s) every 10 s.
3. Prepare accounts and frames (writes `k6/.data/*.json`, git-ignored; it holds access tokens):
   ```powershell
   pnpm --filter @pingdost/sim-client load-prep -- --pairs 100 --messages 100 --bytes 600 --out ../../k6/.data/load.json
   ```
4. Run a scenario:
   ```powershell
   docker run --rm -v "${PWD}/k6:/k6" -e WS_URL=ws://host.docker.internal:3000/v1/ws -e SCENARIO=messages -e RATE=5 -e STAGGER_MS=20 grafana/k6:2.3.0 run --quiet /k6/ws-load.js
   ```
   The last line is `K6_SUMMARY {...}`.

## Scenarios (`SCENARIO`)
| Name | What it does | Knobs |
|---|---|---|
| `messages` | Per pair: B online and acknowledging every Deliver; A sends its frames at `RATE`/s; measures Accepted and delivery latency | `RATE`, `PAIRS` |
| `offline` | A sends to an offline B: every envelope goes to the mailbox (Valkey, then Mongo after the stage) | `RATE` |
| `connections` | A and B authenticate and hold the socket `HOLD` seconds with a ping every 25 s | `HOLD` |

Common: `LOAD_FILE` (default `./.data/load.json`), `STAGGER_MS` (VU n starts after n × STAGGER_MS; a burst of hundreds of connects through Docker Desktop's port forwarding drops some), `DEBUG=1` (print connect errors).

## How it works without protobuf
`load-prep` registers users and devices through the real API (OTPs from Mailpit) and encodes every frame in advance: Auth, Send (random "ciphertext"), the recipient's Ack, Ping. The server's replies carry the 16-byte envelope ID, so k6 finds them by searching the bytes; in an `Accepted`, the status byte follows the ID.
