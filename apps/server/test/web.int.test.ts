/**
 * The web client's stack against the real server (Phase 17, ADR 0020): a phone (sim client)
 * links a browser by QR pairing; the browser runs the same engine on the web's Dexie store
 * (`@pingdost/web-store`, here on fake-indexeddb and Node's Web Crypto). Messages go both
 * ways 1:1 and in a group; messages each device sends show on the other as sent by the same
 * user; nothing readable stays in IndexedDB.
 */
import 'fake-indexeddb/auto';

import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CryptoProvider } from '@pingdost/crypto';
import { SimClient, type SimClientOptions } from '@pingdost/sim-client';
import { DexieEngineStore, PingdostDb, vaultKey } from '@pingdost/web-store';

import { cryptoProvider } from './devices';
import { freePort, MAILPIT_URL, startTestServer, type TestServer } from './helpers';

let crypto: CryptoProvider;
let server: TestServer;
let port = 0;
const clients: SimClient[] = [];

beforeAll(async () => {
  crypto = await cryptoProvider();
  port = await freePort();
  server = await startTestServer({
    env: { PUBLIC_API_URL: `http://127.0.0.1:${port}` },
    throttles: { keyClaims: { limit: 10_000, windowMs: 3_600_000 } },
  });
  await server.app.listen({ host: '127.0.0.1', port });
  port = (server.app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const client of clients) await client.stop().catch(() => undefined);
  await server.close();
});

function options(overrides: Partial<SimClientOptions> = {}): SimClientOptions {
  return {
    endpoints: {
      api: `http://127.0.0.1:${port}`,
      ws: `ws://127.0.0.1:${port}/v1/ws`,
      mailpit: MAILPIT_URL,
    },
    crypto,
    settings: { directoryMaxAgeMs: 0, receiptDelayMs: 50, retry: { baseMs: 200, maxMs: 1_000 } },
    receipts: () => true,
    ...overrides,
  };
}

async function until(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function bodies(client: SimClient, conversationId: string): Promise<string[]> {
  return (await client.engine.listMessages(conversationId, { limit: 50 }))
    .filter((m) => m.kind === 'text')
    .map((m) => m.body)
    .sort();
}

describe('the web client stack (Dexie store) with a phone', () => {
  it('pairs, then sends and receives 1:1 and in a group; own messages sync both ways', async () => {
    const phone = await SimClient.register(options());
    const friend = await SimClient.register(options());
    const db = new PingdostDb(`web-int-${Date.now()}`);
    const browser = await SimClient.linkedDevice(
      options({ store: new DexieEngineStore(db, await vaultKey(db)) }),
      phone,
      'Chrome on Windows',
    );
    clients.push(phone, friend, browser);
    for (const client of [phone, friend, browser]) await client.start();

    // The friend writes; the phone and the browser both get it.
    const { conversationId } = await friend.engine.openDirectConversation(phone.userId);
    await friend.engine.sendText(conversationId, 'hello both of you');
    await until(
      async () => (await bodies(browser, conversationId)).includes('hello both of you'),
      'browser receives',
    );
    await until(
      async () => (await bodies(phone, conversationId)).includes('hello both of you'),
      'phone receives',
    );

    // The browser answers: the friend gets it, and the phone files it as its own.
    await browser.engine.sendText(conversationId, 'from the browser');
    await until(
      async () => (await bodies(friend, conversationId)).includes('from the browser'),
      'friend gets it',
    );
    await until(
      async () => (await bodies(phone, conversationId)).includes('from the browser'),
      'phone copy',
    );
    const onPhone = (await phone.engine.listMessages(conversationId, { limit: 10 })).find(
      (m) => m.body === 'from the browser',
    );
    expect(onPhone).toMatchObject({ direction: 'out', senderDeviceId: browser.deviceId });

    // The phone writes: the browser files it as its own too.
    await phone.engine.sendText(conversationId, 'from the phone');
    await until(
      async () => (await bodies(browser, conversationId)).includes('from the phone'),
      'browser copy',
    );
    const onBrowser = (await browser.engine.listMessages(conversationId, { limit: 10 })).find(
      (m) => m.body === 'from the phone',
    );
    expect(onBrowser).toMatchObject({ direction: 'out', senderDeviceId: phone.deviceId });
    // Delivered to the friend: the browser's own message reaches "delivered".
    await until(
      async () =>
        (await browser.engine.listMessages(conversationId, { limit: 10 })).some(
          (m) => m.body === 'from the browser' && m.state === 'delivered_to_recipient_device',
        ),
      'delivered state on the browser',
    );

    // A group made on the phone reaches the browser, both ways.
    const { conversationId: groupId } = await phone.engine.createGroup({
      name: 'Trip',
      memberUserIds: [friend.userId],
    });
    await until(
      async () => (await browser.engine.getGroup(groupId)) !== undefined,
      'browser knows the group',
    );
    await browser.engine.sendText(groupId, 'group hello from the browser');
    await until(
      async () => (await bodies(friend, groupId)).includes('group hello from the browser'),
      'friend group',
    );
    await friend.engine.sendText(groupId, 'group answer');
    await until(
      async () => (await bodies(browser, groupId)).includes('group answer'),
      'browser group',
    );

    // Search runs over the browser's own store.
    expect((await browser.engine.search('hello')).map((m) => m.body).sort()).toEqual([
      'group hello from the browser',
      'hello both of you',
    ]);

    // Nothing readable at rest.
    const dump = JSON.stringify(
      await Promise.all([
        db.messages.toArray(),
        db.outbox.toArray(),
        db.sessions.toArray(),
        db.records.toArray(),
      ]),
      (_k, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v),
    );
    for (const text of ['hello both of you', 'from the browser', 'group answer', 'Trip']) {
      expect(dump).not.toContain(text);
    }
  });
});
