/**
 * Restore end to end over the engine's fake server (ADR 0022): the old phone backs up, is
 * lost while a contact keeps writing, and a new phone (new device, same account key)
 * restores, announces itself and gets what the old phone missed.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createWasmCryptoProvider, type CryptoProvider } from '@pingdost/crypto';
import { MemoryEngineStore } from '@pingdost/message-engine';
import {
  createTestClient,
  eventually,
  FakeServer,
  type TestClient,
} from '@pingdost/message-engine/testing';

import {
  BackupReader,
  BackupWriter,
  exportToBackup,
  generatePhrase,
  memorySink,
  memorySource,
  phraseEntropy,
  restoreFromBackup,
} from './index';

const KDF = { memoryKib: 256, iterations: 1, parallelism: 1 };
let crypto: CryptoProvider;
const running: TestClient[] = [];

beforeAll(async () => {
  crypto = await createWasmCryptoProvider();
});

afterEach(async () => {
  for (const client of running.splice(0)) await client.engine.stop();
});

async function client(server: FakeServer, options: Parameters<typeof createTestClient>[2] = {}) {
  const created = await createTestClient(server, crypto, options);
  running.push(created);
  return created;
}

async function online(...clients: TestClient[]) {
  for (const c of clients) {
    c.transport.connect();
    await c.engine.start();
  }
}

async function backupOf(c: TestClient, words: string[]): Promise<Uint8Array> {
  const sink = memorySink();
  const writer = await BackupWriter.create({
    crypto,
    entropy: phraseEntropy(words),
    sink,
    kdf: KDF,
    manifest: {
      createdAt: Date.now(),
      userId: c.userId,
      accountIdentityKey: c.identity.publicKey(),
      app: 'test',
      includesFiles: false,
    },
  });
  await exportToBackup({
    store: c.store,
    crypto,
    pickleKey: c.pickleKey,
    writer,
    selfUserId: c.userId,
    identitySecret: c.identity.exportSecret(),
  });
  await writer.finish();
  return sink.bytes();
}

describe('restore on a new phone', () => {
  it('brings history back, resumes chatting and delivers what the lost phone missed', async () => {
    const server = new FakeServer();
    const alice = await client(server);
    const bob = await client(server);
    await online(alice, bob);
    const { conversationId } = await alice.engine.openDirectConversation(bob.userId);
    await alice.engine.sendText(conversationId, 'before the backup');
    await eventually(() => bob.store.allMessages().length === 1);
    await alice.engine.refreshDevices(bob.userId);
    expect(await alice.engine.markVerified(bob.userId, bob.identity.publicKey())).toBe(true);

    const words = generatePhrase();
    const file = await backupOf(bob, words);

    // Bob's phone is lost; Alice keeps writing; Bob's account revokes the old phone.
    await bob.engine.stop();
    bob.transport.disconnect();
    const missed = await alice.engine.sendText(conversationId, 'while the phone was lost');
    await eventually(
      async () => (await alice.engine.getMessage(missed.messageId))?.state === 'sent_to_server',
    );
    server.revoke(bob.deviceId);

    // The new phone: same account key (from the backup), a fresh Olm account and device ID.
    const restoredIdentity = crypto.restoreSigningKey(bob.identity.exportSecret());
    const store = new MemoryEngineStore();
    const bob2 = await createTestClient(server, crypto, { sameUserAs: bob, store });
    running.push(bob2);
    expect(bob2.deviceId).not.toBe(bob.deviceId);
    const reader = await BackupReader.open(crypto, memorySource(file), phraseEntropy(words));
    expect(reader.manifest.accountIdentityKey).toBe(restoredIdentity.publicKey());
    const result = await restoreFromBackup({
      reader,
      store,
      crypto,
      pickleKey: bob2.pickleKey,
    });
    expect(result.identitySecret).toBe(bob.identity.exportSecret());
    expect(result.peerUserIds).toEqual([alice.userId]);
    expect(store.allMessages().map((m) => m.body)).toEqual(['before the backup']);

    await online(bob2);
    expect(await bob2.engine.announceNewDevice(result.peerUserIds)).toBe(1);

    // The missed message arrives on the new phone, once; Alice sees it delivered.
    await eventually(
      () => store.allMessages().some((m) => m.body === 'while the phone was lost'),
      5_000,
      'missed message on the new phone',
    );
    await eventually(
      async () =>
        (await alice.engine.getMessage(missed.messageId))?.state ===
        'delivered_to_recipient_device',
      5_000,
      'missed message delivered',
    );
    expect(store.allMessages().filter((m) => m.body === 'before the backup')).toHaveLength(1);

    // Alice is told, and her verification of Bob stays: the safety number did not change.
    const notices = (await alice.engine.listMessages(conversationId)).filter(
      (m) => m.kind === 'system',
    );
    expect(notices.map((m) => m.body)).toEqual(['primary_device_changed']);
    expect((await alice.engine.contact(bob.userId)).verified).toBe(true);

    // Chatting resumes both ways.
    await bob2.engine.sendText(conversationId, 'back again');
    await eventually(() => alice.store.allMessages().some((m) => m.body === 'back again'));
    await alice.engine.sendText(conversationId, 'welcome back');
    await eventually(() => store.allMessages().some((m) => m.body === 'welcome back'));
    restoredIdentity.dispose();
    reader.dispose();
  });
});
