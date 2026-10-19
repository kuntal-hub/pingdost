/**
 * PingDost simulation client (Phase 8): two headless devices exercise the gateway and the
 * mailbox of a running server with opaque fake ciphertext.
 * 1. Bob is offline: Alice sends N envelopes, each answered `Accepted{STORED}`.
 * 2. Bob connects: all N arrive once each and are acknowledged; a reconnect finds none.
 * 3. Bob stays online: N more are answered `Accepted{DELIVERED_TRANSPORT}`.
 * With `--metrics-token`, it reports the server's Redis commands per stored message.
 *
 *   pnpm --filter @pingdost/sim-client start -- --messages 20 [--api http://127.0.0.1:3000]
 *     [--ws ws://127.0.0.1:3000/v1/ws] [--mailpit http://127.0.0.1:8025] [--metrics-token T]
 */
import { parseArgs } from 'node:util';

import { createWasmCryptoProvider } from '@pingdost/crypto';
import { Accepted_Status, type ServerFrame } from '@pingdost/protocol';

import { createDevice } from './device';
import { fakeEnvelope, SimSocket } from './socket';

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: 'http://127.0.0.1:3000' },
    ws: { type: 'string' },
    mailpit: { type: 'string', default: 'http://127.0.0.1:8025' },
    messages: { type: 'string', default: '20' },
    'metrics-token': { type: 'string' },
  },
});
const api = values.api.replace(/\/+$/, '');
const wsUrl = values.ws ?? `${api.replace(/^http/, 'ws')}/v1/ws`;
const count = Number(values.messages);

function status(body: ServerFrame['body']): string {
  if (body.case === 'accepted') return Accepted_Status[body.value.status];
  if (body.case === 'error') return `error ${body.value.code}`;
  return String(body.case);
}

async function redisCommands(): Promise<number | undefined> {
  const token = values['metrics-token'];
  if (!token) return undefined;
  const response = await fetch(`${api}/metrics`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`/metrics answered ${response.status}`);
  const line = /^pingdost_redis_commands (\d+)/m.exec(await response.text());
  return line ? Number(line[1]) : undefined;
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
  console.log(`  ok  ${message}`);
}

async function main(): Promise<void> {
  console.log(`sim-client → ${api} (${wsUrl}), ${count} messages per round`);
  const crypto = await createWasmCryptoProvider();
  const endpoints = { api, mailpit: values.mailpit };
  const alice = await createDevice(endpoints, crypto);
  const bob = await createDevice(endpoints, crypto);
  console.log(`devices: ${alice.username} → ${bob.username}`);
  const aliceSocket = await SimSocket.connect(wsUrl, alice.accessToken);

  console.log('round 1: recipient offline');
  const commandsBefore = await redisCommands();
  const sent: string[] = [];
  const statuses = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const { packet, envelopeId } = fakeEnvelope(alice.deviceId, bob.deviceId);
    const result = status(await aliceSocket.sendEnvelope(packet));
    statuses.set(result, (statuses.get(result) ?? 0) + 1);
    sent.push(envelopeId);
  }
  check(
    statuses.get('STORED') === count,
    `${count} × Accepted{STORED} (${JSON.stringify(Object.fromEntries(statuses))})`,
  );

  const bobSocket = await SimSocket.connect(wsUrl, bob.accessToken);
  const received = await bobSocket.drain(1_500);
  check(new Set(received).size === received.length, `no duplicate deliveries (${received.length})`);
  check(
    sent.every((id) => received.includes(id)),
    `all ${count} delivered`,
  );
  bobSocket.close();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const again = await SimSocket.connect(wsUrl, bob.accessToken);
  check((await again.drain(800)).length === 0, 'acknowledged envelopes are gone');
  const commandsAfter = await redisCommands();

  console.log('round 2: recipient online');
  let delivered = 0;
  for (let i = 0; i < count; i++) {
    const { packet } = fakeEnvelope(alice.deviceId, bob.deviceId);
    const answer = aliceSocket.sendEnvelope(packet);
    await again.drain(50);
    if (status(await answer) === 'DELIVERED_TRANSPORT') delivered++;
  }
  check(delivered === count, `${count} × Accepted{DELIVERED_TRANSPORT}`);

  if (commandsBefore !== undefined && commandsAfter !== undefined) {
    const used = commandsAfter - commandsBefore;
    console.log(
      `redis: ${used} commands for ${count} stored messages (store, fetch, ack): ${(used / count).toFixed(1)} per message`,
    );
  }
  aliceSocket.close();
  again.close();
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`sim-client failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
