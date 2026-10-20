/**
 * Attachment messages end to end over the fake server, with real vodozemac and the real
 * attachment AEAD (Phase 14): the manifest travels E2EE (Olm, and Megolm in groups), the
 * receiver keeps it and can decrypt the staged ciphertext with it; delete for everyone drops
 * the key; invalid manifests are refused or kept as placeholders.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildManifest, decryptStream, encryptStream } from '@pingdost/attachments';
import { createWasmCryptoProvider, type CryptoProvider } from '@pingdost/crypto';
import {
  AttachmentManifestSchema,
  create,
  decodeContent,
  uuidToBytes,
  uuidv7,
  type AttachmentManifest,
} from '@pingdost/protocol';

import { attachmentContentFor, attachmentDecryptInput, readAttachment } from './attachments';
import { buildContent } from './content';
import { MessageActionError } from './errors';
import type { AttachmentInfo, MessageRecord } from './store';
import {
  createTestClient,
  eventually,
  FakeServer,
  messageRecord,
  type TestClient,
} from './testing';

let crypto: CryptoProvider;
const running: TestClient[] = [];

beforeAll(async () => {
  crypto = await createWasmCryptoProvider();
});

afterEach(async () => {
  for (const client of running.splice(0)) await client.engine.stop();
});

async function client(server: FakeServer, options: Parameters<typeof createTestClient>[2] = {}) {
  const created = await createTestClient(server, crypto, { oneTimeKeys: 20, ...options });
  running.push(created);
  return created;
}

async function online(...clients: TestClient[]): Promise<void> {
  for (const c of clients) {
    c.transport.connect();
    await c.engine.start();
  }
}

/** A file read in pieces, as a platform would feed it. */
async function* chunksOf(data: Uint8Array, size = 10_000): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < data.length; i += size) {
    await Promise.resolve();
    yield data.subarray(i, i + size);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const part of source) parts.push(part);
  return concat(parts);
}

/** Varied bytes standing for a file. */
const fileBytes = (size: number) => Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7) & 255);

/** Encrypts `plaintext` as a sender would; the ciphertext stands for the staged object. */
async function encrypt(plaintext: Uint8Array) {
  const stream = encryptStream(crypto, chunksOf(plaintext));
  const parts: Uint8Array[] = [];
  for (;;) {
    const next = await stream.next();
    if (next.done) return { encrypted: next.value, ciphertext: concat(parts) };
    parts.push(next.value);
  }
}

async function photo(caption = '') {
  const plaintext = fileBytes(150_000);
  const { encrypted, ciphertext } = await encrypt(plaintext);
  const thumb = await encrypt(fileBytes(2_000));
  const manifest = buildManifest({
    attachmentId: uuidv7(),
    encrypted,
    mimeType: 'image/jpeg',
    fileName: '../../DCIM/IMG_0042.jpg',
    caption,
    thumbnail: buildManifest({
      attachmentId: uuidv7(),
      encrypted: thumb.encrypted,
      mimeType: 'image/webp',
    }),
  });
  return { plaintext, ciphertext, manifest };
}

function attachmentsOf(c: TestClient, conversationId: string): MessageRecord[] {
  return c.store
    .allMessages()
    .filter((m) => m.conversationId === conversationId && m.kind === 'attachment');
}

describe('attachment messages', () => {
  it('sends a manifest E2EE; the recipient decrypts the staged file with what it kept', async () => {
    const server = new FakeServer();
    const alice = await client(server);
    const alice2 = await client(server, { sameUserAs: alice });
    const bob = await client(server);
    await online(alice, alice2, bob);
    const { conversationId } = await alice.engine.openDirectConversation(bob.userId);

    // The devices to stage for: the peer's and this user's other devices, never this one.
    expect((await alice.engine.attachmentRecipients(conversationId)).sort()).toEqual(
      [bob.deviceId, alice2.deviceId].sort(),
    );

    const { plaintext, ciphertext, manifest } = await photo('the view from here');
    const sent = await alice.engine.sendAttachment(conversationId, manifest);
    expect(sent).toMatchObject({ kind: 'attachment', body: 'the view from here' });
    expect(sent.attachment).toMatchObject({
      mimeType: 'image/jpeg',
      fileName: 'IMG_0042.jpg',
      plaintextSize: 150_000,
      thumbnail: { mimeType: 'image/webp', fileName: null, thumbnail: null },
    });

    await eventually(() => attachmentsOf(bob, conversationId).length === 1, 3_000, 'bob');
    const [received] = attachmentsOf(bob, conversationId);
    expect(received).toMatchObject({
      messageId: sent.messageId,
      direction: 'in',
      body: 'the view from here',
      attachment: sent.attachment,
    });
    const opened = await collect(
      decryptStream(crypto, attachmentDecryptInput(received!.attachment!), chunksOf(ciphertext)),
    );
    expect(opened).toEqual(plaintext);

    // This user's other device files its own copy.
    await eventually(() => attachmentsOf(alice2, conversationId).length === 1, 3_000, 'alice2');
    expect(attachmentsOf(alice2, conversationId)[0]).toMatchObject({
      direction: 'out',
      attachment: sent.attachment,
    });
    await eventually(
      async () =>
        (await alice.engine.getMessage(sent.messageId))?.state === 'delivered_to_recipient_device',
      3_000,
      'delivered',
    );

    // Reactions work; delete for everyone leaves no key behind.
    await bob.engine.react(sent.messageId, '❤️');
    await eventually(
      async () => (await alice.engine.getMessage(sent.messageId))?.reactions.length === 1,
    );
    await alice.engine.deleteForEveryone(sent.messageId);
    await eventually(
      async () => (await bob.engine.getMessage(sent.messageId))?.kind === 'deleted',
      3_000,
      'tombstone',
    );
    expect((await bob.engine.getMessage(sent.messageId))?.attachment).toBeNull();
    expect((await alice.engine.getMessage(sent.messageId))?.attachment).toBeNull();
  });

  it('sends attachments to a group over Megolm', async () => {
    const server = new FakeServer();
    const alice = await client(server);
    const bob = await client(server);
    const carol = await client(server);
    await online(alice, bob, carol);
    const { conversationId: groupId } = await alice.engine.createGroup({
      name: 'Trip',
      memberUserIds: [bob.userId, carol.userId],
    });
    await eventually(async () => (await carol.engine.getGroup(groupId)) !== undefined);
    expect((await alice.engine.attachmentRecipients(groupId)).sort()).toEqual(
      [bob.deviceId, carol.deviceId].sort(),
    );

    const { manifest } = await photo();
    const sent = await alice.engine.sendAttachment(groupId, manifest);
    await eventually(
      () => attachmentsOf(bob, groupId).length === 1 && attachmentsOf(carol, groupId).length === 1,
      3_000,
      'both members',
    );
    expect(attachmentsOf(carol, groupId)[0]).toMatchObject({
      messageId: sent.messageId,
      senderUserId: alice.userId,
      body: '',
      attachment: sent.attachment,
    });
  });

  it('refuses an invalid manifest to send, and stores nothing', async () => {
    const server = new FakeServer();
    const alice = await client(server);
    const bob = await client(server);
    await online(alice, bob);
    const { conversationId } = await alice.engine.openDirectConversation(bob.userId);
    const { manifest } = await photo();
    const bad: AttachmentManifest = { ...manifest, key: new Uint8Array(16) };
    await expect(alice.engine.sendAttachment(conversationId, bad)).rejects.toBeInstanceOf(
      MessageActionError,
    );
    expect(alice.store.allMessages()).toHaveLength(0);
  });

  it('keeps a placeholder for a received manifest that fails the checks', async () => {
    const server = new FakeServer();
    const alice = await client(server);
    const bob = await client(server);
    await alice.engine.start();
    await online(bob);
    const { conversationId } = await alice.engine.openDirectConversation(bob.userId);
    const { manifest } = await photo();
    // Queued straight into the outbox: the engine itself refuses to send this.
    const messageId = uuidv7();
    const now = Date.now();
    const content = buildContent(
      {
        messageId,
        conversationId,
        senderUserId: alice.userId,
        recipientUserId: bob.userId,
        sentAt: now,
      },
      { case: 'attachmentManifest', value: { ...manifest, scheme: 'aes-gcm/1' } },
    );
    await alice.store.apply({
      outbox: [
        {
          type: 'fanout',
          purpose: 'control',
          id: messageId,
          messageId,
          conversationId,
          recipientUserIds: [bob.userId],
          content,
          createdAt: now,
          expiresAt: now + 60_000,
          attempts: 0,
          nextAttemptAt: now,
        },
      ],
    });
    alice.transport.connect();
    await eventually(async () => (await bob.engine.getMessage(messageId)) !== undefined);
    expect(await bob.engine.getMessage(messageId)).toMatchObject({
      kind: 'unsupported',
      body: '',
      attachment: null,
    });
  });
});

describe('attachment manifests', () => {
  it('round-trip through Content, caption and thumbnail included', async () => {
    const { manifest } = await photo('caption');
    const read = readAttachment(manifest)!;
    const message = messageRecord({
      kind: 'attachment',
      body: read.caption,
      attachment: read.info,
    });
    const content = decodeContent(attachmentContentFor(message, uuidv7()));
    expect(content.body.case).toBe('attachmentManifest');
    const again = readAttachment(content.body.value as AttachmentManifest);
    expect(again).toEqual(read);
  });

  it('are rejected when anything is off', () => {
    const valid = (): AttachmentManifest =>
      create(AttachmentManifestSchema, {
        attachmentId: uuidToBytes(uuidv7()),
        scheme: 'xchacha20poly1305-stream-be32-64k/1',
        key: new Uint8Array(32),
        noncePrefix: new Uint8Array(19),
        plaintextSize: 10n,
        chunkSize: 65_536,
        chunkCount: 1,
        mimeType: 'text/plain',
        ciphertextSha256: new Uint8Array(32),
        chunkHashListSha256: new Uint8Array(32),
      });
    expect(readAttachment(valid())?.info).toMatchObject<Partial<AttachmentInfo>>({
      plaintextSize: 10,
      ciphertextSize: 26,
    });
    const broken: Partial<AttachmentManifest>[] = [
      { scheme: 'aes-gcm/1' },
      { key: new Uint8Array(31) },
      { noncePrefix: new Uint8Array(24) },
      { chunkCount: 2 },
      { chunkSize: 1_024 },
      { plaintextSize: 10n ** 12n },
      { mimeType: 'text/plain; charset=utf-8' },
      { ciphertextSha256: new Uint8Array(0) },
      { attachmentId: new Uint8Array(4) },
    ];
    for (const change of broken) {
      expect(readAttachment({ ...valid(), ...change }), JSON.stringify(Object.keys(change))).toBe(
        undefined,
      );
    }
  });
});
