/**
 * Writes the frozen backup fixture (Phase 27, from the Phase 19 handoff): a small, synthetic
 * `.pdbk` and what restoring it must give. Every later build must restore it
 * (`src/compat.test.ts`). Run ONCE per backup format version, never to "fix" a failing test:
 *
 *   pnpm --filter @pingdost/backup make-fixture
 *
 * The phrase and keys are throwaway values made for this file only.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createWasmCryptoProvider } from '@pingdost/crypto';
import { MemoryEngineStore, type MessageRecord } from '@pingdost/message-engine';
import { uuidv7 } from '@pingdost/protocol';

import {
  BACKUP_FORMAT_VERSION,
  BackupWriter,
  exportToBackup,
  generatePhrase,
  memorySink,
  phraseEntropy,
} from '../src/index';

const out = (name: string) =>
  fileURLToPath(new URL(`../../test-fixtures/backup/${name}`, import.meta.url));

const crypto = await createWasmCryptoProvider();
const pickleKey = new Uint8Array(32).fill(3);
const self = uuidv7();
const peer = uuidv7();
const conversationId = uuidv7();
const groupId = uuidv7();
const identity = crypto.createSigningKey();
const words = generatePhrase();
const createdAt = Date.UTC(2026, 10, 2);

const messages: MessageRecord[] = Array.from({ length: 5 }, (_, i) => {
  const at = createdAt + i * 60_000;
  return {
    messageId: uuidv7(),
    conversationId,
    senderUserId: i % 2 ? peer : self,
    senderDeviceId: uuidv7(),
    direction: i % 2 ? 'in' : 'out',
    kind: 'text',
    body: `fixture message ${i}`,
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
  };
});

const store = new MemoryEngineStore();
const outbound = crypto.createOutboundGroupSession();
const inbound = crypto.createInboundGroupSession(outbound.sessionKey());
await store.apply({
  account: 'fixture-account-pickle',
  conversations: [
    {
      conversationId,
      kind: 'direct',
      peerUserId: peer,
      createdAt,
      updatedAt: createdAt,
      lastMessageId: null,
      unreadCount: 0,
      pinnedAt: null,
      archived: false,
      mutedUntil: null,
    },
  ],
  messages,
  groups: [
    {
      groupId,
      version: 1,
      members: [
        { userId: self, role: 'owner' },
        { userId: peer, role: 'member' },
      ],
      serverVersion: 1,
      serverMembers: [],
      name: 'Fixture group',
      description: '',
      avatar: null,
      infoAt: createdAt,
      infoId: uuidv7(),
      left: false,
      createdAt,
      updatedAt: createdAt,
    },
  ],
  directory: [
    {
      userId: peer,
      accountIdentityKey: crypto.createSigningKey().publicKey(),
      keyVersion: 1,
      devices: [],
      fetchedAt: createdAt,
      verifiedIdentityKey: null,
    },
  ],
  inboundGroupSessions: [
    {
      sessionId: inbound.sessionId(),
      groupId,
      senderUserId: peer,
      senderDeviceId: uuidv7(),
      senderKey: 'fixture-curve-key',
      pickle: inbound.pickle(pickleKey),
      firstKnownIndex: 0,
      seenIndices: [0],
      createdAt,
      sharedAt: {},
    },
  ],
});

const sink = memorySink();
const writer = await BackupWriter.create({
  crypto,
  entropy: phraseEntropy(words),
  sink,
  // Small Argon2id costs so the test stays fast; the header records them.
  kdf: { memoryKib: 256, iterations: 1, parallelism: 1 },
  manifest: {
    createdAt,
    userId: self,
    accountIdentityKey: identity.publicKey(),
    app: 'fixture',
    includesFiles: false,
  },
});
await exportToBackup({
  store,
  crypto,
  pickleKey,
  writer,
  selfUserId: self,
  identitySecret: identity.exportSecret(),
  settings: { privacy: { readReceipts: false } },
});
await writer.finish();

// The Megolm session must still decrypt this after a restore.
const sample = outbound.encrypt(new TextEncoder().encode('fixture group message'));
const name = `pdbk-v${BACKUP_FORMAT_VERSION}`;
await writeFile(out(`${name}.pdbk`), sink.bytes());
await writeFile(
  out(`${name}.json`),
  `${JSON.stringify(
    {
      description:
        'Frozen backup fixture (Phase 27). Every later build must restore it; see packages/backup/src/compat.test.ts.',
      formatVersion: BACKUP_FORMAT_VERSION,
      phrase: words.join(' '),
      userId: self,
      peerUserId: peer,
      conversationId,
      groupId,
      identitySecret: identity.exportSecret(),
      accountIdentityKey: identity.publicKey(),
      messages: messages.map((m) => ({ messageId: m.messageId, body: m.body })),
      megolmSessionId: inbound.sessionId(),
      megolmSample: Buffer.from(sample).toString('base64'),
    },
    null,
    2,
  )}\n`,
);
console.log(`wrote ${out(`${name}.pdbk`)}`);
