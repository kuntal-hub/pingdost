// PingDost WebSocket load test (Phase 27; k6/README.md). Replays frames that
// `pnpm --filter @pingdost/sim-client load-prep` built for real accounts, so this script needs
// no protobuf code: replies are recognised by the 16-byte envelope IDs they carry.
//
// SCENARIO (env):
//   messages    (default) each VU is a pair: B online and acknowledging, A sending at RATE/s
//   offline     A sends to an offline B: every envelope goes to the mailbox (Redis, then Mongo)
//   connections A and B connect, authenticate and hold the socket for HOLD seconds with pings
//
//   docker run --rm -v "${PWD}/k6:/k6" -e WS_URL=ws://host.docker.internal:3000/v1/ws \
//     grafana/k6:2.3.0 run /k6/ws-load.js
import { SharedArray } from 'k6/data';
import encoding from 'k6/encoding';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';
import { clearInterval, setInterval, setTimeout } from 'k6/timers';
import { WebSocket } from 'k6/websockets';

const file = JSON.parse(open(__ENV.LOAD_FILE || './.data/load.json'));
const pairs = new SharedArray('pairs', () => file.pairs);
const WS_URL = __ENV.WS_URL || file.ws;
const SCENARIO = __ENV.SCENARIO || 'messages';
const RATE = Number(__ENV.RATE || 5); // messages per second per pair
const HOLD = Number(__ENV.HOLD || 60); // seconds (connections)
const VUS = Math.min(Number(__ENV.PAIRS || pairs.length), pairs.length);

const authMs = new Trend('pd_auth_ms', true);
const acceptedMs = new Trend('pd_accepted_ms', true);
const deliveredMs = new Trend('pd_delivered_ms', true);
const accepted = new Counter('pd_accepted');
const storedRate = new Rate('pd_stored');
const authOk = new Rate('pd_auth_ok');

export const options = {
  scenarios: {
    main: { executor: 'per-vu-iterations', vus: VUS, iterations: 1, maxDuration: '30m' },
  },
  thresholds: {
    pd_auth_ok: ['rate>0.99'],
    ...(SCENARIO === 'connections' ? {} : { pd_accepted_ms: ['p(95)<1000'] }),
  },
};

const bytes = (b64) => new Uint8Array(encoding.b64decode(b64, 'std'));

/** Index of `needle` in `haystack`, or -1. */
function find(haystack, needle) {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Opens a socket, sends `auth`, and calls `ready` after the first reply (AuthOk). */
function connect(auth, onMessage, ready) {
  const ws = new WebSocket(WS_URL);
  ws.binaryType = 'arraybuffer';
  const started = Date.now();
  let authed = false;
  ws.onopen = () => ws.send(bytes(auth).buffer);
  ws.onmessage = (event) => {
    const data = new Uint8Array(event.data);
    if (!authed) {
      authed = true;
      authMs.add(Date.now() - started);
      authOk.add(true);
      ready(ws);
      return;
    }
    onMessage(data);
  };
  ws.onerror = (event) => {
    if (authed) return;
    authOk.add(false);
    if (__ENV.DEBUG) console.warn(`connect failed: ${event.error}`);
  };
  return ws;
}

// STAGGER_MS spreads the connects (VU n starts after n × STAGGER_MS) instead of one burst:
// a burst of hundreds of connects through Docker Desktop's port forwarding drops some.
export default function () {
  setTimeout(run, (exec.vu.idInTest - 1) * Number(__ENV.STAGGER_MS || 0));
}

function run() {
  const pair = pairs[(exec.vu.idInTest - 1) % pairs.length];
  const ids = pair.envelopeIds.map(bytes);
  const sentAt = new Map();
  const ping = bytes(file.ping).buffer;

  if (SCENARIO === 'connections') {
    for (const side of [pair.a, pair.b]) {
      connect(
        side.auth,
        () => {},
        (ws) => {
          const timer = setInterval(() => ws.send(ping), 25_000);
          setTimeout(() => {
            clearInterval(timer);
            ws.close();
          }, HOLD * 1000);
        },
      );
    }
    return;
  }

  let done = 0;
  const total = ids.length;
  const finish = (sockets) => sockets.forEach((ws) => ws && ws.close());

  // A: matches each Accepted by its envelope ID; the status byte follows the ID (field 3).
  const startSending = (b) => {
    const a = connect(
      pair.a.auth,
      (data) => {
        for (const [index, t0] of sentAt) {
          const at = find(data, ids[index]);
          if (at < 0) continue;
          sentAt.delete(index);
          acceptedMs.add(Date.now() - t0);
          accepted.add(1);
          storedRate.add(data[at + 16] === 0x18 && data[at + 17] === 1);
          done++;
          break;
        }
        if (done === total) finish([a, b]);
      },
      (ws) => {
        let next = 0;
        const timer = setInterval(() => {
          if (next >= total) return clearInterval(timer);
          sentAt.set(next, Date.now());
          ws.send(bytes(pair.sends[next]).buffer);
          next++;
        }, 1000 / RATE);
        // Give up on stragglers after a while, so a run always ends.
        setTimeout(() => finish([ws, b]), (total / RATE + 30) * 1000);
      },
    );
  };

  if (SCENARIO === 'offline') {
    startSending(undefined);
    return;
  }

  // B: acknowledges every Deliver, found by the envelope IDs it carries.
  const delivered = new Set();
  let recipient;
  connect(
    pair.b.auth,
    (data) => {
      for (const [index, t0] of sentAt) {
        if (delivered.has(index) || find(data, ids[index]) < 0) continue;
        delivered.add(index);
        deliveredMs.add(Date.now() - t0);
        recipient.send(bytes(pair.acks[index]).buffer);
        break;
      }
    },
    (b) => {
      recipient = b;
      startSending(b);
    },
  );
}

export function handleSummary(data) {
  const metric = (name, stat) => data.metrics[name]?.values?.[stat];
  const summary = {
    scenario: SCENARIO,
    pairs: VUS,
    rate: RATE,
    auth_p95_ms: metric('pd_auth_ms', 'p(95)'),
    accepted: metric('pd_accepted', 'count'),
    accepted_p50_ms: metric('pd_accepted_ms', 'med'),
    accepted_p95_ms: metric('pd_accepted_ms', 'p(95)'),
    delivered_p95_ms: metric('pd_delivered_ms', 'p(95)'),
    stored_share: metric('pd_stored', 'rate'),
    auth_ok: metric('pd_auth_ok', 'rate'),
  };
  return { stdout: `K6_SUMMARY ${JSON.stringify(summary)}\n` };
}
