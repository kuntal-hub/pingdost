// The tab bus (ADR 0020) on Node's BroadcastChannel: a follower's calls reach the leader and
// come back (errors keep their code), events reach subscribers, and calls pending when another
// tab takes over fail instead of hanging.
import { afterEach, describe, expect, it } from 'vitest';

import type { MessageRecord } from '@pingdost/message-engine';
import { messageRecord } from '@pingdost/message-engine/testing';

import { CHANNEL, leaderGreeting, RemoteChat, type BusMessage } from './bus';
import { RemoteError } from './client';

const open: BroadcastChannel[] = [];
const remotes: RemoteChat[] = [];

afterEach(() => {
  for (const remote of remotes.splice(0)) remote.dispose();
  for (const channel of open.splice(0)) channel.close();
});

/** A stand-in leader tab: answers calls by name, and can announce itself. */
function fakeLeader(tab: string, answer: (method: string, args: unknown[]) => unknown) {
  const channel = new BroadcastChannel(CHANNEL);
  open.push(channel);
  const calls: string[] = [];
  channel.onmessage = (event: MessageEvent<BusMessage>) => {
    const message = event.data;
    if (message.type === 'hello') channel.postMessage({ type: 'leader', tab } satisfies BusMessage);
    if (message.type !== 'call') return;
    calls.push(message.method);
    try {
      const value = answer(message.method, message.args);
      channel.postMessage({
        type: 'result',
        id: message.id,
        to: message.from,
        ok: true,
        value,
      } satisfies BusMessage);
    } catch (error) {
      const { code } = error as { code?: string };
      channel.postMessage({
        type: 'result',
        id: message.id,
        to: message.from,
        ok: false,
        error: {
          name: 'MessageActionError',
          message: (error as Error).message,
          ...(code ? { code } : {}),
        },
      } satisfies BusMessage);
    }
  };
  return { channel, calls };
}

function follower(): { remote: RemoteChat; channel: BroadcastChannel } {
  const channel = new BroadcastChannel(CHANNEL);
  open.push(channel);
  const remote = new RemoteChat(channel, crypto.randomUUID());
  channel.onmessage = (event: MessageEvent<BusMessage>) => remote.handle(event.data);
  remotes.push(remote);
  return { remote, channel };
}

describe('RemoteChat', () => {
  it('relays calls to the leader tab and maps errors back', async () => {
    const message = messageRecord({ body: 'hi' });
    const leader = fakeLeader('leader-1', (method, args) => {
      if (method === 'getMessage') return args[0] === message.messageId ? message : undefined;
      if (method === 'react')
        throw Object.assign(new Error('cannot react'), { code: 'not_allowed' });
      return [];
    });
    const { remote } = follower();
    const client = remote.client;
    expect(await client.getMessage(message.messageId)).toEqual(message);
    expect(await client.listConversations()).toEqual([]);
    const error = await client.react(message.messageId, '👍').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RemoteError);
    expect(error).toMatchObject({ code: 'not_allowed', message: 'cannot react' });
    expect(leader.calls).toEqual(['getMessage', 'listConversations', 'react']);
  });

  it('delivers the leader’s events to subscribers', async () => {
    const leader = fakeLeader('leader-1', () => undefined);
    const { remote } = follower();
    const seen: MessageRecord[] = [];
    let listChanges = 0;
    remote.client.subscribe('c1', (event) => event.type === 'message' && seen.push(event.message));
    remote.client.onListChanged(() => listChanges++);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const message = messageRecord({ conversationId: 'c1' });
    leader.channel.postMessage({
      type: 'conversation',
      conversationId: 'c1',
      event: { type: 'message', message },
    } satisfies BusMessage);
    leader.channel.postMessage({
      type: 'conversation',
      conversationId: 'other',
      event: { type: 'message', message },
    } satisfies BusMessage);
    leader.channel.postMessage({ type: 'list' } satisfies BusMessage);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen.map((m) => m.messageId)).toEqual([message.messageId]);
    expect(listChanges).toBeGreaterThanOrEqual(1);
  });

  it('answers a tab opened after the leader started', async () => {
    // Found in Chrome: a second tab stayed on "Opening the chat…". The leader had announced
    // itself once, before that tab existed, and did not answer its hello. This leader handles
    // its channel the way start.ts does.
    const channel = new BroadcastChannel(CHANNEL);
    open.push(channel);
    channel.postMessage({ type: 'leader', tab: 'leader-1' } satisfies BusMessage);
    channel.onmessage = (event: MessageEvent<BusMessage>) => {
      const message = event.data;
      const greeting = leaderGreeting(message, 'leader-1');
      if (greeting) channel.postMessage(greeting);
      if (message.type === 'call') {
        channel.postMessage({
          type: 'result',
          id: message.id,
          to: message.from,
          ok: true,
          value: [],
        } satisfies BusMessage);
      }
    };
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { remote } = follower();
    expect(await remote.client.listConversations()).toEqual([]);
  });

  it('fails calls left pending when another tab takes over', async () => {
    const first = fakeLeader('leader-1', () => undefined);
    const { remote } = follower();
    await remote.client.listConversations();
    // The old leader stops answering (its tab is closing); then a new one announces itself.
    first.channel.onmessage = null;
    const hanging = remote.client.markRead('c1').catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = new BroadcastChannel(CHANNEL);
    open.push(second);
    second.postMessage({ type: 'leader', tab: 'leader-2' } satisfies BusMessage);
    const error = await hanging;
    expect(error).toBeInstanceOf(RemoteError);
    expect((error as RemoteError).name).toBe('Moved');
  });
});
