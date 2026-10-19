import { describe, expect, it } from 'vitest';

import { PasswordHasher } from './passwords';
import { isReservedUsername } from './reserved-usernames';
import { AccessTokens } from './tokens';
import { AppError } from '../../infra/errors';

const KEY = Buffer.alloc(32, 1).toString('base64');

function clockAt(start: number) {
  let now = start;
  return { now: () => now, set: (value: number) => (now = value) };
}

describe('AccessTokens', () => {
  it('signs and verifies sub + sid', async () => {
    const clock = clockAt(Date.UTC(2026, 9, 19));
    const tokens = new AccessTokens(KEY, 900, clock);
    const { token, expiresAt } = await tokens.sign({ userId: 'u1', sessionId: 's1' });
    expect(expiresAt).toBe(clock.now() + 900_000);
    await expect(tokens.verify(token)).resolves.toEqual({ userId: 'u1', sessionId: 's1' });
  });

  it('reports expiry separately from other failures', async () => {
    const clock = clockAt(Date.UTC(2026, 9, 19));
    const tokens = new AccessTokens(KEY, 900, clock);
    const { token } = await tokens.sign({ userId: 'u1', sessionId: 's1' });
    clock.set(clock.now() + 901_000);
    await expect(tokens.verify(token)).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });

    const other = new AccessTokens(Buffer.alloc(32, 2).toString('base64'), 900, clock);
    const { token: foreign } = await other.sign({ userId: 'u1', sessionId: 's1' });
    await expect(tokens.verify(foreign)).rejects.toBeInstanceOf(AppError);
    await expect(tokens.verify(foreign)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('PasswordHasher', () => {
  const params = { memoryKib: 19_456, iterations: 2, parallelism: 1 };

  it('hashes with Argon2id and verifies', async () => {
    const hasher = new PasswordHasher(params);
    const hash = await hasher.hash('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await hasher.verify(hash, 'correct horse battery')).toBe(true);
    expect(await hasher.verify(hash, 'wrong')).toBe(false);
    expect(await hasher.verify('not a hash', 'x')).toBe(false);
    expect(await hasher.verifyAgainstDummy('x')).toBe(false);
  });

  it('asks for a rehash when the parameters change', async () => {
    const hash = await new PasswordHasher(params).hash('pw');
    expect(new PasswordHasher(params).needsRehash(hash)).toBe(false);
    expect(new PasswordHasher({ ...params, iterations: 3 }).needsRehash(hash)).toBe(true);
  });
});

describe('reserved usernames', () => {
  it('blocks service names and the pingdost prefix', () => {
    expect(isReservedUsername('admin')).toBe(true);
    expect(isReservedUsername('pingdost_help')).toBe(true);
    expect(isReservedUsername('alice')).toBe(false);
  });
});
