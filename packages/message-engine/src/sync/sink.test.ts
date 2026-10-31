/**
 * The browser's integrity checks (ADR 0021), against a stub channel: a batch with the wrong
 * hash is rejected, a manifest that does not match what arrived runs the sync once more, and
 * a second mismatch fails it.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { createWasmCryptoProvider, type CryptoProvider } from '@pingdost/crypto';
import {
  ContentSchema,
  create,
  directConversationIdFor,
  encodeSyncBatch,
  PROTOCOL_VERSION,
  SyncBatchSchema,
  uuidToBytes,
  uuidv7,
  type ContentSchema as ContentDesc,
  type MessageInitShape,
} from '@pingdost/protocol';
import { ValueStream } from '@pingdost/transport';

import { EngineCore } from '../core';
import { MemoryEngineStore } from '../memoryStore';
import type { DirectoryDeviceRecord, MessageRecord } from '../store';
import { eventually } from '../testing';
import type { OwnContent, OwnDeviceChannel } from './channel';
import { conversationToSync, messageToSync, SYNC_DATA_MAX } from './records';
import { SyncSink } from './sink';

type Body = MessageInitShape<typeof ContentDesc>['body'];

let crypto: CryptoProvider;

beforeAll(async () => {
  crypto = await createWasmCryptoProvider();
});

const PHONE: DirectoryDeviceRecord = {
  deviceId: uuidv7(),
  platform: 'android',
  role: 'primary',
  curve25519: 'phone-curve',
  ed25519: 'phone-ed',
  fallbackKey: null,
};

function setup() {
  const userId = uuidv7();
  const store = new MemoryEngineStore();
  const core = new EngineCore({
    self: { userId, deviceId: uuidv7() },
    crypto,
    account: crypto.createAccount(),
    pickleKey: new Uint8Array(32).fill(1),
    store,
    transport: {
      status$: new ValueStream('online' as const),
      send: () => Promise.resolve({ ok: true, status: 'stored' as const }),
      onPacket: () => () => undefined,
    },
    api: {} as never,
  });
  const sent: Body[] = [];
  const channel = {
    ownDevices: () => Promise.resolve([PHONE]),
    send: (_device: DirectoryDeviceRecord, body: Body) => {
      sent.push(body);
      return Promise.resolve({ ok: true as const, status: 'delivered_transport' as const });
    },
  } as unknown as OwnDeviceChannel;
  const sink = new SyncSink(core, channel, { autoStart: false, groupsArrived: () => undefined });
  return { userId, store, sink, sent };
}

/** Content the phone would send. */
function fromPhone(userId: string, value: object): OwnContent {
  const content = create(ContentSchema, {
    header: {
      version: PROTOCOL_VERSION,
      messageId: uuidToBytes(uuidv7()),
      conversationId: uuidToBytes(directConversationIdFor(userId, userId)),
      senderUserId: uuidToBytes(userId),
      recipientUserId: uuidToBytes(userId),
      sentAtMs: BigInt(Date.now()),
    },
    body: { case: 'syncChunk', value },
  });
  return { content, sender: { ...PHONE, userId, device: PHONE } };
}

function batchOf(userId: string, count: number) {
  const peer = uuidv7();
  const conversationId = directConversationIdFor(userId, peer);
  const now = Date.now();
  const messages: MessageRecord[] = Array.from({ length: count }, (_, i) => ({
    messageId: uuidv7(),
    conversationId,
    senderUserId: peer,
    senderDeviceId: uuidv7(),
    direction: 'in',
    kind: 'text',
    body: `hello ${i}`,
    attachment: null,
    replyTo: null,
    sentAt: now - i,
    sortAt: now - i,
    createdAt: now,
    state: null,
    expiresAt: null,
    editedAt: null,
    editId: null,
    deletedAt: null,
    readAt: null,
    reactions: [],
  }));
  const data = encodeSyncBatch(
    create(SyncBatchSchema, {
      conversations: [
        conversationToSync({
          conversationId,
          kind: 'direct',
          peerUserId: peer,
          createdAt: now,
          updatedAt: now,
          lastMessageId: null,
          unreadCount: 0,
          pinnedAt: null,
          archived: false,
          mutedUntil: null,
        }),
      ],
      messages: messages.map(messageToSync),
      conversationsDone: 1,
      conversationsTotal: 1,
    }),
    SYNC_DATA_MAX,
  );
  return { conversationId, data };
}

const requests = (sent: Body[]) =>
  sent.filter((b) => b?.case === 'syncChunk' && b.value.op?.case === 'request');
const acks = (sent: Body[]) =>
  sent.flatMap((b) =>
    b?.case === 'syncChunk' && b.value.op?.case === 'ack' ? [b.value.op.value] : [],
  );

describe('SyncSink integrity', () => {
  it('rejects a batch with the wrong hash, then stores the right one', async () => {
    const { userId, store, sink, sent } = setup();
    await sink.start();
    await sink.syncRecent();
    await eventually(() => requests(sent).length === 1);
    const syncId = (requests(sent)[0] as { value: { syncId: Uint8Array } }).value.syncId;
    const { data } = batchOf(userId, 3);
    const wrong = crypto.sha256(new Uint8Array([1, 2, 3]));
    await sink.handle(
      fromPhone(userId, { syncId, sequence: 1, last: true, data, dataSha256: wrong }),
    );
    expect(acks(sent)).toEqual([expect.objectContaining({ ok: false })]);
    expect(store.allMessages()).toHaveLength(0);
    await sink.handle(
      fromPhone(userId, { syncId, sequence: 1, last: true, data, dataSha256: crypto.sha256(data) }),
    );
    expect(acks(sent).at(-1)).toMatchObject({ ok: true });
    expect(store.allMessages()).toHaveLength(3);
    sink.stop();
  });

  it('runs the sync again when the manifest does not match, then fails', async () => {
    const { userId, store, sink, sent } = setup();
    await sink.start();
    await sink.syncRecent();
    await eventually(() => requests(sent).length === 1);
    const syncId = (requests(sent)[0] as { value: { syncId: Uint8Array } }).value.syncId;
    const { conversationId, data } = batchOf(userId, 4);
    const batch = { syncId, sequence: 1, last: true, data, dataSha256: crypto.sha256(data) };
    // The phone claims 5 messages; 4 arrived.
    const manifest = {
      syncId,
      sequence: 1,
      op: {
        case: 'manifest',
        value: {
          batches: 1,
          counts: [{ conversationId: uuidToBytes(conversationId), messages: 5 }],
        },
      },
    };
    await sink.handle(fromPhone(userId, batch));
    await sink.handle(fromPhone(userId, manifest));
    // Once more from the start.
    await eventually(() => requests(sent).length === 2);
    const again = requests(sent)[1] as { value: { op: { value: { resumeAfter: number } } } };
    expect(again.value.op.value.resumeAfter).toBe(0);
    expect(sink.status.state).not.toBe('failed');
    // The same again: now it fails, and says why.
    await sink.handle(fromPhone(userId, batch));
    expect(store.allMessages()).toHaveLength(4); // the repeat added nothing
    await sink.handle(fromPhone(userId, manifest));
    expect(sink.status).toMatchObject({ state: 'failed', error: 'integrity' });
    sink.stop();
  });

  it('passes a matching manifest', async () => {
    const { userId, sink, sent } = setup();
    await sink.start();
    await sink.syncRecent();
    await eventually(() => requests(sent).length === 1);
    const syncId = (requests(sent)[0] as { value: { syncId: Uint8Array } }).value.syncId;
    const { conversationId, data } = batchOf(userId, 2);
    await sink.handle(
      fromPhone(userId, { syncId, sequence: 1, last: true, data, dataSha256: crypto.sha256(data) }),
    );
    await sink.handle(
      fromPhone(userId, {
        syncId,
        sequence: 1,
        op: {
          case: 'manifest',
          value: {
            batches: 1,
            counts: [{ conversationId: uuidToBytes(conversationId), messages: 2 }],
          },
        },
      }),
    );
    expect(sink.status).toMatchObject({ state: 'done', messages: 2 });
    expect(sink.status.recentSyncedAt).not.toBeNull();
    sink.stop();
  });
});
