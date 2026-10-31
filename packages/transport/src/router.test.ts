import { describe, expect, it, vi } from 'vitest';

import {
  create,
  PacketKind,
  PROTOCOL_VERSION,
  TransportPacketSchema,
  uuidToBytes,
  uuidv7,
  uuidv7Bytes,
  type TransportPacket,
} from '@pingdost/protocol';

import { TransportRouter } from './router';
import { Listeners, ValueStream } from './stream';
import type {
  PacketListener,
  SendResult,
  Transport,
  TransportKind,
  TransportStatus,
} from './types';

class FakeTransport implements Transport {
  readonly status$ = new ValueStream<TransportStatus>('offline');
  readonly packets = new Listeners<Parameters<PacketListener>>();
  readonly reach = new Listeners<[]>();
  readonly sent: TransportPacket[] = [];
  readonly reachable = new Set<string>();
  result: SendResult = { ok: true, status: 'stored' };
  readonly reaches?: (deviceId: string) => boolean;
  readonly onReachability?: (listener: () => void) => () => void;

  constructor(readonly kind: TransportKind) {
    if (kind === 'nearby') {
      this.reaches = (deviceId) => this.reachable.has(deviceId);
      this.onReachability = (listener) => this.reach.add(listener);
    }
  }

  send(packet: TransportPacket): Promise<SendResult> {
    this.sent.push(packet);
    return Promise.resolve(this.result);
  }

  onPacket(listener: PacketListener) {
    return this.packets.add(listener);
  }

  /** A nearby peer proved it is `deviceId`, or left. */
  setReachable(deviceId: string, yes: boolean) {
    if (yes) this.reachable.add(deviceId);
    else this.reachable.delete(deviceId);
    this.reach.emit();
  }
}

function packetTo(deviceId: string): TransportPacket {
  const now = Date.now();
  return create(TransportPacketSchema, {
    version: PROTOCOL_VERSION,
    packetId: uuidv7Bytes(),
    kind: PacketKind.ENVELOPE,
    dst: uuidToBytes(deviceId),
    createdAtMs: BigInt(now),
    expiresAtMs: BigInt(now + 60_000),
    payload: new Uint8Array(10),
  });
}

function setup() {
  const internet = new FakeTransport('internet');
  const nearby = new FakeTransport('nearby');
  nearby.result = { ok: true, status: 'delivered_transport' };
  const router = new TransportRouter([internet, nearby]);
  return { internet, nearby, router, bob: uuidv7(), carol: uuidv7() };
}

describe('TransportRouter path selection', () => {
  it('prefers the Internet, even when the device is also in nearby range', async () => {
    const { internet, nearby, router, bob } = setup();
    internet.status$.set('online');
    nearby.status$.set('online');
    nearby.setReachable(bob, true);
    expect(router.route(bob)).toBe('internet');
    expect(await router.send(packetTo(bob))).toEqual({
      ok: true,
      status: 'stored',
      via: 'internet',
    });
    expect(nearby.sent).toHaveLength(0);
  });

  it('goes nearby when the Internet is down and the device is in range', async () => {
    const { nearby, router, bob } = setup();
    nearby.status$.set('online');
    nearby.setReachable(bob, true);
    expect(router.route(bob)).toBe('nearby');
    expect(await router.send(packetTo(bob))).toEqual({
      ok: true,
      status: 'delivered_transport',
      via: 'nearby',
    });
  });

  it('answers NO_ROUTE while only nearby is up and the device is out of range', async () => {
    const { nearby, router, bob, carol } = setup();
    nearby.status$.set('online');
    nearby.setReachable(carol, true);
    expect(router.route(bob)).toBe('unreachable');
    expect(await router.send(packetTo(bob))).toEqual({
      ok: false,
      code: 'NO_ROUTE',
      retryable: true,
    });
    expect(nearby.sent).toHaveLength(0);
  });

  it('answers OFFLINE when nothing is up', async () => {
    const { router, bob } = setup();
    expect(router.route(bob)).toBe('offline');
    expect(await router.send(packetTo(bob))).toMatchObject({ code: 'OFFLINE' });
    expect(router.status$.value).toBe('offline');
  });

  it('passes failures through without a path', async () => {
    const { internet, router, bob } = setup();
    internet.status$.set('online');
    internet.result = { ok: false, code: 'TIMEOUT', retryable: true };
    expect(await router.send(packetTo(bob))).toEqual(internet.result);
  });
});

describe('TransportRouter flushing', () => {
  it('tells the sender when a route may have appeared', () => {
    const { internet, nearby, router, bob } = setup();
    const changed = vi.fn();
    router.onRoutesChanged(changed);
    nearby.status$.set('online');
    nearby.setReachable(bob, true);
    internet.status$.set('online');
    expect(changed).toHaveBeenCalledTimes(3);
    router.dispose();
    nearby.setReachable(bob, false);
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it('is online while any transport is', () => {
    const { internet, nearby, router } = setup();
    nearby.status$.set('online');
    expect(router.status$.value).toBe('online');
    expect(router.online).toEqual(['nearby']);
    nearby.status$.set('offline');
    internet.status$.set('connecting');
    expect(router.status$.value).toBe('connecting');
  });

  it('hands packets from either path to the same listeners with their own ACK', () => {
    const { internet, nearby, router, bob } = setup();
    const seen: string[] = [];
    router.onPacket((_packet, ack) => ack());
    const ackInternet = vi.fn(() => seen.push('internet'));
    const ackNearby = vi.fn(() => seen.push('nearby'));
    internet.packets.emit(packetTo(bob), ackInternet);
    nearby.packets.emit(packetTo(bob), ackNearby);
    expect(seen).toEqual(['internet', 'nearby']);
  });
});
