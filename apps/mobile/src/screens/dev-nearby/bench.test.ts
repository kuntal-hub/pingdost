import { describe, expect, it } from 'vitest';

import {
  addPong,
  BulkReceiver,
  BULK_HEADER,
  decodeBench,
  emptyPingStats,
  encodeBulkResult,
  encodePing,
  encodeText,
  kbPerSecond,
  sendBulk,
} from './bench';

describe('nearby dev bench packets', () => {
  it('round-trips text, pings and results', () => {
    expect(decodeBench(encodeText('héllo 👋'))).toEqual({ kind: 'text', text: 'héllo 👋' });
    expect(decodeBench(encodePing('ping', 7, 1234.5))).toEqual({
      kind: 'ping',
      seq: 7,
      sentAt: 1234.5,
    });
    expect(decodeBench(encodePing('pong', 8, 99))).toEqual({ kind: 'pong', seq: 8, sentAt: 99 });
    expect(decodeBench(encodeBulkResult(3, 64, 1_000_000, 8123.25))).toEqual({
      kind: 'bulkResult',
      runId: 3,
      packets: 64,
      bytes: 1_000_000,
      receiverMs: 8123.25,
    });
    expect(decodeBench(new Uint8Array([0x7e]))).toEqual({ kind: 'unknown' });
    expect(decodeBench(new Uint8Array([0x02, 1]))).toEqual({ kind: 'unknown' });
  });

  it('sends a bulk run in packets with an exact total, and the receiver counts it', async () => {
    const sent: Uint8Array[] = [];
    const result = await sendBulk((p) => Promise.resolve(void sent.push(p)), 5, 100_000, 16_384);
    expect(result).toEqual({ packets: 7, bytes: 100_000 });
    expect(sent).toHaveLength(8);

    const receiver = new BulkReceiver();
    let now = 1000;
    for (const p of sent) {
      const decoded = decodeBench(p);
      if (decoded.kind === 'bulk') receiver.onBulk(decoded.runId, decoded.size, (now += 10));
      if (decoded.kind === 'bulkEnd') {
        expect(decoded).toEqual({ kind: 'bulkEnd', runId: 5, packets: 7, bytes: 100_000 });
        expect(receiver.onEnd(5, (now += 10))).toEqual({
          packets: 7,
          bytes: 100_000,
          receiverMs: 70,
        });
      }
    }
    expect(receiver.onEnd(5, now)).toBeNull();
  });

  it('never sends a bulk packet shorter than its header', async () => {
    const sizes: number[] = [];
    await sendBulk((p) => Promise.resolve(void sizes.push(p.length)), 1, 20, 16);
    expect(sizes.slice(0, -1)).toEqual([16, BULK_HEADER]);
  });

  it('computes rates and ping stats', () => {
    expect(kbPerSecond(1_000_000, 10_000)).toBe(100);
    expect(kbPerSecond(5, 0)).toBe(0);
    const stats = addPong(addPong({ ...emptyPingStats, sent: 2 }, 40), 20);
    expect(stats).toEqual({ sent: 2, received: 2, lastMs: 20, minMs: 20, maxMs: 40, totalMs: 60 });
  });
});
