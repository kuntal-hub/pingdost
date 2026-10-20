// The Dexie store against the shared EngineStore contract (ADR 0011), on fake-indexeddb with
// Node's Web Crypto, plus what only this store promises: nothing readable at rest.
import { describe, expect, it } from 'vitest';

import { messageRecord, runEngineStoreContract } from '@pingdost/message-engine/testing';

import { PingdostDb } from './db';
import { DexieEngineStore } from './engine-store';
import { vaultKey } from './vault';

let counter = 0;

async function fresh(): Promise<{ db: PingdostDb; store: DexieEngineStore }> {
  const db = new PingdostDb(`engine-test-${++counter}`);
  return { db, store: new DexieEngineStore(db, await vaultKey(db)) };
}

runEngineStoreContract('Dexie (IndexedDB)', async () => (await fresh()).store);

describe('DexieEngineStore', () => {
  it('keeps no message text, envelope or pickle readable in IndexedDB', async () => {
    const { db, store } = await fresh();
    const message = messageRecord({ body: 'a very private sentence' });
    await store.apply({
      account: 'PICKLED-ACCOUNT',
      messages: [message],
      outbox: [
        {
          type: 'device',
          purpose: 'message',
          id: 'e1',
          messageId: message.messageId,
          recipientUserId: 'u',
          recipientDeviceId: 'd',
          content: new TextEncoder().encode('ENVELOPE-PLAINTEXT'),
          packet: null,
          newSession: false,
          createdAt: 1,
          expiresAt: 2,
          attempts: 0,
          nextAttemptAt: 1,
        },
      ],
      settings: { secretish: 'SETTING-VALUE' },
    });
    const dump = JSON.stringify(
      await Promise.all([
        db.messages.toArray(),
        db.outbox.toArray(),
        db.records.toArray(),
        db.settings.toArray(),
      ]),
      (_k, v: unknown) => (v instanceof Uint8Array ? new TextDecoder().decode(v) : v),
    );
    for (const secret of [
      'private sentence',
      'ENVELOPE-PLAINTEXT',
      'PICKLED-ACCOUNT',
      'SETTING-VALUE',
    ]) {
      expect(dump).not.toContain(secret);
    }
    // And it all reads back, also through a second store with a cold cache.
    const again = new DexieEngineStore(db, await vaultKey(db));
    expect((await again.getMessage(message.messageId))?.body).toBe('a very private sentence');
    expect((await again.getOutboxItem('e1'))?.type).toBe('device');
    expect(await again.getSetting('secretish')).toBe('SETTING-VALUE');
  });
});
