/**
 * PingDost simulation client (Phase 9): two headless devices exchange real E2EE messages
 * (vodozemac via WASM, the message engine, the gateway) through a running server.
 * 1. Bob is offline: Alice sends N messages; each reaches `sent_to_server`.
 * 2. Bob comes online: all N arrive once each, decrypted; Alice sees each `delivered` only
 *    after Bob's E2EE receipt.
 * 3. Both online: N more, delivered.
 * Every WebSocket frame is captured and searched for a plaintext marker: it must never
 * appear. With `--metrics-token`, it reports the server's Redis commands per message.
 *
 *   pnpm --filter @pingdost/sim-client start -- --messages 20 [--api http://127.0.0.1:3000]
 *     [--ws ws://127.0.0.1:3000/v1/ws] [--mailpit http://127.0.0.1:8025] [--metrics-token T]
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

import { createWasmCryptoProvider } from '@pingdost/crypto';

import { SimClient, type Endpoints } from './client';
import { capturingSocket, containsMarker } from './frames';

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
const endpoints: Endpoints = {
  api,
  ws: values.ws ?? `${api.replace(/^http/, 'ws')}/v1/ws`,
  mailpit: values.mailpit,
};
const count = Number(values.messages);
const MARKER = `PLAINTEXT-MARKER-${randomUUID()}`;

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

async function until(condition: () => Promise<boolean>, what: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function main(): Promise<void> {
  console.log(`sim-client → ${api} (${endpoints.ws}), ${count} messages per round`);
  const crypto = await createWasmCryptoProvider();
  const frames: Uint8Array[] = [];
  const options = { endpoints, crypto, createSocket: capturingSocket(frames) };
  const alice = await SimClient.register(options);
  const bob = await SimClient.register(options);
  console.log(`devices: ${alice.username} → ${bob.username}`);
  await alice.start();
  const { conversationId } = await alice.engine.openDirectConversation(bob.userId);

  const states = async (ids: string[]) =>
    Promise.all(ids.map(async (id) => (await alice.engine.getMessage(id))?.state));
  const allIn = async (ids: string[], state: string) =>
    (await states(ids)).every((s) => s === state);

  console.log('round 1: recipient offline');
  const commandsBefore = await redisCommands();
  const first: string[] = [];
  for (let i = 0; i < count; i++) {
    first.push((await alice.engine.sendText(conversationId, `${MARKER} #${i}`)).messageId);
  }
  await until(() => allIn(first, 'sent_to_server'), 'round 1 sent_to_server');
  check(true, `${count} × sent_to_server while bob is offline`);

  await bob.start();
  await until(
    () => Promise.resolve(bob.store.allMessages().length === count),
    'bob receives round 1',
  );
  const bodies = bob.store.allMessages().map((m) => m.body);
  check(new Set(bodies).size === count, `bob decrypted ${count} distinct messages, no duplicates`);
  check(
    first.every((id) => bob.store.allMessages().some((m) => m.messageId === id)),
    'every message ID arrived',
  );
  await until(() => allIn(first, 'delivered_to_recipient_device'), 'round 1 receipts');
  check(true, `${count} × delivered_to_recipient_device after bob's receipts`);
  const commandsAfter = await redisCommands();

  console.log('round 2: recipient online');
  const second: string[] = [];
  for (let i = 0; i < count; i++) {
    second.push((await alice.engine.sendText(conversationId, `${MARKER} online #${i}`)).messageId);
  }
  await until(() => allIn(second, 'delivered_to_recipient_device'), 'round 2 receipts');
  check(bob.store.allMessages().length === 2 * count, `${count} more delivered once each`);

  check(
    !frames.some((frame) => containsMarker(frame, MARKER)),
    `no plaintext in ${frames.length} captured WebSocket frames`,
  );
  if (commandsBefore !== undefined && commandsAfter !== undefined) {
    const used = commandsAfter - commandsBefore;
    console.log(
      `redis: ${used} commands for ${count} offline messages and their receipts: ${(used / count).toFixed(1)} per message`,
    );
  }
  await alice.stop();
  await bob.stop();
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`sim-client failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
