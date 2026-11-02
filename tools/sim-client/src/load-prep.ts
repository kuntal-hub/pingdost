/**
 * Prepares a k6 load run (Phase 27, k6/README.md): registers `--pairs` pairs of real users with
 * a device each (through the API and Mailpit, like the other sim commands) and writes, per
 * pair, ready-made binary WebSocket frames: each side's Auth, `--messages` Send frames from A
 * to B with `--bytes` of random "ciphertext", B's matching Ack frames, and a Ping. k6 then
 * replays them and needs no protobuf code: it recognises replies by the 16-byte envelope IDs.
 *
 *   pnpm --filter @pingdost/sim-client load-prep -- --pairs 50 --messages 200 [--bytes 600]
 *     [--api http://127.0.0.1:3000] [--mailpit http://127.0.0.1:8025] [--out ../../k6/.data/load.json]
 *
 * Access tokens expire after ACCESS_TOKEN_TTL_SECONDS (15 min by default): run k6 soon after,
 * or raise the TTL on the server under test. The output holds tokens: it is git-ignored.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { createWasmCryptoProvider } from '@pingdost/crypto';
import {
  ClientFrameSchema,
  create,
  CryptoType,
  encodeClientFrame,
  encodeEnvelope,
  envelopeIdFor,
  EnvelopeSchema,
  PacketKind,
  PROTOCOL_VERSION,
  TransportPacketSchema,
  uuidToBytes,
  uuidv7Bytes,
  type MessageInitShape,
} from '@pingdost/protocol';

import { SimClient, type Endpoints } from './client';

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: 'http://127.0.0.1:3000' },
    ws: { type: 'string' },
    mailpit: { type: 'string', default: 'http://127.0.0.1:8025' },
    pairs: { type: 'string', default: '20' },
    messages: { type: 'string', default: '100' },
    bytes: { type: 'string', default: '600' },
    out: { type: 'string', default: '../../k6/.data/load.json' },
  },
});

const api = values.api.replace(/\/+$/, '');
const endpoints: Endpoints = {
  api,
  ws: values.ws ?? `${api.replace(/^http/, 'ws')}/v1/ws`,
  mailpit: values.mailpit,
};
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
type FrameInit = MessageInitShape<typeof ClientFrameSchema>;
const frame = (init: FrameInit) => encodeClientFrame(create(ClientFrameSchema, init));

function authFrame(accessToken: string): string {
  return b64(
    frame({
      requestId: 1,
      body: { case: 'auth', value: { accessToken, protocolVersion: PROTOCOL_VERSION } },
    }),
  );
}

async function main(): Promise<void> {
  const pairs = Number(values.pairs);
  const messages = Number(values.messages);
  const size = Number(values.bytes);
  const crypto = await createWasmCryptoProvider();
  const options = { endpoints, crypto };
  const now = Date.now();
  const out: unknown[] = [];

  console.log(`registering ${pairs} pairs against ${api} …`);
  for (let p = 0; p < pairs; p++) {
    const [a, b] = await Promise.all([SimClient.register(options), SimClient.register(options)]);
    const sends: string[] = [];
    const acks: string[] = [];
    const ids: string[] = [];
    for (let i = 0; i < messages; i++) {
      const envelopeId = envelopeIdFor(uuidv7Bytes(), uuidToBytes(b.deviceId));
      const envelope = create(EnvelopeSchema, {
        envelopeId,
        senderDeviceId: uuidToBytes(a.deviceId),
        recipientDeviceId: uuidToBytes(b.deviceId),
        cryptoType: CryptoType.OLM,
        ciphertext: new Uint8Array(randomBytes(size)),
      });
      const packet = create(TransportPacketSchema, {
        version: PROTOCOL_VERSION,
        packetId: uuidv7Bytes(),
        kind: PacketKind.ENVELOPE,
        dst: uuidToBytes(b.deviceId),
        createdAtMs: BigInt(now),
        expiresAtMs: BigInt(now + 86_400_000),
        hopBudget: 0,
        flags: 0,
        payload: encodeEnvelope(envelope),
      });
      sends.push(b64(frame({ requestId: i + 2, body: { case: 'send', value: { packet } } })));
      acks.push(
        b64(
          frame({
            requestId: 0,
            body: { case: 'ack', value: { envelopeIds: [envelopeId] } },
          }),
        ),
      );
      ids.push(b64(envelopeId));
    }
    out.push({
      a: { auth: authFrame(a.accessToken) },
      b: { auth: authFrame(b.accessToken) },
      envelopeIds: ids,
      sends,
      acks,
    });
    if ((p + 1) % 10 === 0) console.log(`  ${p + 1}/${pairs}`);
  }
  const ping = b64(frame({ requestId: 0, body: { case: 'ping', value: { nonce: 1 } } }));
  const file = resolve(values.out);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({ ws: endpoints.ws, createdAt: new Date(now).toISOString(), ping, pairs: out }),
  );
  console.log(`wrote ${file} (${pairs} pairs × ${messages} messages of ${size} B)`);
}

await main();
