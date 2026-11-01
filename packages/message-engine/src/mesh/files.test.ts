/**
 * Files over the mesh (Phase 24, ADR 0027; REQ §19.3 last bullet): real engines and real
 * attachment encryption, in airplane mode. A and C are contacts, B relays. The manifest goes
 * as a message; the ciphertext goes as signed MESH_CHUNKs, resumed across link drops; C checks
 * the whole file before it sends the delivery receipt.
 */
import { randomBytes } from 'node:crypto';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildManifest, encryptStream } from '@pingdost/attachments';
import { createWasmCryptoProvider, type CryptoProvider } from '@pingdost/crypto';
import { uuidv7 } from '@pingdost/protocol';

import { eventually } from '../testing';
import { MeshSim, type SimPhone } from './sim';

let crypto: CryptoProvider;
let sim: MeshSim;

beforeAll(async () => {
  crypto = await createWasmCryptoProvider();
});

afterEach(async () => {
  await sim.stop();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Byte equality without vitest's element-by-element diff (slow for megabytes). */
const same = (a: Uint8Array | undefined, b: Uint8Array) =>
  a !== undefined && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b));

/** One piece, as an async stream (what `encryptStream` reads). */
async function* once(bytes: Uint8Array) {
  await Promise.resolve();
  yield bytes;
}

async function encrypt(size: number) {
  const plaintext = new Uint8Array(randomBytes(size));
  const chunks: Uint8Array[] = [];
  const stream = encryptStream(crypto, once(plaintext));
  let next = await stream.next();
  while (!next.done) {
    chunks.push(next.value);
    next = await stream.next();
  }
  return { chunks, encrypted: next.value };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** What the app does to send a file with no Internet: a `mesh` manifest, then the chunks. */
async function sendFile(from: SimPhone, to: SimPhone, size: number) {
  const { chunks, encrypted } = await encrypt(size);
  const attachmentId = uuidv7();
  const manifest = buildManifest({
    attachmentId,
    encrypted,
    mimeType: 'application/pdf',
    fileName: 'report.pdf',
    mesh: true,
  });
  const conversation = await from.client.engine.openDirectConversation(to.client.userId);
  const message = await from.client.engine.sendAttachment(conversation.conversationId, manifest);
  const now = Date.now();
  from.nearby.mesh!.sendFile({
    transferId: attachmentId,
    recipientDeviceId: to.client.deviceId,
    count: chunks.length,
    createdAt: now,
    expiresAt: now + 3_600_000,
    read: (index) => Promise.resolve(chunks[index]!),
  });
  return { message, chunks, attachmentId, ciphertext: concat(chunks) };
}

const stateOf = async (p: SimPhone, messageId: string) =>
  (await p.client.engine.getMessage(messageId))?.state;
const heldBy = (p: SimPhone, attachmentId: string) => p.receiver!.status(attachmentId)?.held ?? 0;
const chunksAt = (p: SimPhone) =>
  [...p.persistence.packets.values()].filter((e) => e.meta.kind === 'chunk');
const receiptQueued = async (p: SimPhone, messageId: string) =>
  (await p.client.store.listOutbox()).some(
    (item) => item.type === 'receipt' && item.messageId === messageId,
  );

async function triangle(relay: Parameters<MeshSim['phone']>[1] = {}) {
  sim = new MeshSim(crypto);
  const a = await sim.phone('A');
  const b = await sim.phone('B', { relaying: true, ...relay });
  const c = await sim.phone('C', { files: true });
  await sim.introduce(a, c);
  await sim.airplane();
  return { a, b, c };
}

describe('files over the mesh', () => {
  it('carries a 10 MB file A → B → C through link drops, resumes, and confirms only once verified', async () => {
    const { a, b, c } = await triangle();
    const file = await sendFile(a, c, 10 * 1_048_576);
    const count = file.chunks.length;
    expect(count).toBe(161);

    // A and B meet twice; the second time A sends only what B lacks.
    sim.meet(a, b);
    await eventually(() => chunksAt(b).length >= 40, 20_000, 'B has some chunks');
    sim.part(a, b);
    const first = chunksAt(b).length;
    expect(first).toBeLessThan(count);
    sim.meet(a, b);
    await eventually(() => chunksAt(b).length === count, 30_000, 'B has every chunk');
    sim.part(a, b);

    // B meets C, the link drops halfway, then comes back.
    sim.meet(b, c);
    await eventually(() => heldBy(c, file.attachmentId) >= 60, 20_000, 'C has part of it');
    sim.part(b, c);
    const partial = heldBy(c, file.attachmentId);
    expect(partial).toBeLessThan(count);
    // Not verified yet: no delivery receipt, and A shows it only as forwarded.
    expect(await receiptQueued(c, file.message.messageId)).toBe(false);
    expect(await stateOf(a, file.message.messageId)).toBe('relayed');

    sim.meet(b, c);
    await eventually(() => c.files.has(file.attachmentId), 30_000, 'C assembled and verified it');
    expect(same(c.files.get(file.attachmentId), file.ciphertext)).toBe(true);
    // The receipt is out now; it rides back C → B → A.
    await eventually(
      () => [...b.persistence.packets.values()].some((e) => e.meta.kind !== 'chunk'),
      10_000,
      'B carries the receipt',
    );
    // C's complete transfer made B drop every leftover chunk of it.
    await eventually(() => chunksAt(b).length === 0, 10_000, 'B dropped the chunks');
    sim.part(b, c);
    sim.meet(a, b);
    await eventually(
      async () => (await stateOf(a, file.message.messageId)) === 'delivered_to_recipient_device',
      15_000,
      'delivered after full verification',
    );
    expect(sim.server.accepted.length).toBe(0);
  }, 120_000);

  it('refuses a corrupt chunk at C and gets the missing one again from A', async () => {
    const { a, b, c } = await triangle();
    const file = await sendFile(a, c, 300_000);
    const count = file.chunks.length;
    sim.meet(a, b);
    await eventually(() => chunksAt(b).length === count, 15_000, 'B has every chunk');
    sim.part(a, b);

    // B's copy of one chunk is damaged (a byte inside its data).
    const damaged = chunksAt(b)[0]!;
    const payload = damaged.payload.slice();
    payload[200] = payload[200]! ^ 0xff;
    damaged.payload = payload;

    sim.meet(b, c);
    await eventually(() => heldBy(c, file.attachmentId) === count - 1, 15_000, 'all but one');
    await sleep(300);
    expect(c.log.some((l) => l.includes('corrupt'))).toBe(true);
    expect(c.files.has(file.attachmentId)).toBe(false);
    expect(await receiptQueued(c, file.message.messageId)).toBe(false);
    sim.part(b, c);

    // A meets C directly: C's summary says what is missing; A sends just that.
    sim.meet(a, c);
    await eventually(() => c.files.has(file.attachmentId), 15_000, 'completed from A');
    expect(same(c.files.get(file.attachmentId), file.ciphertext)).toBe(true);
    await eventually(
      async () => (await stateOf(a, file.message.messageId)) === 'delivered_to_recipient_device',
      10_000,
      'the receipt comes straight back',
    );
  }, 60_000);

  it('keeps chunks within the relay quota, and the file still arrives directly', async () => {
    const quota = 5 * 66_000;
    const { a, b, c } = await triangle({ policy: { perOriginMaxChunkBytes: quota } });
    const file = await sendFile(a, c, 1_000_000);
    sim.meet(a, b);
    await eventually(() => chunksAt(b).length >= 4, 15_000, 'B takes some');
    await sleep(800);
    const bytes = chunksAt(b).reduce((n, e) => n + e.meta.size, 0);
    expect(bytes).toBeLessThanOrEqual(quota);
    expect(chunksAt(b).length).toBeLessThan(file.chunks.length);
    expect(b.log.some((l) => l.includes('origin_quota'))).toBe(true);
    sim.part(a, b);

    sim.meet(a, c);
    await eventually(() => c.files.has(file.attachmentId), 20_000, 'direct transfer completes');
    expect(same(c.files.get(file.attachmentId), file.ciphertext)).toBe(true);
  }, 60_000);

  it('pauses and cancels on the receiving side', async () => {
    const { a, c } = await triangle();
    const file = await sendFile(a, c, 400_000);
    c.receiver!.pause(file.attachmentId);
    sim.meet(a, c);
    await sleep(800);
    expect(heldBy(c, file.attachmentId)).toBe(0);
    c.receiver!.resume(file.attachmentId);
    sim.part(a, c);
    sim.meet(a, c);
    await eventually(() => c.files.has(file.attachmentId), 15_000, 'resumed and completed');

    const other = await sendFile(a, c, 400_000);
    await c.receiver!.cancel(other.attachmentId);
    sim.part(a, c);
    sim.meet(a, c);
    await sleep(800);
    expect(c.files.has(other.attachmentId)).toBe(false);
    expect(c.chunks!.chunks.has(other.attachmentId)).toBe(false);
  }, 60_000);
});
