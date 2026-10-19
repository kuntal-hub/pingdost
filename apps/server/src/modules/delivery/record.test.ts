import { describe, expect, it } from 'vitest';

import { ProtocolError } from '@pingdost/protocol';

import { decodeRecord, encodeRecord, type EnvelopeRecord } from './record';
import { protocolErrorCode } from './service';

describe('envelope records', () => {
  it('round-trip through the Redis form unchanged', () => {
    const record: EnvelopeRecord = {
      envelopeId: '01920000-0000-5000-8000-000000000001',
      senderDeviceId: '01920000-0000-7000-8000-000000000002',
      recipientDeviceId: '01920000-0000-7000-8000-000000000003',
      packet: new Uint8Array([0, 1, 2, 250, 255]),
      createdAt: 1_700_000_000_000,
      expiresAt: 1_701_209_600_000,
    };
    expect(decodeRecord(record.envelopeId, encodeRecord(record))).toEqual(record);
  });
});

describe('protocolErrorCode', () => {
  it('maps codec rejections to WS error codes', () => {
    const code = (kind: ProtocolError['code']) => protocolErrorCode(new ProtocolError(kind, 'x'));
    expect(code('OVERSIZED')).toBe('ENVELOPE_TOO_LARGE');
    expect(code('EXPIRED')).toBe('ENVELOPE_EXPIRED');
    expect(code('UNSUPPORTED_VERSION')).toBe('PROTOCOL_VERSION_UNSUPPORTED');
    expect(code('MALFORMED')).toBe('MALFORMED_FRAME');
    expect(code('MISSING_FIELD')).toBe('MALFORMED_FRAME');
  });
});
