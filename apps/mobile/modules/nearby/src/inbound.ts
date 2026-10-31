// The native inbound queue hands packets over in batches (`PingdostNearby.receive`): repeated
// `linkId u32 | length u32 | bytes`, big-endian. One crossing per batch, not per packet.

export interface InboundPacket {
  linkId: number;
  data: Uint8Array;
}

/** Splits a batch. The packets are views into the batch, not copies. */
export function parseInbound(batch: Uint8Array): InboundPacket[] {
  const view = new DataView(batch.buffer, batch.byteOffset, batch.byteLength);
  const packets: InboundPacket[] = [];
  let at = 0;
  while (at < batch.length) {
    if (at + 8 > batch.length) throw new Error('nearby batch is truncated');
    const linkId = view.getUint32(at);
    const start = at + 8;
    const end = start + view.getUint32(at + 4);
    if (end > batch.length) throw new Error('nearby batch is truncated');
    packets.push({ linkId, data: batch.subarray(start, end) });
    at = end;
  }
  return packets;
}

/** Builds a batch (the native side's format), for tests and fakes. */
export function encodeInbound(packets: readonly InboundPacket[]): Uint8Array {
  const out = new Uint8Array(packets.reduce((sum, packet) => sum + 8 + packet.data.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const packet of packets) {
    view.setUint32(at, packet.linkId);
    view.setUint32(at + 4, packet.data.length);
    out.set(packet.data, at + 8);
    at += 8 + packet.data.length;
  }
  return out;
}
