import { describe, expect, it } from 'vitest';

import { circleChanges, circleStateOf, personName } from './circle-logic';

const person = (userId: string, extra: object = {}) => ({
  userId,
  username: `u_${userId}`,
  displayName: null,
  avatarUrl: null,
  ...extra,
});
const member = (userId: string) => ({ ...person(userId), since: 1 });
const request = (userId: string) => ({ ...person(userId), createdAt: 1, expiresAt: 2 });

describe('circleStateOf', () => {
  const lists = {
    loaded: true,
    members: [member('a')],
    incoming: [request('b')],
    outgoing: [request('c')],
  };

  it('tells members, incoming and outgoing requests and strangers apart', () => {
    expect(circleStateOf(lists, 'a')).toBe('member');
    expect(circleStateOf(lists, 'b')).toBe('incoming');
    expect(circleStateOf(lists, 'c')).toBe('requested');
    expect(circleStateOf(lists, 'd')).toBe('none');
  });

  it('knows nothing before the first load', () => {
    expect(circleStateOf({ ...lists, loaded: false }, 'a')).toBeUndefined();
  });
});

describe('circleChanges', () => {
  it('finds new requests and accepted ones, not removals or declines', () => {
    const before = {
      members: [member('m')],
      incoming: [request('old')],
      outgoing: [request('asked'), request('pending')],
    };
    const after = {
      members: [member('asked')],
      incoming: [request('old'), request('new')],
      outgoing: [request('pending')],
    };
    const changes = circleChanges(before, after);
    expect(changes.requests.map((r) => r.userId)).toEqual(['new']);
    expect(changes.accepted.map((m) => m.userId)).toEqual(['asked']);
  });

  it('does not call someone who asked first an accept', () => {
    const before = { members: [], incoming: [request('x')], outgoing: [] };
    const after = { members: [member('x')], incoming: [], outgoing: [] };
    expect(circleChanges(before, after)).toEqual({ requests: [], accepted: [] });
  });
});

describe('personName', () => {
  it('prefers the display name, then the username', () => {
    expect(personName({ displayName: 'Asha', username: 'asha_k' })).toBe('Asha');
    expect(personName({ displayName: null, username: 'asha_k' })).toBe('@asha_k');
    expect(personName({ displayName: null, username: null })).toBe('Someone');
  });
});
