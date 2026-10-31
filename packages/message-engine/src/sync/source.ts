/**
 * The phone's side of history sync (ADR 0021, REQ §13.2): it answers a linked browser's
 * request with bounded batches, one at a time, each acknowledged before the next.
 *
 * Its state per browser (the `device_sync_state` of REQ §14.1) is a setting in the encrypted
 * store: the request, the conversation order fixed at the start, and two cursors, after the
 * last acknowledged batch and after the batch in flight. A request that names the same sync
 * resumes after the batch the browser stored last; anything else starts over (the browser
 * skips messages it has by ID). After the last batch comes the manifest, per-conversation
 * counts the browser checks against what it stored.
 */
import { DEFAULT_LIMITS } from '@pingdost/config/public';
import {
  bytesToUuid,
  create,
  encodeSyncBatch,
  SyncBatchSchema,
  syncRecordSize,
  SyncStop_Reason,
  uuidToBytes,
  type SyncAck,
  type SyncBatch,
  type SyncFileRequest,
  type SyncRequest,
} from '@pingdost/protocol';

import type { EngineCore } from '../core';
import type { MessageCursor } from '../store';
import type { OwnContent, OwnDeviceChannel } from './channel';
import {
  conversationToSync,
  groupToSync,
  messageToSync,
  SYNC_BATCH_TARGET,
  SYNC_DATA_MAX,
} from './records';

/** Bytes of attachment ciphertext per `SyncFilePart` (one part fills one 48 KiB Content). */
export const FILE_PART_BYTES = 48_000;
/** A per-browser state untouched this long is dropped. */
const STATE_MAX_AGE_MS = 7 * 86_400_000;
/** No acknowledgement for this long: the browser went away, the sync shows as paused. */
const STALLED_MS = 45_000;
/** Messages read from the store per page while filling a batch. */
const PAGE = 100;

/** Reads attachment ciphertext the phone keeps (Android: the vault, ADR 0018). */
export interface SyncFiles {
  /**
   * Bytes `[offset, offset + length)` of the attachment's ciphertext, exactly as staged, and
   * its whole size; undefined when this device has no complete copy.
   */
  read(
    attachmentId: string,
    offset: number,
    length: number,
  ): Promise<{ data: Uint8Array; totalSize: number } | undefined>;
}

export interface SyncWindow {
  /** Messages from the last this many days; 0: any age. */
  days: number;
  maxPerConversation: number;
}

export const DEFAULT_SYNC_WINDOW: SyncWindow = {
  days: DEFAULT_LIMITS.syncRecentDays,
  maxPerConversation: DEFAULT_LIMITS.syncMaxPerConversation,
};

interface Cursor {
  /** Index into the state's conversations. */
  index: number;
  /** The current conversation's record went out already. */
  opened: boolean;
  /** Its oldest message sent so far (paging position) and how many were sent. */
  before: MessageCursor | null;
  taken: number;
}

interface Progress {
  sequence: number;
  cursor: Cursor;
  messages: number;
  counts: Record<string, number>;
  last: boolean;
}

interface SourceState {
  syncId: string;
  deviceId: string;
  days: number;
  maxPerConversation: number;
  /** Only messages older than this (a "load older" request). */
  before: MessageCursor | null;
  /** Messages older than this display time are outside the window (0: none). */
  cutoff: number;
  conversations: string[];
  acked: Progress;
  sent: Progress | null;
  done: boolean;
  paused: boolean;
  startedAt: number;
  updatedAt: number;
}

/** What the phone shows in Linked devices. */
export interface SyncSendProgress {
  deviceId: string;
  state: 'sending' | 'paused' | 'done';
  messages: number;
  conversationsDone: number;
  conversationsTotal: number;
  updatedAt: number;
}

const START: Cursor = { index: 0, opened: false, before: null, taken: 0 };

const stateKey = (deviceId: string) => `sync.source.${deviceId}`;

export class SyncSource {
  /** Browsers with a sync this session, for `progress()`. */
  readonly #known = new Set<string>();
  readonly #listeners = new Set<() => void>();

  constructor(
    private readonly core: EngineCore,
    private readonly channel: OwnDeviceChannel,
    private readonly files: SyncFiles | undefined,
  ) {}

  onProgress(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The syncs to linked browsers, as stored. */
  async progress(deviceIds: readonly string[]): Promise<SyncSendProgress[]> {
    const out: SyncSendProgress[] = [];
    for (const deviceId of new Set([...deviceIds, ...this.#known])) {
      const state = await this.#load(deviceId);
      if (!state) continue;
      const stalled = this.core.now() - state.updatedAt > STALLED_MS;
      out.push({
        deviceId,
        state: state.done ? 'done' : state.paused || stalled ? 'paused' : 'sending',
        messages: state.acked.messages,
        conversationsDone: Math.min(state.acked.cursor.index, state.conversations.length),
        conversationsTotal: state.conversations.length,
        updatedAt: state.updatedAt,
      });
    }
    return out;
  }

  async handle({ content, sender }: OwnContent): Promise<void> {
    const body = content.body;
    if (body.case !== 'syncChunk') return;
    const chunk = body.value;
    // Only this user's linked browsers get history (REQ §13.2).
    if (sender.device.platform !== 'web' && sender.device.role !== 'linked') {
      if (chunk.op.case === 'request') {
        await this.channel.send(sender.device, stop(chunk.syncId, SyncStop_Reason.REFUSED));
      }
      return;
    }
    const syncId = bytesToUuid(chunk.syncId);
    switch (chunk.op.case) {
      case 'request':
        await this.#onRequest(sender.device, syncId, chunk.op.value);
        break;
      case 'ack':
        await this.#onAck(sender.device, syncId, chunk.sequence, chunk.op.value);
        break;
      case 'stop':
        await this.core.commit({ settings: { [stateKey(sender.deviceId)]: null } });
        this.#changed();
        break;
      case 'fileRequest':
        await this.#onFileRequest(sender.device, syncId, chunk.op.value);
        break;
      default:
        break;
    }
  }

  async #onRequest(
    device: OwnContent['sender']['device'],
    syncId: string,
    request: SyncRequest,
  ): Promise<void> {
    let state = await this.#load(device.deviceId);
    let from: Progress | undefined;
    const resumeAfter = request.resumeAfter;
    if (state?.syncId === syncId && resumeAfter > 0) {
      if (state.sent && resumeAfter === state.sent.sequence) {
        // The browser stored the batch in flight; its acknowledgement was lost.
        state = { ...state, acked: state.sent, sent: null };
      }
      if (resumeAfter === state.acked.sequence) from = state.acked;
    }
    if (!state || !from || state.syncId !== syncId) {
      state = await this.#begin(device.deviceId, syncId, request);
      from = state.acked;
    }
    state = { ...state, paused: false };
    if (state.done || from.last) {
      await this.#save({ ...state, done: true });
      await this.#sendManifest(device, state);
      return;
    }
    await this.#sendNext(device, state, from);
  }

  async #onAck(
    device: OwnContent['sender']['device'],
    syncId: string,
    sequence: number,
    ack: SyncAck,
  ): Promise<void> {
    const state = await this.#load(device.deviceId);
    if (state?.syncId !== syncId) return;
    if (ack.pause && sequence === state.acked.sequence) {
      // Paused between batches: the browser drops the batch in flight and resumes later.
      await this.#save({ ...state, paused: true });
      return;
    }
    if (!state.sent || sequence !== state.sent.sequence) return; // stale
    if (!ack.ok) {
      // The browser's hash check failed: the same records again.
      this.core.log('warn', 'history batch rejected; sending it again', { sequence });
      await this.#sendNext(device, { ...state, sent: null }, state.acked);
      return;
    }
    const acked = state.sent;
    const next: SourceState = { ...state, acked, sent: null, paused: ack.pause };
    if (ack.pause) {
      await this.#save(next);
      return;
    }
    if (acked.last) {
      await this.#save({ ...next, done: true });
      await this.#sendManifest(device, next);
      return;
    }
    await this.#sendNext(device, next, acked);
  }

  async #onFileRequest(
    device: OwnContent['sender']['device'],
    syncId: string,
    request: SyncFileRequest,
  ): Promise<void> {
    const attachmentId = bytesToUuid(request.attachmentId);
    const offset = Number(request.offset);
    const length = Math.min(request.length, FILE_PART_BYTES);
    let part: Awaited<ReturnType<SyncFiles['read']>>;
    try {
      part = await this.files?.read(attachmentId, offset, length);
    } catch {
      part = undefined;
    }
    await this.channel.send(device, {
      case: 'syncChunk',
      value: {
        syncId: uuidToBytes(syncId),
        op: {
          case: 'filePart',
          value: {
            attachmentId: request.attachmentId,
            offset: request.offset,
            data: part?.data ?? new Uint8Array(0),
            missing: !part,
            totalSize: BigInt(part?.totalSize ?? 0),
          },
        },
      },
    });
  }

  /** A new sync: the conversations to cover, most recently active first. */
  async #begin(deviceId: string, syncId: string, request: SyncRequest): Promise<SourceState> {
    const { core } = this;
    const now = core.now();
    let conversations: string[];
    if (request.conversationId.length > 0) {
      const id = bytesToUuid(request.conversationId);
      conversations = (await core.store.getConversation(id)) ? [id] : [];
    } else {
      conversations = (await core.store.listConversations()).map((c) => c.conversationId);
    }
    const days = request.days;
    const before =
      request.beforeMessageId.length > 0
        ? {
            sortAt: Number(request.beforeSortAtMs),
            messageId: bytesToUuid(request.beforeMessageId),
          }
        : null;
    const state: SourceState = {
      syncId,
      deviceId,
      days,
      maxPerConversation:
        request.maxPerConversation > 0
          ? request.maxPerConversation
          : DEFAULT_SYNC_WINDOW.maxPerConversation,
      before,
      cutoff: days > 0 ? now - days * 86_400_000 : 0,
      conversations,
      acked: {
        sequence: 0,
        cursor: START,
        messages: 0,
        counts: {},
        last: conversations.length === 0,
      },
      sent: null,
      done: false,
      paused: false,
      startedAt: now,
      updatedAt: now,
    };
    core.log('info', 'history sync started', { conversations: conversations.length });
    return state;
  }

  async #sendNext(
    device: OwnContent['sender']['device'],
    state: SourceState,
    from: Progress,
  ): Promise<void> {
    const { batch, next } = await this.#build(state, from);
    const data = encodeSyncBatch(batch, SYNC_DATA_MAX);
    const sent: Progress = { ...next, sequence: from.sequence + 1 };
    // Stored before sending: a resume after a lost acknowledgement continues from here.
    await this.#save({ ...state, sent });
    const result = await this.channel.send(device, {
      case: 'syncChunk',
      value: {
        syncId: uuidToBytes(state.syncId),
        sequence: sent.sequence,
        last: sent.last,
        data,
        dataSha256: this.core.options.crypto.sha256(data),
      },
    });
    if (!result.ok) {
      // The browser went offline: it asks again when it is back.
      this.core.log('info', 'history batch not delivered', { code: result.code });
    }
  }

  async #sendManifest(device: OwnContent['sender']['device'], state: SourceState): Promise<void> {
    const { acked } = state;
    await this.channel.send(device, {
      case: 'syncChunk',
      value: {
        syncId: uuidToBytes(state.syncId),
        sequence: acked.sequence,
        op: {
          case: 'manifest',
          value: {
            batches: acked.sequence,
            counts: Object.entries(acked.counts).map(([conversationId, messages]) => ({
              conversationId: uuidToBytes(conversationId),
              messages,
            })),
          },
        },
      },
    });
    this.core.log('info', 'history sync sent', {
      batches: acked.sequence,
      messages: acked.messages,
    });
  }

  /** Fills one batch from `from`: conversation records first, then their messages, newest first. */
  async #build(state: SourceState, from: Progress): Promise<{ batch: SyncBatch; next: Progress }> {
    const { store } = this.core;
    const batch = create(SyncBatchSchema, {});
    let size = 0;
    let cursor: Cursor = { ...from.cursor };
    const counts = { ...from.counts };
    let messages = from.messages;
    // The first record always fits, so every batch makes progress.
    const fits = (n: number) => size + n <= SYNC_BATCH_TARGET || size === 0;

    fill: while (cursor.index < state.conversations.length) {
      const conversationId = state.conversations[cursor.index]!;
      const conversation = await store.getConversation(conversationId);
      if (!conversation) {
        cursor = { ...START, index: cursor.index + 1 };
        continue;
      }
      if (!cursor.opened) {
        const record = conversationToSync(conversation);
        const group =
          conversation.kind === 'group' ? await store.getGroup(conversationId) : undefined;
        const groupRecord = group ? groupToSync(group) : undefined;
        const n =
          syncRecordSize({ case: 'conversation', value: record }) +
          (groupRecord ? syncRecordSize({ case: 'group', value: groupRecord }) : 0);
        if (!fits(n)) break;
        batch.conversations.push(record);
        if (groupRecord) batch.groups.push(groupRecord);
        size += n;
        cursor = { ...cursor, opened: true };
      }
      let ended = false;
      while (!ended && cursor.taken < state.maxPerConversation) {
        const limit = Math.min(PAGE, state.maxPerConversation - cursor.taken);
        const before = cursor.before ?? state.before;
        const page = await store.listMessages(conversationId, {
          ...(before ? { before } : {}),
          limit,
        });
        ended = page.length < limit;
        for (const message of page) {
          if (message.sortAt < state.cutoff) {
            ended = true;
            break;
          }
          const position = { sortAt: message.sortAt, messageId: message.messageId };
          const record = messageToSync(message);
          const n = syncRecordSize({ case: 'message', value: record });
          if (n > SYNC_DATA_MAX - 1_024) {
            // Larger than any batch (a huge text): it stays on the phone.
            this.core.log('warn', 'history message too large to sync');
            cursor = { ...cursor, before: position };
            continue;
          }
          if (!fits(n)) break fill;
          batch.messages.push(record);
          size += n;
          cursor = { ...cursor, before: position, taken: cursor.taken + 1 };
          counts[conversationId] = (counts[conversationId] ?? 0) + 1;
          messages++;
          if (cursor.taken >= state.maxPerConversation) break;
        }
      }
      cursor = { ...START, index: cursor.index + 1 };
    }
    batch.conversationsDone = Math.min(cursor.index, state.conversations.length);
    batch.conversationsTotal = state.conversations.length;
    return {
      batch,
      next: {
        sequence: from.sequence,
        cursor,
        messages,
        counts,
        last: cursor.index >= state.conversations.length,
      },
    };
  }

  async #load(deviceId: string): Promise<SourceState | undefined> {
    const state = (await this.core.store.getSetting(stateKey(deviceId))) as
      SourceState | undefined | null;
    if (!state) return undefined;
    if (this.core.now() - state.updatedAt > STATE_MAX_AGE_MS) {
      await this.core.commit({ settings: { [stateKey(deviceId)]: null } });
      return undefined;
    }
    return state;
  }

  async #save(state: SourceState): Promise<void> {
    this.#known.add(state.deviceId);
    await this.core.commit({
      settings: { [stateKey(state.deviceId)]: { ...state, updatedAt: this.core.now() } },
    });
    this.#changed();
  }

  #changed(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

export function stop(syncId: Uint8Array, reason: SyncStop_Reason) {
  return {
    case: 'syncChunk' as const,
    value: { syncId, op: { case: 'stop' as const, value: { reason } } },
  };
}
