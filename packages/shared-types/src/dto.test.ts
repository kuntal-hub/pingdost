import { describe, expect, it } from 'vitest';

import { EmailSchema, UsernameSchema } from './auth';
import { IdSchema, UnpaddedBase64Schema } from './common';
import { RegisterDeviceRequestSchema } from './devices';
import { ERROR_STATUS, ErrorCode, ErrorCodeSchema, errorCodeForStatus } from './errors';
import { PageQuerySchema, pageSchema } from './pagination';
import { ProblemSchema, problemType } from './problem';

const DEVICE_ID = '0192f1a0-0000-7000-8000-0000000000b2';
const KEY = 'A'.repeat(43);

describe('common schemas', () => {
  it('accepts UUIDv7 IDs and normalizes them to lowercase', () => {
    expect(IdSchema.parse(DEVICE_ID.toUpperCase())).toBe(DEVICE_ID);
    expect(IdSchema.safeParse('3b241101-e2bb-4255-8caf-4136c566a962').success).toBe(false); // v4
    expect(IdSchema.safeParse('not-an-id').success).toBe(false);
  });

  it('accepts unpadded base64 only', () => {
    expect(UnpaddedBase64Schema.safeParse(KEY).success).toBe(true);
    expect(UnpaddedBase64Schema.safeParse('AAAA==').success).toBe(false);
    expect(UnpaddedBase64Schema.safeParse('').success).toBe(false);
  });
});

describe('auth schemas', () => {
  it('normalizes usernames and emails', () => {
    expect(UsernameSchema.parse('  Alice.B_1 ')).toBe('alice.b_1');
    expect(UsernameSchema.safeParse('ab').success).toBe(false);
    expect(UsernameSchema.safeParse('alice-b').success).toBe(false);
    expect(UsernameSchema.safeParse('a'.repeat(21)).success).toBe(false);
    expect(EmailSchema.parse(' Alice@Example.COM ')).toBe('alice@example.com');
    expect(EmailSchema.safeParse('not-an-email').success).toBe(false);
  });

  it('parses a device registration', () => {
    const request = RegisterDeviceRequestSchema.parse({
      deviceId: DEVICE_ID,
      platform: 'android',
      name: 'Pixel',
      identityKeys: { curve25519: KEY, ed25519: KEY },
      nonce: 'bm9uY2U',
      signature: 'A'.repeat(86),
      deviceCertificate: 'A'.repeat(86),
    });
    expect(request.accountIdentityKey).toBeUndefined();
    expect(RegisterDeviceRequestSchema.safeParse({ ...request, platform: 'web' }).success).toBe(
      false,
    );
  });
});

describe('errors and problem+json', () => {
  it('maps every code to an error status and a type URI', () => {
    for (const code of ErrorCodeSchema.options) {
      expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
      expect(problemType(code)).toMatch(/^https:\/\/pingdost\.com\/problems\/[a-z-]+$/);
    }
    expect(problemType(ErrorCode.RATE_LIMITED)).toBe('https://pingdost.com/problems/rate-limited');
  });

  it('parses problems and rejects unknown codes', () => {
    const problem = {
      type: problemType('RATE_LIMITED'),
      title: 'Too many requests',
      status: 429,
      code: 'RATE_LIMITED',
      retryAfterSeconds: 30,
    };
    expect(ProblemSchema.parse(problem)).toEqual(problem);
    expect(ProblemSchema.safeParse({ ...problem, code: 'SOMETHING_NEW' }).success).toBe(false);
  });

  it('derives a generic code from an HTTP status', () => {
    expect(errorCodeForStatus(401)).toBe('UNAUTHENTICATED');
    expect(errorCodeForStatus(503)).toBe('UNAVAILABLE');
    expect(errorCodeForStatus(418)).toBe('INTERNAL');
  });
});

describe('pagination', () => {
  it('coerces query strings and applies the default limit', () => {
    expect(PageQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(PageQuerySchema.parse({ cursor: 'abc', limit: '20' })).toEqual({
      cursor: 'abc',
      limit: 20,
    });
    expect(PageQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
  });

  it('builds page schemas', () => {
    const schema = pageSchema(IdSchema);
    expect(schema.parse({ items: [DEVICE_ID], nextCursor: null })).toEqual({
      items: [DEVICE_ID],
      nextCursor: null,
    });
  });
});
