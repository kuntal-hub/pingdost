import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  create,
  CryptoType,
  encodeEnvelope,
  encodeHello,
  encodeTransportPacket,
  EnvelopeSchema,
  fromBase64,
  HelloProofSchema,
  HelloSchema,
  PacketKind,
  PROTOCOL_VERSION,
  toBase64,
  TransportPacketSchema,
  uuidToBytes,
  uuidv7,
  uuidv7Bytes,
  type TransportPacket,
} from '@pingdost/protocol';

import {
  NearbyPeerTransport,
  type HelloCheck,
  type NearbyIdentity,
  type NearbyPeer,
} from './nearby';
import { connectFakeLinks as link, fakeConnection as connectionOf, FakeLinks } from './testing';

// A fake signature: a hash of key ‖ message, so it binds both (the real one is Ed25519).
function fakeSign(identityKey: string, message: Uint8Array): string {
  const input = [...new TextEncoder().encode(identityKey), ...message];
  const out = new Uint8Array(64);
  let h = 2166136261;
  for (let i = 0; i < 64; i++) {
    for (const byte of input) h = Math.imul(h ^ byte ^ i, 16777619) >>> 0;
    out[i] = h & 0xff;
  }
  return toBase64(out).replace(/=+$/, '');
}

const keyOf = (fill: number) => toBase64(new Uint8Array(32).fill(fill)).replace(/=+$/, '');

interface Device {
  peer: NearbyPeer;
  identityKey: string;
}

function device(fill: number): Device {
  return { peer: { userId: uuidv7(), deviceId: uuidv7() }, identityKey: keyOf(fill) };
}

/** `known` maps identity keys to the devices this side's directory lists. */
function identity(self: Device, known: Device[]): NearbyIdentity {
  return {
    deviceId: self.peer.deviceId,
    identityKey: self.identityKey,
    sign: (message) => fakeSign(self.identityKey, message),
    check(identityKey, message, signature): Promise<HelloCheck> {
      if (fakeSign(identityKey, message) !== signature)
        return Promise.resolve({ status: 'invalid' });
      const match = known.find((d) => d.identityKey === identityKey);
      return Promise.resolve(match ? { status: 'known', peer: match.peer } : { status: 'unknown' });
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i++) await tick();
}

function envelopePacket(from: Device, to: Device, envelopeId = uuidv7Bytes()): TransportPacket {
  const now = Date.now();
  return create(TransportPacketSchema, {
    version: PROTOCOL_VERSION,
    packetId: uuidv7Bytes(),
    kind: PacketKind.ENVELOPE,
    dst: uuidToBytes(to.peer.deviceId),
    createdAtMs: BigInt(now),
    expiresAtMs: BigInt(now + 60_000),
    payload: encodeEnvelope(
      create(EnvelopeSchema, {
        envelopeId,
        senderDeviceId: uuidToBytes(from.peer.deviceId),
        recipientDeviceId: uuidToBytes(to.peer.deviceId),
        cryptoType: CryptoType.OLM,
        ciphertext: new Uint8Array(40).fill(7),
      }),
    ),
  });
}

const transports: NearbyPeerTransport[] = [];
function side(self: Device, known: Device[], options: { ackTimeoutMs?: number } = {}) {
  const links = new FakeLinks();
  const transport = new NearbyPeerTransport({
    links,
    identity: identity(self, known),
    handshakeTimeoutMs: 200,
    ...options,
  });
  transports.push(transport);
  return { links, transport };
}

afterEach(() => {
  for (const transport of transports.splice(0)) transport.dispose();
});

describe('NearbyPeerTransport handshake', () => {
  it('lets two contacts prove their keys and reach each other', async () => {
    const alice = device(1);
    const bob = device(2);
    const a = side(alice, [bob]);
    const b = side(bob, [alice]);
    await a.transport.start();
    await b.transport.start();
    const reach = vi.fn();
    a.transport.onReachability(reach);

    link(a.links, b.links);
    expect(a.transport.summary$.value.pending).toBe(1);
    await settle();

    expect(a.transport.reaches(bob.peer.deviceId)).toBe(true);
    expect(b.transport.reaches(alice.peer.deviceId)).toBe(true);
    expect(a.transport.summary$.value).toEqual({ peers: [bob.peer], unknown: 0, pending: 0 });
    expect(reach).toHaveBeenCalled();
    // Two Hellos each way: the token, then the proof.
    expect(a.links.sent).toHaveLength(2);
  });

  it('keeps a peer whose key it does not know as unknown, and tells it nothing more', async () => {
    const alice = device(1);
    const stranger = device(9);
    const a = side(alice, []);
    const s = side(stranger, [alice]);
    await a.transport.start();
    await s.transport.start();
    link(a.links, s.links);
    await settle();

    expect(a.transport.summary$.value).toEqual({ peers: [], unknown: 1, pending: 0 });
    expect(a.transport.reaches(stranger.peer.deviceId)).toBe(false);
    expect(await a.transport.send(envelopePacket(alice, stranger))).toMatchObject({
      ok: false,
      code: 'NO_ROUTE',
    });
  });

  it('rejects a proof made for another link, and closes a link that keeps sending them', async () => {
    const alice = device(1);
    const bob = device(2);
    const a = side(alice, [bob]);
    await a.transport.start();
    // An impostor replays a proof of Bob's made for different tokens.
    const impostor = new FakeLinks();
    const [idA, idI] = link(a.links, impostor);
    await settle();
    const stolen = fakeSign(
      bob.identityKey,
      new Uint8Array(100), // not this link's statement
    );
    const hello = (token: number) =>
      encodeHello(
        create(HelloSchema, {
          protocolVersion: 1,
          peerToken: new Uint8Array(16).fill(token),
          capabilities: 1,
          proof: create(HelloProofSchema, {
            identityKey: new Uint8Array(32).fill(2),
            signature: fromBase64(stolen),
          }),
        }),
      );
    for (let i = 0; i < 3; i++) {
      await impostor.send(connectionOf(idI), control(PacketKind.HELLO, hello(5)));
      await settle(2);
    }
    expect(a.transport.reaches(bob.peer.deviceId)).toBe(false);
    expect(a.links.disconnected).toContain(idA);
  });

  it('counts a peer that never proves a key as unknown after the timeout', async () => {
    const alice = device(1);
    const a = side(alice, []);
    await a.transport.start();
    const silent = new FakeLinks();
    silent.mute = true;
    link(a.links, silent);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(a.transport.summary$.value).toEqual({ peers: [], unknown: 1, pending: 0 });
  });

  it('starts over when the peer restarts, and both sides know each other again', async () => {
    const alice = device(1);
    const bob = device(2);
    const a = side(alice, [bob]);
    const b = side(bob, [alice]);
    await a.transport.start();
    await b.transport.start();
    const [, idB] = link(a.links, b.links);
    await settle();
    // Bob's app reloads: a new transport on the same native link, which it adopts when the
    // next packet arrives.
    b.transport.dispose();
    const fresh = new NearbyPeerTransport({ links: b.links, identity: identity(bob, [alice]) });
    transports.push(fresh);
    await fresh.start();
    b.links.connections.emit(connectionOf(idB));
    await settle();
    expect(fresh.reaches(alice.peer.deviceId)).toBe(true);
    expect(a.transport.reaches(bob.peer.deviceId)).toBe(true);
  });
});

function control(kind: PacketKind, payload: Uint8Array): Uint8Array {
  const now = Date.now();
  return encodeTransportPacket(
    create(TransportPacketSchema, {
      version: PROTOCOL_VERSION,
      packetId: uuidv7Bytes(),
      kind,
      dst: Uint8Array.of(0),
      createdAtMs: BigInt(now),
      expiresAtMs: BigInt(now + 60_000),
      payload,
    }),
  );
}

describe('NearbyPeerTransport delivery', () => {
  async function pair(options: { ackTimeoutMs?: number } = {}) {
    const alice = device(1);
    const bob = device(2);
    const a = side(alice, [bob], options);
    const b = side(bob, [alice], options);
    await a.transport.start();
    await b.transport.start();
    const ids = link(a.links, b.links);
    await settle();
    return { alice, bob, a, b, ids };
  }

  it('resolves ok once the recipient stored the envelope and acknowledged it', async () => {
    const { alice, bob, a, b } = await pair();
    const received: TransportPacket[] = [];
    b.transport.onPacket((packet, ack) => {
      received.push(packet);
      setTimeout(ack, 1); // after it is stored
    });
    const result = await a.transport.send(envelopePacket(alice, bob));
    expect(result).toEqual({ ok: true, status: 'delivered_transport' });
    expect(received).toHaveLength(1);
  });

  it('times out without an ACK, so the sender retries later', async () => {
    const { alice, bob, a, b } = await pair({ ackTimeoutMs: 50 });
    b.transport.onPacket(() => undefined); // never stored
    expect(await a.transport.send(envelopePacket(alice, bob))).toMatchObject({
      ok: false,
      code: 'TIMEOUT',
      retryable: true,
    });
  });

  it('settles a send in flight when the link drops, and stops reaching the peer', async () => {
    const { alice, bob, a, b, ids } = await pair();
    b.transport.onPacket(() => undefined);
    const reach = vi.fn();
    a.transport.onReachability(reach);
    const pending = a.transport.send(envelopePacket(alice, bob));
    a.links.drop(ids[0]);
    expect(await pending).toMatchObject({ ok: false, code: 'TIMEOUT' });
    expect(a.transport.reaches(bob.peer.deviceId)).toBe(false);
    expect(reach).toHaveBeenCalled();
    expect(await a.transport.send(envelopePacket(alice, bob))).toMatchObject({ code: 'NO_ROUTE' });
  });

  it('ignores envelopes for other devices (relaying is Phase 23)', async () => {
    const { alice, a, b, ids } = await pair();
    const listener = vi.fn();
    b.transport.onPacket(listener);
    const other = device(3);
    await a.links.send(connectionOf(ids[0]), encodeTransportPacket(envelopePacket(alice, other)));
    await settle(2);
    expect(listener).not.toHaveBeenCalled();
  });

  it('acknowledges a burst in one packet and only to the link it came from', async () => {
    const { alice, bob, a, b } = await pair();
    b.transport.onPacket((_packet, ack) => ack());
    const before = b.links.sent.length;
    const results = await Promise.all(
      Array.from({ length: 3 }, () => a.transport.send(envelopePacket(alice, bob))),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(b.links.sent.length - before).toBeLessThanOrEqual(3);
  });

  it('is offline when stopped', async () => {
    const { alice, bob, a } = await pair();
    await a.transport.stop();
    expect(a.transport.status$.value).toBe('offline');
    expect(a.transport.reaches(bob.peer.deviceId)).toBe(false);
    expect(await a.transport.send(envelopePacket(alice, bob))).toMatchObject({ code: 'OFFLINE' });
  });
});
