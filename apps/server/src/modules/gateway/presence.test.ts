import { describe, expect, it } from 'vitest';

import { PresenceHub, type PresencePeer } from './presence';

class Peer implements PresencePeer {
  readonly seen: [string, boolean][] = [];
  constructor(readonly userId: string) {}
  notifyPresence(userId: string, online: boolean): void {
    this.seen.push([userId, online]);
  }
}

function hub(hidden: string[] = [], blocks = new Set<string>()) {
  return new PresenceHub<Peer>({
    sharesPresence: (userId) => Promise.resolve(!hidden.includes(userId)),
    blocked: (a, b) => Promise.resolve(blocks.has(`${a}:${b}`) || blocks.has(`${b}:${a}`)),
    cacheMs: 0,
  });
}

describe('PresenceHub', () => {
  it('tells watchers when a user comes online and leaves', async () => {
    const presence = hub();
    const alice = new Peer('alice');
    const bob = new Peer('bob');
    await presence.update(alice, true, ['bob']);
    expect(alice.seen).toEqual([['bob', false]]);
    await presence.update(bob, true, []);
    expect(alice.seen.at(-1)).toEqual(['bob', true]);
    await presence.update(bob, false, []);
    expect(alice.seen.at(-1)).toEqual(['bob', false]);
    await presence.update(bob, true, []);
    await presence.remove(bob);
    expect(alice.seen.at(-1)).toEqual(['bob', false]);
    expect(bob.seen).toEqual([]);
  });

  it('stays online while any of the user’s sockets is in the foreground', async () => {
    const presence = hub();
    const watcher = new Peer('alice');
    const phone = new Peer('bob');
    const web = new Peer('bob');
    await presence.update(watcher, true, ['bob']);
    await presence.update(phone, true, []);
    await presence.update(web, true, []);
    await presence.remove(phone);
    expect(watcher.seen.at(-1)).toEqual(['bob', true]);
    await presence.update(web, false, []);
    expect(watcher.seen.at(-1)).toEqual(['bob', false]);
  });

  it('is reciprocal: hidden users are never reported and see nobody', async () => {
    const presence = hub(['carol']);
    const alice = new Peer('alice');
    const carol = new Peer('carol');
    await presence.update(alice, true, ['carol']);
    await presence.update(carol, true, ['alice']);
    expect(alice.seen).toEqual([['carol', false]]);
    expect(carol.seen).toEqual([]);
  });

  it('stops reporting a user once unwatched, and ignores watching oneself', async () => {
    const presence = hub();
    const alice = new Peer('alice');
    const bob = new Peer('bob');
    await presence.update(alice, true, ['bob', 'alice']);
    await presence.update(alice, true, []);
    await presence.update(bob, true, []);
    expect(alice.seen).toEqual([['bob', false]]);
  });

  it('reports nothing between users who blocked each other, and knows who watches whom', async () => {
    const blocks = new Set<string>();
    const presence = hub([], blocks);
    const alice = new Peer('alice');
    const bob = new Peer('bob');
    await presence.update(alice, true, ['bob']);
    await presence.update(bob, true, ['alice']);
    expect(alice.seen.at(-1)).toEqual(['bob', true]);
    expect(presence.watches(alice, 'bob')).toBe(true);
    expect(presence.watches(bob, 'carol')).toBe(false);

    blocks.add('bob:alice');
    await presence.blocksChanged('bob', 'alice');
    expect(alice.seen.at(-1)).toEqual(['bob', false]);
    expect(bob.seen.at(-1)).toEqual(['alice', false]);
    await presence.update(bob, false, ['alice']);
    await presence.update(bob, true, ['alice']);
    expect(alice.seen.at(-1)).toEqual(['bob', false]);

    blocks.clear();
    await presence.blocksChanged('bob', 'alice');
    expect(alice.seen.at(-1)).toEqual(['bob', true]);
    expect(bob.seen.at(-1)).toEqual(['alice', true]);
  });
});
