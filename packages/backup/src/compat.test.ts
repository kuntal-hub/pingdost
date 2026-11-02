/**
 * Old backups stay readable (Phase 27, from the Phase 19 handoff): the frozen fixture in
 * packages/test-fixtures/backup/ was written by the backup format of its version, and every
 * later build must restore it. When the format changes, add a new fixture beside it (run
 * `make-fixture` after bumping BACKUP_FORMAT_VERSION) and keep this test for the old one.
 * Never regenerate an existing fixture to make this test pass.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { createWasmCryptoProvider, type CryptoProvider } from '@pingdost/crypto';
import { MemoryEngineStore } from '@pingdost/message-engine';

import { BackupReader, memorySource, phraseEntropy, restoreFromBackup } from './index';

interface FixtureMeta {
  formatVersion: number;
  phrase: string;
  userId: string;
  peerUserId: string;
  conversationId: string;
  groupId: string;
  identitySecret: string;
  accountIdentityKey: string;
  messages: { messageId: string; body: string }[];
  megolmSessionId: string;
  megolmSample: string;
}

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../test-fixtures/backup/${name}`, import.meta.url));
let crypto: CryptoProvider;

beforeAll(async () => {
  crypto = await createWasmCryptoProvider();
});

describe('backup compatibility', () => {
  it('restores the version 1 fixture', async () => {
    const meta = JSON.parse(await readFile(fixture('pdbk-v1.json'), 'utf8')) as FixtureMeta;
    const bytes = new Uint8Array(await readFile(fixture('pdbk-v1.pdbk')));
    const reader = await BackupReader.open(crypto, memorySource(bytes), phraseEntropy(meta.phrase));
    expect(reader.manifest).toMatchObject({
      userId: meta.userId,
      accountIdentityKey: meta.accountIdentityKey,
    });

    const store = new MemoryEngineStore();
    const pickleKey = new Uint8Array(32).fill(9);
    const result = await restoreFromBackup({ reader, store, crypto, pickleKey });
    expect(result.identitySecret).toBe(meta.identitySecret);
    expect(result.settings).toEqual({ privacy: { readReceipts: false } });
    expect(result.peerUserIds).toEqual([meta.peerUserId]);
    expect(result.counts).toMatchObject({ conversations: 1, messages: 5, groups: 1, contacts: 1 });

    for (const { messageId, body } of meta.messages) {
      expect((await store.getMessage(messageId))?.body).toBe(body);
    }
    expect((await store.getGroup(meta.groupId))?.name).toBe('Fixture group');

    // The group key came back under the new pickle key and still decrypts.
    const [session] = await store.listInboundGroupSessions(meta.groupId);
    expect(session?.sessionId).toBe(meta.megolmSessionId);
    const inbound = crypto.restoreInboundGroupSession(session!.pickle, pickleKey);
    const plaintext = inbound.decrypt(new Uint8Array(Buffer.from(meta.megolmSample, 'base64')));
    expect(new TextDecoder().decode(plaintext.plaintext)).toBe('fixture group message');
    inbound.dispose();
    reader.dispose();
  });
});
