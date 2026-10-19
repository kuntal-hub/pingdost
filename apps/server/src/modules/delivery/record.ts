/**
 * An envelope as the mailbox holds it: the sender's TransportPacket bytes, delivered
 * unchanged, plus the routing fields and the server's timestamps (REQ §16.3). The packet
 * carries only ciphertext; nothing here is plaintext.
 */
export interface EnvelopeRecord {
  /** Canonical UUID string. */
  envelopeId: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  /** The encoded TransportPacket. */
  packet: Uint8Array;
  /** Server receive time, epoch ms. */
  createdAt: number;
  /** Absolute expiry, epoch ms: set once and never extended. */
  expiresAt: number;
}

interface RedisForm {
  s: string;
  r: string;
  c: number;
  e: number;
  p: string;
}

export function encodeRecord(record: EnvelopeRecord): string {
  const form: RedisForm = {
    s: record.senderDeviceId,
    r: record.recipientDeviceId,
    c: record.createdAt,
    e: record.expiresAt,
    p: Buffer.from(record.packet).toString('base64'),
  };
  return JSON.stringify(form);
}

export function decodeRecord(envelopeId: string, value: string): EnvelopeRecord {
  const form = JSON.parse(value) as RedisForm;
  return {
    envelopeId,
    senderDeviceId: form.s,
    recipientDeviceId: form.r,
    createdAt: form.c,
    expiresAt: form.e,
    packet: new Uint8Array(Buffer.from(form.p, 'base64')),
  };
}
