import { describe, expect, it } from 'vitest';

import { loadServerConfig } from '@pingdost/config';

import type { Clock } from './clock';
import { WindowCounter } from './counters';
import { AppError, titleFor, toProblem } from './errors';
import { createLogger, REDACTED, scrub } from './logger';
import { Hasher, safeEqual, sixDigitCode } from './secrets';
import { redactConfig } from './startup';

function fakeClock(start = 1_000_000): Clock & { advance(ms: number): void } {
  let now = start;
  return { now: () => now, advance: (ms) => (now += ms) };
}

describe('logger redaction', () => {
  it('replaces sensitive fields at any depth, in arrays too', () => {
    expect(
      scrub({
        password: 'p',
        newPassword: 'p',
        otp: '123456',
        email: 'a@b.c',
        list: [{ accessToken: 't' }],
        deep: { a: { b: { signingKey: 'k', ciphertext: 'c', sdp: 's', fine: 1 } } },
      }),
    ).toEqual({
      password: REDACTED,
      newPassword: REDACTED,
      otp: REDACTED,
      email: REDACTED,
      list: [{ accessToken: REDACTED }],
      deep: { a: { b: { signingKey: REDACTED, ciphertext: REDACTED, sdp: REDACTED, fine: 1 } } },
    });
  });

  it('applies to everything the logger writes', () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'info',
      destination: { write: (line) => void lines.push(line) },
    });
    logger.info(
      {
        req: {
          method: 'GET',
          url: '/v1/me?token=secret-in-query',
          headers: { authorization: 'Bearer abc' },
        },
      },
      'r',
    );
    logger.child({ component: 'x' }).warn({ user: { refreshToken: 'rt-secret' } }, 'w');
    const output = lines.join('');
    expect(output).not.toContain('secret-in-query');
    expect(output).not.toContain('Bearer abc');
    expect(output).not.toContain('rt-secret');
    expect(output).toContain('"path":"/v1/me"');
  });
});

describe('WindowCounter', () => {
  it('allows `limit` hits per window, then reports when it resets', () => {
    const clock = fakeClock();
    const counter = new WindowCounter(2, 60_000, clock);
    expect(counter.hit('k').allowed).toBe(true);
    expect(counter.peek('k').allowed).toBe(true);
    expect(counter.hit('k').allowed).toBe(true);
    expect(counter.peek('k')).toMatchObject({ allowed: false, retryAfterSeconds: 60 });
    expect(counter.hit('k').allowed).toBe(false);
    clock.advance(60_000);
    expect(counter.hit('k')).toMatchObject({ allowed: true, count: 1 });
  });

  it('keeps keys apart, resets on demand and bounds memory', () => {
    const counter = new WindowCounter(1, 60_000, fakeClock(), 2);
    counter.hit('a');
    counter.hit('b');
    counter.reset('b');
    expect(counter.peek('b').count).toBe(0);
    counter.hit('c');
    counter.hit('d'); // evicts the oldest
    expect(counter.peek('a').count).toBe(0);
  });
});

describe('problem+json', () => {
  it('builds problems from codes', () => {
    expect(titleFor('USERNAME_TAKEN')).toBe('Username taken');
    expect(toProblem('RATE_LIMITED', { retryAfterSeconds: 3 })).toEqual({
      type: 'https://pingdost.com/problems/rate-limited',
      title: 'Rate limited',
      status: 429,
      code: 'RATE_LIMITED',
      retryAfterSeconds: 3,
    });
    expect(new AppError('EMAIL_TAKEN').statusCode).toBe(409);
  });
});

describe('secrets', () => {
  it('hashes per purpose and compares in constant time', () => {
    const hasher = new Hasher(Buffer.alloc(32, 7).toString('base64'));
    expect(hasher.hash('otp', 'x')).not.toBe(hasher.hash('refresh', 'x'));
    expect(hasher.hash('otp', 'x')).toBe(hasher.hash('otp', 'x'));
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('makes 6-digit codes', () => {
    for (let i = 0; i < 200; i++) expect(sixDigitCode()).toMatch(/^\d{6}$/);
  });
});

describe('redactConfig', () => {
  it('hides every secret, flat and grouped', () => {
    const config = loadServerConfig({
      EMAIL_PROVIDER: 'zeptomail',
      EMAIL_API_KEY: 'zepto-secret-key',
      SMTP_USER: 'smtp-user',
      SMTP_PASS: 'smtp-secret-pass',
      MONGODB_URI: 'mongodb://user:mongo-secret@localhost:27017/pingdost',
      TURN_URLS: 'turn:turn.example.com',
      TURN_SHARED_SECRET: 'turn-secret-turn-secret-turn-secret-1234',
    });
    const text = JSON.stringify(redactConfig(config));
    for (const secret of [
      'zepto-secret-key',
      'smtp-secret-pass',
      'mongo-secret',
      'turn-secret',
      config.ACCESS_TOKEN_SIGNING_KEY,
      config.SERVER_HMAC_PEPPER,
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('smtp-user');
  });
});
