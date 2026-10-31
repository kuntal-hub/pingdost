import { beforeAll, describe, expect, it } from 'vitest';

import { createWasmCryptoProvider, type CryptoProvider } from '@pingdost/crypto';
import {
  MemoryEngineStore,
  type ConversationRecord,
  type DirectoryRecord,
  type GroupRecord,
  type MessageRecord,
} from '@pingdost/message-engine';
import { uuidv7 } from '@pingdost/protocol';

import {
  BackupError,
  BackupReader,
  BackupWriter,
  decodeHeader,
  exportToBackup,
  generatePhrase,
  HEADER_LENGTH,
  memorySink,
  memorySource,
  phraseEntropy,
  restoreFromBackup,
  type BackupErrorCode,
} from './index';

// Small Argon2id costs keep the suite fast; the defaults are checked in format.test.ts.
const KDF = { memoryKib: 256, iterations: 1, parallelism: 1 };
const self = uuidv7();
const peer = uuidv7();
const groupId = uuidv7();
let crypto: CryptoProvider;
const oldPickleKey = new Uint8Array(32).fill(1);
const newPickleKey = new Uint8Array(32).fill(2);

beforeAll(async () => {
  crypto = await createWasmCryptoProvider();
});

function message(conversationId: string, i: number, extra: Partial<MessageRecord> = {}) {
  const at = 1_700_000_000_000 + i * 1000;
  return {
    messageId: uuidv7(),
    conversationId,
    senderUserId: i % 2 ? peer : self,
    senderDeviceId: uuidv7(),
    direction: i % 2 ? 'in' : 'out',
    kind: 'text',
    body: `message ${i} ${'x'.repeat(i % 300)}`,
    attachment: null,
    replyTo: null,
    sentAt: at,
    sortAt: at,
    createdAt: at,
    state: i % 2 ? null : 'read',
    expiresAt: null,
    editedAt: null,
    editId: null,
    deletedAt: null,
    readAt: at,
    reactions: [],
    ...extra,
  } satisfies MessageRecord;
}

interface Fixture {
  store: MemoryEngineStore;
  identitySecret: string;
  identityPublic: string;
  sessionId: string;
  outbound: ReturnType<CryptoProvider['createOutboundGroupSession']>;
  directId: string;
  messages: MessageRecord[];
}

async function fixture(): Promise<Fixture> {
  const store = new MemoryEngineStore();
  const identity = crypto.createSigningKey();
  const directId = uuidv7();
  const conversation: ConversationRecord = {
    conversationId: directId,
    kind: 'direct',
    peerUserId: peer,
    createdAt: 1,
    updatedAt: 2,
    lastMessageId: null,
    unreadCount: 3,
    pinnedAt: 5,
    archived: false,
    mutedUntil: null,
  };
  const groupConversation: ConversationRecord = {
    ...conversation,
    conversationId: groupId,
    kind: 'group',
    peerUserId: '',
    pinnedAt: null,
  };
  const group: GroupRecord = {
    groupId,
    version: 3,
    members: [
      { userId: self, role: 'owner' },
      { userId: peer, role: 'member' },
    ],
    serverVersion: 3,
    serverMembers: [],
    name: 'Family',
    description: '',
    avatar: Uint8Array.of(9, 8, 7),
    infoAt: 4,
    infoId: uuidv7(),
    left: false,
    createdAt: 1,
    updatedAt: 2,
  };
  // 650 messages: more than one export page and more than one 64 KiB chunk.
  const messages = Array.from({ length: 650 }, (_, i) => message(directId, i));
  messages.push(message(directId, 700, { state: 'sending' }));
  messages.push(message(groupId, 701));
  const outbound = crypto.createOutboundGroupSession();
  const inbound = crypto.createInboundGroupSession(outbound.sessionKey());
  const directory: DirectoryRecord = {
    userId: peer,
    accountIdentityKey: crypto.createSigningKey().publicKey(),
    keyVersion: 4,
    devices: [],
    fetchedAt: 99,
    verifiedIdentityKey: 'verified-key',
  };
  await store.apply({
    account: 'old-device-account-pickle',
    conversations: [conversation, groupConversation],
    messages,
    groups: [group],
    directory: [directory, { ...directory, userId: self }],
    sessions: [
      {
        sessionId: 'olm',
        deviceId: uuidv7(),
        userId: peer,
        identityKey: 'k',
        pickle: 'olm-session-pickle',
        createdAt: 1,
        lastReceivedAt: 1,
      },
    ],
    outboundGroupSessions: [
      {
        groupId,
        sessionId: outbound.sessionId(),
        pickle: outbound.pickle(oldPickleKey),
        createdAt: 1,
        messageCount: 0,
        sharedWith: [],
        memberKey: '',
      },
    ],
    inboundGroupSessions: [
      {
        sessionId: inbound.sessionId(),
        groupId,
        senderUserId: peer,
        senderDeviceId: uuidv7(),
        senderKey: 'curve',
        pickle: inbound.pickle(oldPickleKey),
        firstKnownIndex: 0,
        seenIndices: [0, 1],
        createdAt: 1,
        sharedAt: { device: 0 },
      },
    ],
    settings: { 'engine.fallbackKeyRotatedAt': 5 },
  });
  inbound.dispose();
  return {
    store,
    identitySecret: identity.exportSecret(),
    identityPublic: identity.publicKey(),
    sessionId: outbound.sessionId(),
    outbound,
    directId,
    messages,
  };
}

async function makeBackup(
  f: Fixture,
  words: string[],
  files?: Map<string, Uint8Array>,
): Promise<Uint8Array> {
  const sink = memorySink();
  const writer = await BackupWriter.create({
    crypto,
    entropy: phraseEntropy(words),
    sink,
    kdf: KDF,
    manifest: {
      createdAt: 1_700_000_000_000,
      userId: self,
      accountIdentityKey: f.identityPublic,
      app: 'test',
      includesFiles: Boolean(files),
    },
  });
  await exportToBackup({
    store: f.store,
    crypto,
    pickleKey: oldPickleKey,
    writer,
    selfUserId: self,
    identitySecret: f.identitySecret,
    settings: { privacy: { readReceipts: false } },
    ...(files
      ? {
          file: (attachment) => {
            const data = files.get(attachment.attachmentId);
            if (!data) return Promise.resolve(null);
            return Promise.resolve({
              size: data.length,
              // eslint-disable-next-line @typescript-eslint/require-await
              chunks: async function* () {
                for (let i = 0; i < data.length; i += 50_000) yield data.subarray(i, i + 50_000);
              },
            });
          },
        }
      : {}),
  });
  await writer.finish();
  return sink.bytes();
}

async function expectCode(promise: Promise<unknown>, code: BackupErrorCode) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(BackupError);
  expect((error as BackupError).code).toBe(code);
}

describe('backup round trip', () => {
  it('restores history, identity, contacts and Megolm sessions into a new store', async () => {
    const f = await fixture();
    const words = generatePhrase();
    const bytes = await makeBackup(f, words);
    expect(decodeHeader(bytes).kdf).toEqual(KDF);

    const reader = await BackupReader.open(crypto, memorySource(bytes), phraseEntropy(words));
    expect(reader.manifest).toMatchObject({ userId: self, accountIdentityKey: f.identityPublic });
    const target = new MemoryEngineStore();
    const result = await restoreFromBackup({
      reader,
      store: target,
      crypto,
      pickleKey: newPickleKey,
    });
    expect(result.identitySecret).toBe(f.identitySecret);
    expect(result.settings).toEqual({ privacy: { readReceipts: false } });
    expect(result.peerUserIds).toEqual([peer]);
    expect(result.counts).toEqual({
      conversations: 2,
      messages: 652,
      groups: 1,
      contacts: 1,
      groupSessions: 1,
      files: 0,
    });

    expect(await target.listConversations()).toEqual(await f.store.listConversations());
    const restored = await target.listMessages(f.directId, { limit: 1000 });
    expect(restored).toHaveLength(651);
    const sending = f.messages.find((m) => m.state === 'sending')!;
    expect((await target.getMessage(sending.messageId))?.state).toBe('failed');
    const read = f.messages[0]!;
    expect(await target.getMessage(read.messageId)).toEqual(read);
    expect(await target.hasSeen(read.messageId)).toBe(true);
    expect((await target.getGroup(groupId))?.avatar).toEqual(Uint8Array.of(9, 8, 7));
    expect(await target.getDirectory(peer)).toMatchObject({
      verifiedIdentityKey: 'verified-key',
      fetchedAt: 0,
    });
    expect(await target.getDirectory(self)).toBeUndefined();

    // Device state never comes back (ADR 0003).
    expect(await target.getOutboundGroupSession(groupId)).toBeUndefined();
    expect(await target.listOutbox()).toEqual([]);
    expect(await target.getSetting('engine.fallbackKeyRotatedAt')).toBeUndefined();
    const [session] = await target.listInboundGroupSessions(groupId);
    expect(session).toMatchObject({ sessionId: f.sessionId, seenIndices: [0, 1] });
    expect(session?.sharedAt).toBeUndefined();

    // The restored Megolm session, under the new pickle key, still decrypts the sender.
    const inbound = crypto.restoreInboundGroupSession(session!.pickle, newPickleKey);
    const ciphertext = f.outbound.encrypt(new TextEncoder().encode('hello group'));
    expect(new TextDecoder().decode(inbound.decrypt(ciphertext).plaintext)).toBe('hello group');
    inbound.dispose();

    // Nothing readable in the file: no message text, names or keys.
    const text = new TextDecoder('latin1').decode(bytes);
    for (const secret of ['message 1', 'Family', f.identitySecret, 'readReceipts', self]) {
      expect(text.includes(secret)).toBe(false);
    }
    reader.dispose();
  });

  it('carries attachment files when asked to', async () => {
    const f = await fixture();
    const attachmentId = uuidv7();
    const data = Uint8Array.from({ length: 200_000 }, (_, i) => (i * 7) % 256);
    await f.store.apply({
      messages: [
        message(f.directId, 900, {
          kind: 'attachment',
          attachment: {
            attachmentId,
            key: 'k',
            noncePrefix: 'n',
            plaintextSize: data.length,
            chunkCount: 4,
            ciphertextSize: data.length,
            mimeType: 'image/jpeg',
            fileName: null,
            ciphertextSha256: 'x',
            chunkHashListSha256: 'y',
            thumbnail: null,
          },
        }),
      ],
    });
    const words = generatePhrase();
    const bytes = await makeBackup(f, words, new Map([[attachmentId, data]]));
    const reader = await BackupReader.open(crypto, memorySource(bytes), phraseEntropy(words));
    const received: Uint8Array[] = [];
    let closed = false;
    const result = await restoreFromBackup({
      reader,
      store: new MemoryEngineStore(),
      crypto,
      pickleKey: newPickleKey,
      file: (record) => {
        expect(record).toMatchObject({ attachmentId, size: data.length, role: 'file' });
        return Promise.resolve({
          write: (chunk) => {
            received.push(chunk);
            return Promise.resolve();
          },
          close: () => {
            closed = true;
            return Promise.resolve();
          },
          abort: () => Promise.resolve(),
        });
      },
    });
    expect(result.counts.files).toBe(1);
    expect(closed).toBe(true);
    expect(Buffer.concat(received)).toEqual(Buffer.from(data));
  });
});

describe('backup failures', () => {
  let words: string[];
  let bytes: Uint8Array;
  beforeAll(async () => {
    words = generatePhrase();
    bytes = await makeBackup(await fixture(), words);
  });
  const open = (data: Uint8Array, phrase = words) =>
    BackupReader.open(crypto, memorySource(data), phraseEntropy(phrase));
  const restore = async (data: Uint8Array) =>
    restoreFromBackup({
      reader: await open(data),
      store: new MemoryEngineStore(),
      crypto,
      pickleKey: newPickleKey,
    });

  it('refuses a wrong phrase', async () => {
    await expectCode(open(bytes, generatePhrase()), 'wrong_phrase');
  });

  it('refuses a phrase with a bad word or checksum', () => {
    const swapped = [...words];
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    expect(() => phraseEntropy([...words.slice(0, 23), 'notaword'])).toThrow(BackupError);
    expect(() => phraseEntropy(words.slice(0, 12))).toThrow(BackupError);
    // Two swapped words keep the word list valid but almost always break the checksum.
    if (swapped[0] !== swapped[1]) {
      let threw = false;
      try {
        phraseEntropy(swapped);
      } catch {
        threw = true;
      }
      // When the checksum happens to hold, the KDF input differs and opening fails instead.
      if (!threw) expect(phraseEntropy(swapped)).not.toEqual(phraseEntropy(words));
    }
    expect(phraseEntropy(`  ${words.join('  ').toUpperCase()}\n`)).toEqual(phraseEntropy(words));
  });

  it('refuses a tampered body before writing anything', async () => {
    const tampered = bytes.slice();
    tampered[HEADER_LENGTH + 70_000]! ^= 1; // inside the second chunk
    const store = new MemoryEngineStore();
    await expectCode(
      (async () =>
        restoreFromBackup({
          reader: await open(tampered),
          store,
          crypto,
          pickleKey: newPickleKey,
        }))(),
      'corrupt',
    );
    expect(await store.listConversations()).toEqual([]);
  });

  it('refuses a tampered header', async () => {
    const changedCost = bytes.slice();
    changedCost[15] = 2; // passes: a different key
    await expectCode(open(changedCost), 'wrong_phrase');
    const changedSalt = bytes.slice();
    changedSalt[20]! ^= 1;
    await expectCode(open(changedSalt), 'wrong_phrase');
  });

  it('refuses a truncated file', async () => {
    await expectCode(open(bytes.slice(0, HEADER_LENGTH + 65_552)), 'truncated');
    await expectCode(open(bytes.slice(0, 40)), 'truncated');
    // Cut inside the last chunk: it fails authentication as the last chunk.
    await expectCode(restore(bytes.slice(0, bytes.length - 3)), 'corrupt');
    // Cut a chunk short at a chunk boundary + a partial next one.
    await expectCode(restore(bytes.slice(0, HEADER_LENGTH + 65_552 + 100)), 'corrupt');
  });

  it('checks the magic and the version', async () => {
    const other = bytes.slice();
    other[1] = 0x41;
    await expectCode(open(other), 'not_a_backup');
    const newer = bytes.slice();
    newer[9] = 2;
    await expectCode(open(newer), 'unsupported_version');
    const kdf = bytes.slice();
    kdf[10] = 9;
    await expectCode(open(kdf), 'unsupported_version');
  });
});
