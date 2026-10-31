// The nearby dev screen's test packets (Phase 21 measurements only; not a product format and
// never sent outside the dev screen). First byte = kind; integers big-endian.
//   text        0x01 | UTF-8
//   ping/pong   0x02/0x03 | seq u32 | sentAt f64 (sender's clock; a pong echoes it)
//   bulk        0x10 | runId u32 | index u32 | filler
//   bulkEnd     0x11 | runId u32 | packets u32 | bytes u32
//   bulkResult  0x12 | runId u32 | packets u32 | bytes u32 | receiverMs f64

export type BenchPacket =
  | { kind: 'text'; text: string }
  | { kind: 'ping' | 'pong'; seq: number; sentAt: number }
  | { kind: 'bulk'; runId: number; index: number; size: number }
  | { kind: 'bulkEnd'; runId: number; packets: number; bytes: number }
  | { kind: 'bulkResult'; runId: number; packets: number; bytes: number; receiverMs: number }
  | { kind: 'unknown' };

const TEXT = 0x01;
const PING = 0x02;
const PONG = 0x03;
const BULK = 0x10;
const BULK_END = 0x11;
const BULK_RESULT = 0x12;

/** Bulk packets carry at least their 9-byte header. */
export const BULK_HEADER = 9;

function packet(kind: number, size: number): [Uint8Array, DataView] {
  const out = new Uint8Array(size);
  out[0] = kind;
  return [out, new DataView(out.buffer)];
}

export function encodeText(text: string): Uint8Array {
  const body = new TextEncoder().encode(text);
  const [out] = packet(TEXT, 1 + body.length);
  out.set(body, 1);
  return out;
}

export function encodePing(kind: 'ping' | 'pong', seq: number, sentAt: number): Uint8Array {
  const [out, view] = packet(kind === 'ping' ? PING : PONG, 13);
  view.setUint32(1, seq);
  view.setFloat64(5, sentAt);
  return out;
}

export function encodeBulk(runId: number, index: number, size: number): Uint8Array {
  const [out, view] = packet(BULK, Math.max(BULK_HEADER, size));
  view.setUint32(1, runId);
  view.setUint32(5, index);
  // Non-zero filler, so nothing on the way can shortcut runs of zeros.
  for (let i = BULK_HEADER; i < out.length; i++) out[i] = (i * 31 + index) & 0xff;
  return out;
}

export function encodeBulkEnd(runId: number, packets: number, bytes: number): Uint8Array {
  const [out, view] = packet(BULK_END, 13);
  view.setUint32(1, runId);
  view.setUint32(5, packets);
  view.setUint32(9, bytes);
  return out;
}

export function encodeBulkResult(
  runId: number,
  packets: number,
  bytes: number,
  receiverMs: number,
): Uint8Array {
  const [out, view] = packet(BULK_RESULT, 21);
  view.setUint32(1, runId);
  view.setUint32(5, packets);
  view.setUint32(9, bytes);
  view.setFloat64(13, receiverMs);
  return out;
}

export function decodeBench(data: Uint8Array): BenchPacket {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const kind = data[0];
  if (kind === TEXT) return { kind: 'text', text: new TextDecoder().decode(data.subarray(1)) };
  if ((kind === PING || kind === PONG) && data.length === 13) {
    return {
      kind: kind === PING ? 'ping' : 'pong',
      seq: view.getUint32(1),
      sentAt: view.getFloat64(5),
    };
  }
  if (kind === BULK && data.length >= BULK_HEADER) {
    return { kind: 'bulk', runId: view.getUint32(1), index: view.getUint32(5), size: data.length };
  }
  if (kind === BULK_END && data.length === 13) {
    return {
      kind: 'bulkEnd',
      runId: view.getUint32(1),
      packets: view.getUint32(5),
      bytes: view.getUint32(9),
    };
  }
  if (kind === BULK_RESULT && data.length === 21) {
    return {
      kind: 'bulkResult',
      runId: view.getUint32(1),
      packets: view.getUint32(5),
      bytes: view.getUint32(9),
      receiverMs: view.getFloat64(13),
    };
  }
  return { kind: 'unknown' };
}

/** The receiving side of bulk runs: counts per run, timed from the first packet to the end. */
export class BulkReceiver {
  private readonly runs = new Map<number, { firstAt: number; packets: number; bytes: number }>();

  onBulk(runId: number, size: number, now: number) {
    const run = this.runs.get(runId) ?? { firstAt: now, packets: 0, bytes: 0 };
    run.packets++;
    run.bytes += size;
    this.runs.set(runId, run);
  }

  /** The result to send back, or null for an unknown run. */
  onEnd(runId: number, now: number): { packets: number; bytes: number; receiverMs: number } | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    this.runs.delete(runId);
    return { packets: run.packets, bytes: run.bytes, receiverMs: now - run.firstAt };
  }
}

/** Sends `totalBytes` as bulk packets of `packetBytes` (waiting on backpressure), then the end. */
export async function sendBulk(
  send: (packet: Uint8Array) => Promise<void>,
  runId: number,
  totalBytes: number,
  packetBytes: number,
): Promise<{ packets: number; bytes: number }> {
  let bytes = 0;
  let index = 0;
  while (bytes < totalBytes) {
    const size = Math.min(packetBytes, Math.max(BULK_HEADER, totalBytes - bytes));
    await send(encodeBulk(runId, index++, size));
    bytes += size;
  }
  await send(encodeBulkEnd(runId, index, bytes));
  return { packets: index, bytes };
}

/** Kilobytes (1000 bytes) per second. */
export function kbPerSecond(bytes: number, ms: number): number {
  return ms > 0 ? bytes / ms : 0;
}

export interface PingStats {
  sent: number;
  received: number;
  lastMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  totalMs: number;
}

export const emptyPingStats: PingStats = {
  sent: 0,
  received: 0,
  lastMs: null,
  minMs: null,
  maxMs: null,
  totalMs: 0,
};

export function addPong(stats: PingStats, rttMs: number): PingStats {
  return {
    ...stats,
    received: stats.received + 1,
    lastMs: rttMs,
    minMs: stats.minMs === null ? rttMs : Math.min(stats.minMs, rttMs),
    maxMs: stats.maxMs === null ? rttMs : Math.max(stats.maxMs, rttMs),
    totalMs: stats.totalMs + rttMs,
  };
}
