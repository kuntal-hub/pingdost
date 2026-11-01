/**
 * The mesh relay end to end (Phase 23, ADR 0025; REQ §19.1 bullet 3, §19.4): virtual phones
 * with real vodozemac, the real router, nearby transport and relay, in airplane mode, moved in
 * and out of each other's range. A and C are contacts; B and D are strangers who relay.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createWasmCryptoProvider, type CryptoProvider } from '@pingdost/crypto';
import { MemoryMeshPersistence } from '@pingdost/mesh-protocol';
import { decodeMeshEnvelope, uuidToBytes } from '@pingdost/protocol';

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

const MARKER = 'mesh-plaintext-marker-7f3a';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function send(from: SimPhone, to: SimPhone, text: string) {
  const conversation = await from.client.engine.openDirectConversation(to.client.userId);
  return from.client.engine.sendText(conversation.conversationId, text);
}

const stateOf = async (p: SimPhone, messageId: string) =>
  (await p.client.engine.getMessage(messageId))?.state;
const textsOf = (p: SimPhone) =>
  p.client.store
    .allMessages()
    .filter((m) => m.kind === 'text')
    .map((m) => m.body);

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** A and C are contacts (both cached each other online once); B relays; all in airplane mode. */
async function triangle(options: Parameters<MeshSim['phone']>[1] = {}) {
  sim = new MeshSim(crypto);
  const a = await sim.phone('A');
  const b = await sim.phone('B', { relaying: true, ...options });
  const c = await sim.phone('C');
  await sim.introduce(a, c);
  await sim.airplane();
  return { a, b, c };
}

describe('mesh relay', () => {
  it('carries A → B → C while A and C are never in range; C decrypts, and the receipt comes back', async () => {
    const { a, b, c } = await triangle();
    const message = await send(a, c, `hello through the mesh ${MARKER}`);
    await eventually(
      async () => (await stateOf(a, message.messageId)) === 'waiting_for_nearby_route',
      3_000,
      'queued on this device',
    );
    expect(sim.meshOf(a).own).toBe(1);

    sim.meet(a, b);
    await eventually(
      async () => (await stateOf(a, message.messageId)) === 'relayed',
      5_000,
      'B accepted it: relayed, not delivered',
    );
    const info = await a.client.engine.messageInfo(message.messageId);
    expect(info?.deliveries).toEqual([
      expect.objectContaining({
        deviceId: c.client.deviceId,
        state: 'relayed',
        via: 'mesh',
        relays: 1,
      }),
    ]);
    expect(sim.meshOf(b).stored.packets).toBe(1);
    sim.part(a, b);

    sim.meet(b, c);
    await eventually(() => textsOf(c).some((t) => t.includes(MARKER)), 5_000, 'C decrypts');
    await eventually(() => sim.meshOf(b).handedOver === 1, 3_000, 'B handed it over');
    // C's receipt goes back the same way: into C's mesh, to B, then to A.
    await eventually(() => sim.meshOf(b).stored.packets === 1, 5_000, 'B carries the receipt');
    sim.part(b, c);
    expect(await stateOf(a, message.messageId)).toBe('relayed');

    sim.meet(a, b);
    await eventually(
      async () => (await stateOf(a, message.messageId)) === 'delivered_to_recipient_device',
      5_000,
      'delivered only after C’s E2EE receipt',
    );
    // A's mesh copy is withdrawn once the receipt settled it.
    await eventually(() => sim.meshOf(a).own === 0, 3_000, 'A dropped its copy');
    expect(textsOf(c).filter((t) => t.includes(MARKER))).toHaveLength(1);
    expect(sim.server.accepted.length).toBe(0);
  });

  it('gives B ciphertext only: no plaintext, no device IDs, and B cannot open it', async () => {
    const { a, b, c } = await triangle();
    await send(a, c, `secret ${MARKER}`);
    sim.meet(a, b);
    await eventually(() => sim.meshOf(b).stored.packets === 1, 5_000, 'B carries it');

    const [stored] = [...b.persistence.packets.values()];
    const marker = new TextEncoder().encode(MARKER);
    expect(contains(stored!.payload, marker)).toBe(false);
    for (const deviceId of [a.client.deviceId, c.client.deviceId]) {
      expect(contains(stored!.payload, uuidToBytes(deviceId))).toBe(false);
    }
    expect(b.client.store.allMessages()).toEqual([]);
    // B holds no key for it: its own account cannot open the pre-key message meant for C.
    const { ciphertext } = decodeMeshEnvelope(stored!.payload);
    expect(() =>
      b.client.account.createInboundSession(a.client.account.identityKeys().curve25519, {
        type: 'prekey',
        body: ciphertext,
      }),
    ).toThrow();
  });

  it('detects tampering at B: C refuses changed ciphertext or a changed header, and opens an intact copy', async () => {
    const { a, b, c } = await triangle();
    const d = await sim.phone('D', { relaying: true });
    await send(a, c, `tamper ${MARKER}`);
    sim.meet(a, b);
    await eventually(() => sim.meshOf(b).stored.packets === 1, 5_000, 'B carries it');
    sim.part(a, b);

    // B flips one ciphertext byte in its relay store.
    const [entry] = [...b.persistence.packets.values()];
    const payload = entry!.payload.slice();
    payload[payload.length - 70] = payload[payload.length - 70]! ^ 0x01;
    entry!.payload = payload;
    sim.meet(b, c);
    await eventually(() => c.log.includes('mesh packet failed its check'), 5_000, 'C refuses it');
    expect(textsOf(c)).toEqual([]);
    sim.part(b, c);

    // An intact copy from another relay still gets through: refusal did not mark it seen.
    sim.meet(a, d);
    await eventually(() => sim.meshOf(d).stored.packets === 1, 5_000, 'D carries it');
    sim.part(a, d);
    // A relay that stretches the expiry (a signed field), from its store at start-up.
    const [dEntry] = [...d.persistence.packets.values()];
    const forged = new MemoryMeshPersistence();
    await forged.putPacket(
      { ...dEntry!.meta, expiresAt: dEntry!.meta.expiresAt + 60_000 },
      dEntry!.payload,
    );
    const d2 = await sim.phone('D2', { relaying: true, persistence: forged });
    sim.meet(d2, c);
    await eventually(
      () => c.log.filter((l) => l === 'mesh packet failed its check').length === 2,
      5_000,
      'a changed expiry fails too',
    );
    expect(textsOf(c)).toEqual([]);
    sim.part(d2, c);

    // D's own copy is intact: C opens it, since refusals did not mark the packet seen.
    sim.meet(d, c);
    await eventually(() => textsOf(c).some((t) => t.includes(MARKER)), 5_000, 'intact copy opens');
  }, 30_000);

  it('counts two relays, and duplicate encounters and the Internet create no duplicates', async () => {
    const { a, b, c } = await triangle();
    const d = await sim.phone('D', { relaying: true });
    await d.nearby.start();
    const message = await send(a, c, `twice ${MARKER}`);
    sim.meet(a, b);
    sim.meet(a, d);
    await eventually(
      async () =>
        (await a.client.engine.messageInfo(message.messageId))?.deliveries[0]?.relays === 2,
      5_000,
      'Forwarded by 2 devices',
    );
    expect(await stateOf(a, message.messageId)).toBe('relayed');
    sim.part(a, b);
    sim.part(a, d);

    // C meets both relays, one after the other, and B twice.
    await sim.run([
      { at: 0, meet: [b, c] },
      { at: 400, part: [b, c] },
      { at: 450, meet: [d, c] },
      { at: 850, part: [d, c] },
      { at: 900, meet: [b, c] },
      { at: 1_300, part: [b, c] },
    ]);
    await eventually(() => textsOf(c).some((t) => t.includes(MARKER)), 5_000, 'C has it');
    expect(textsOf(c).filter((t) => t.includes(MARKER))).toHaveLength(1);
    expect(sim.meshOf(d).stored.packets + sim.meshOf(b).stored.packets).toBeLessThanOrEqual(2);

    // The Internet comes back: A sends the same envelope through the server; C drops it.
    sim.internet(a, c);
    await eventually(
      async () => (await stateOf(a, message.messageId)) === 'delivered_to_recipient_device',
      5_000,
      'the receipt settles it',
    );
    await sleep(200);
    expect(textsOf(c).filter((t) => t.includes(MARKER))).toHaveLength(1);
  });

  it('drops expired and over-hop packets: a relay at hop 0 delivers but does not pass it on', async () => {
    sim = new MeshSim(crypto);
    const a = await sim.phone('A', { policy: { maxHops: 1 } });
    const b = await sim.phone('B', { relaying: true });
    const d = await sim.phone('D', { relaying: true });
    const c = await sim.phone('C');
    const late = await sim.phone('L', { relaying: true, policy: { maxHops: 8 } });
    await sim.introduce(a, c);
    await sim.airplane();
    await send(a, c, `one hop ${MARKER}`);
    sim.meet(a, b);
    await eventually(() => sim.meshOf(b).stored.packets === 1, 5_000, 'B at hop 0');
    sim.part(a, b);
    sim.meet(b, d);
    await sleep(500);
    expect(sim.meshOf(d).stored.packets).toBe(0); // out of hops for relays
    sim.part(b, d);
    sim.meet(b, c);
    await eventually(() => textsOf(c).some((t) => t.includes(MARKER)), 5_000, 'still delivered');
    sim.part(b, c);

    // Over budget: a sender claiming more hops than a relay allows is refused.
    const greedy = await sim.phone('G', { policy: { maxHops: 9 } });
    await sim.introduce(greedy, c);
    await sim.airplane();
    await send(greedy, c, 'too many hops');
    sim.meet(greedy, late);
    await eventually(
      () => late.log.some((l) => l.includes('over_budget')),
      5_000,
      'refused as over budget',
    );
    expect(sim.meshOf(late).stored.packets).toBe(0);
    sim.part(greedy, late);

    // Expired: a relayed packet past its expiry is neither handed over nor taken.
    const brief = await sim.phone('S', { policy: { ttlMs: 400 } });
    await sim.introduce(brief, c);
    await sim.airplane();
    await send(brief, c, `brief ${MARKER}`);
    sim.meet(brief, d);
    await eventually(() => sim.meshOf(d).stored.packets === 1, 5_000, 'D carries the brief one');
    sim.part(brief, d);
    await sleep(500);
    sim.meet(d, c);
    await sleep(600);
    expect(textsOf(c).filter((t) => t.startsWith('brief'))).toEqual([]);
  });

  it('forwards nothing while relaying is off, and stops at once when it is turned off', async () => {
    sim = new MeshSim(crypto);
    const a = await sim.phone('A');
    const b = await sim.phone('B', { relaying: false });
    const c = await sim.phone('C');
    await sim.introduce(a, c);
    await sim.airplane();
    const message = await send(a, c, `no relay ${MARKER}`);
    sim.meet(a, b);
    await sleep(600);
    expect(sim.meshOf(b).stored.packets).toBe(0);
    expect(await stateOf(a, message.messageId)).toBe('waiting_for_nearby_route');
    sim.part(a, b);

    // On (new links advertise it): B takes it. Then off: B hands nothing on, at once.
    b.nearby.mesh!.setRelaying(true);
    sim.meet(a, b);
    await eventually(() => sim.meshOf(b).stored.packets === 1, 5_000, 'B carries it once on');
    sim.part(a, b);
    b.nearby.mesh!.setRelaying(false);
    sim.meet(b, c);
    await sleep(600);
    expect(textsOf(c)).toEqual([]);
    expect(sim.meshOf(b).stored.packets).toBe(1); // kept until it expires or is cleared
    await b.nearby.mesh!.clear();
    expect(sim.meshOf(b).stored).toEqual({ packets: 0, bytes: 0 });
    expect(b.client.store.allMessages()).toEqual([]);
  });

  it('enforces the storage cap and the per-origin quota', async () => {
    const { a, b, c } = await triangle({ policy: { perOriginMaxPackets: 2 } });
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await send(a, c, `quota ${i}`)).messageId);
    sim.meet(a, b);
    await eventually(() => sim.meshOf(b).stored.packets === 2, 5_000, 'two taken');
    await sleep(500);
    expect(sim.meshOf(b).stored.packets).toBe(2);
    const states = await Promise.all(ids.map((id) => stateOf(a, id)));
    expect(states.filter((s) => s === 'relayed')).toHaveLength(2);
    expect(states.filter((s) => s === 'waiting_for_nearby_route')).toHaveLength(2);
    sim.part(a, b);

    // The byte cap: a relay with room for two and a half packets keeps the newest within it.
    const size = sim.meshOf(b).stored.bytes / 2;
    const limit = Math.floor(size * 2.5);
    const small = await sim.phone('T', { relaying: true, policy: { storageLimitBytes: limit } });
    sim.meet(a, small);
    await eventually(() => sim.meshOf(small).carried === 4, 5_000, 'T takes all four in turn');
    expect(sim.meshOf(small).stored.bytes).toBeLessThanOrEqual(limit);
    expect(sim.meshOf(small).stored.packets).toBe(2); // the oldest were evicted
  }, 20_000);

  it('rate-limits a spamming origin, and limits packet creation at the source', async () => {
    const { a, b, c } = await triangle({
      policy: { rates: { relayPerOrigin: { perMinute: 1, burst: 3 } } as never },
    });
    for (let i = 0; i < 6; i++) await send(a, c, `spam ${i}`);
    sim.meet(a, b);
    await eventually(() => sim.meshOf(b).stored.packets === 3, 5_000, 'three taken');
    await sleep(500);
    expect(sim.meshOf(b).stored.packets).toBe(3);
    sim.part(a, b);

    const limited = await sim.phone('R', {
      policy: { rates: { create: { perMinute: 1, burst: 2 } } as never },
    });
    await sim.introduce(limited, c);
    await sim.airplane();
    const sent = [];
    for (let i = 0; i < 3; i++) sent.push((await send(limited, c, `burst ${i}`)).messageId);
    await eventually(() => sim.meshOf(limited).own === 2, 3_000, 'two held');
    await sleep(300);
    expect(sim.meshOf(limited).own).toBe(2);
    // The third stays queued on the phone and is tried again later.
    expect(await stateOf(limited, sent[2]!)).not.toBe('relayed');
  });
});
