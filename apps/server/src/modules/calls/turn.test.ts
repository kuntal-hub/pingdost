import { describe, expect, it } from 'vitest';

import { iceServersFor, turnCredential } from './turn';

const SECRET = 'pingdost-test-turn-secret-0123456789abcdef';
const USER = '0192f0c0-0000-7000-8000-000000000001';

describe('TURN credentials', () => {
  it('matches the TURN REST API vector (computed independently with .NET HMACSHA1)', () => {
    // username = "<expiry>:<user>", credential = base64(HMAC-SHA1(secret, username)): what
    // coturn recomputes with `use-auth-secret`. The int test checks it against coturn itself.
    const result = turnCredential(SECRET, USER, 1_730_000_000_400, 3_600);
    expect(result).toEqual({
      username: `1730003600:${USER}`,
      credential: 'd3Jq8mgFveZV4CBUJH9SxX1Xx8k=',
      expiresAtSeconds: 1_730_003_600,
    });
  });

  it('returns STUN, then TURN with the derived pair, never the secret', () => {
    const response = iceServersFor(
      {
        stunUrls: ['stun:turn.example:3478'],
        turn: { urls: ['turn:turn.example:3478?transport=udp'], sharedSecret: SECRET },
        ttlSeconds: 600,
      },
      USER,
      1_730_000_000_000,
    );
    expect(response).toEqual({
      iceServers: [
        { urls: ['stun:turn.example:3478'] },
        {
          urls: ['turn:turn.example:3478?transport=udp'],
          username: `1730000600:${USER}`,
          credential: expect.any(String) as string,
        },
      ],
      expiresAt: 1_730_000_600_000,
      ttlSeconds: 600,
    });
    expect(JSON.stringify(response)).not.toContain(SECRET);
  });

  it('works without TURN (STUN only, or nothing)', () => {
    expect(iceServersFor({ stunUrls: [], ttlSeconds: 60 }, USER, 0).iceServers).toEqual([]);
  });
});
