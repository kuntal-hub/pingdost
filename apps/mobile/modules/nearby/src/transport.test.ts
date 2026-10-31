import { describe, expect, it, vi } from 'vitest';

import { encodeInbound, type InboundPacket } from './inbound';
import { createBleTransport } from './transport';
import type { LinkInfo, NearbyEvents, NearbyNative, NearbyState } from './types';

function link(id: number, address: string): LinkInfo {
  return {
    id,
    role: 'central',
    address,
    peerToken: 'ab',
    up: true,
    mtu: 517,
    txPhy: 2,
    rxPhy: 2,
    setupMs: 900,
    upAt: 1,
    packetsSent: 0,
    packetsReceived: 0,
    bytesSent: 0,
    bytesReceived: 0,
    framesSent: 0,
    framesReceived: 0,
    unsent: 0,
    outboundBytes: 0,
    sendCredits: 8,
  };
}

/** The native module's behaviour that the transport relies on, in memory. */
function fakeNative(initialLinks: LinkInfo[] = []) {
  const queue: InboundPacket[] = [];
  const listeners = new Map<keyof NearbyEvents, Set<(payload: never) => void>>();
  let receiveCalls = 0;
  const send = vi.fn<NearbyNative['send']>(() => Promise.resolve());
  const native: NearbyNative = {
    getState: () => Promise.resolve({ links: initialLinks } as NearbyState),
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    rotateToken: () => Promise.resolve('00'),
    connect: (address) => Promise.resolve(link(5, address)),
    disconnect: () => Promise.resolve(),
    send,
    // Batches of at most two packets, like a small `maxBytes`.
    receive: () => {
      receiveCalls++;
      return encodeInbound(queue.splice(0, 2));
    },
    startForegroundService: () => Promise.resolve(),
    stopForegroundService: () => Promise.resolve(),
    addListener(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return { remove: () => set.delete(listener) };
    },
  };
  const emit = <E extends keyof NearbyEvents>(event: E, payload: Parameters<NearbyEvents[E]>[0]) =>
    listeners.get(event)?.forEach((listener) => (listener as (p: typeof payload) => void)(payload));
  return { native, send, queue, emit, listeners, receives: () => receiveCalls };
}

const bytes = (...values: number[]) => new Uint8Array(values);

describe('createBleTransport', () => {
  it('drains the whole native queue on one packet event', async () => {
    const fake = fakeNative();
    const transport = createBleTransport(fake.native);
    await Promise.resolve();
    const got: { linkId: number; first: number }[] = [];
    transport.onPacket((data, from) => got.push({ linkId: from.linkId, first: data[0]! }));
    fake.emit('linkUp', link(3, 'AA:BB'));
    fake.queue.push(...[1, 2, 3, 4, 5].map((n) => ({ linkId: 3, data: bytes(n) })));
    const before = fake.receives();
    fake.emit('packet', { queued: 5 });
    expect(got).toEqual([1, 2, 3, 4, 5].map((first) => ({ linkId: 3, first })));
    // Three batches (2 + 2 + 1) and one empty read that ends the loop.
    expect(fake.receives() - before).toBe(4);
  });

  it('takes packets queued before it existed, for links already up', async () => {
    const fake = fakeNative([link(9, 'CC:DD')]);
    fake.queue.push({ linkId: 9, data: bytes(42) });
    const transport = createBleTransport(fake.native);
    const got: string[] = [];
    transport.onPacket((data, from) => got.push(`${from.peer.address}:${data[0]}`));
    await Promise.resolve();
    await Promise.resolve();
    expect(got).toEqual(['CC:DD:42']);
  });

  it('reports links that were up before it existed as new, so they handshake again', async () => {
    const fake = fakeNative([link(9, 'CC:DD')]);
    const transport = createBleTransport(fake.native);
    const seen: number[] = [];
    transport.onConnection((connection) => seen.push(connection.linkId));
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([9]);
  });

  it('keeps draining when a handler throws', async () => {
    const fake = fakeNative();
    const transport = createBleTransport(fake.native);
    await Promise.resolve();
    const reported: (() => void)[] = [];
    const spy = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => {
      reported.push(callback);
    });
    const got: number[] = [];
    transport.onPacket(() => {
      throw new Error('handler failed');
    });
    transport.onPacket((data) => got.push(data[0]!));
    fake.queue.push({ linkId: 1, data: bytes(1) }, { linkId: 1, data: bytes(2) });
    fake.emit('packet', { queued: 2 });
    spy.mockRestore();
    expect(got).toEqual([1, 2]);
    expect(reported).toHaveLength(2);
    expect(() => reported[0]!()).toThrow('handler failed');
  });

  it('maps connections and disconnects, and stops listening on dispose', async () => {
    const fake = fakeNative();
    const transport = createBleTransport(fake.native);
    const connection = await transport.connect({ address: 'EE:FF', token: null });
    expect(connection).toEqual({ linkId: 5, peer: { address: 'EE:FF', token: 'ab' }, mtu: 517 });
    await transport.send(connection, bytes(1));
    expect(fake.send).toHaveBeenCalledWith(5, bytes(1));

    const downs: number[] = [];
    transport.onDisconnect((event) => downs.push(event.id));
    fake.emit('linkDown', { id: 5, address: 'EE:FF', reason: 'timeout', unsent: 0 });
    expect(downs).toEqual([5]);

    transport.dispose();
    fake.emit('linkDown', { id: 6, address: 'x', reason: 'closed', unsent: 0 });
    expect(downs).toEqual([5]);
    expect([...fake.listeners.values()].every((set) => set.size === 0)).toBe(true);
  });
});
