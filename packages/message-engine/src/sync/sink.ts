/**
 * The browser's side of history sync (ADR 0021, REQ §13.2). It asks the phone for the recent
 * window (and, on request, older messages of one conversation), stores each batch, and
 * acknowledges it.
 *
 * - **Integrity:** a batch whose SHA-256 does not match is rejected and sent again; the final
 *   manifest's per-conversation counts must equal what arrived, or the sync runs once more.
 * - **Atomic progress:** a batch's records and the new cursor are one store write, so killing
 *   the tab at any point resumes after the last stored batch. Messages already here are
 *   skipped by ID; edits, deletes and reactions waiting for them are applied.
 * - **Availability:** the phone must be online. When it is not, the sync says so ("phone
 *   offline") and tries again with backoff; when this device is offline, it waits for the
 *   connection. The server never holds any of it.
 */
import {
  bytesEqual,
  bytesToUuid,
  decodeSyncBatch,
  SyncStop_Reason,
  uuidToBytes,
  uuidv7,
  type SyncBatch,
  type SyncChunk,
  type SyncManifest,
} from '@pingdost/protocol';
import type { SendResult } from '@pingdost/transport';

import type { EngineCore } from '../core';
import { SyncError } from '../errors';
import { applyPending } from '../features/ops';
import { compareMessages } from '../memoryStore';
import type {
  ConversationRecord,
  DirectoryDeviceRecord,
  MessageCursor,
  MessageRecord,
  WriteBatch,
} from '../store';
import type { OwnContent, OwnDeviceChannel } from './channel';
import { conversationFromSync, groupFromSync, messageFromSync, SYNC_DATA_MAX } from './records';
import { DEFAULT_SYNC_WINDOW, FILE_PART_BYTES, stop, type SyncWindow } from './source';

const STATE_KEY = 'sync.sink';
const RECENT_AT_KEY = 'sync.sink.recentAt';
/** No batch for this long after a request or an ack: ask again (resume). */
const WATCHDOG_MS = 15_000;
/** Retries while the phone is offline. */
const OFFLINE_RETRY_MS = [15_000, 30_000, 60_000, 120_000, 300_000];
/** Rejected batches in a row before the sync gives up. */
const MAX_NACKS = 3;
/** Older messages per "load older" request. */
const OLDER_PAGE = 200;
/** How long a file part may take. */
const FILE_PART_TIMEOUT_MS = 20_000;

export type HistorySyncState =
  /** Never synced, or nothing running. */
  | 'idle'
  /** Asked the phone; no batch yet. */
  | 'requesting'
  | 'syncing'
  | 'paused'
  /** "Phone offline — sync paused": retried automatically. */
  | 'phone_offline'
  /** This device is offline: resumes when the connection is back. */
  | 'offline'
  | 'done'
  | 'failed';

export interface HistorySyncStatus {
  state: HistorySyncState;
  /** One conversation ("load older messages"), or null for the recent window. */
  conversationId: string | null;
  /** Messages received in this sync (including ones already here). */
  messages: number;
  conversationsDone: number;
  conversationsTotal: number;
  /** When the recent-window sync last completed. */
  recentSyncedAt: number | null;
  error: 'integrity' | 'refused' | 'no_phone' | null;
  window: SyncWindow;
}

interface SinkState {
  syncId: string;
  window: SyncWindow;
  conversationId: string | null;
  before: MessageCursor | null;
  /** The last batch stored. */
  lastStored: number;
  messages: number;
  counts: Record<string, number>;
  conversationsDone: number;
  conversationsTotal: number;
  status: 'running' | 'paused' | 'done' | 'failed';
  error: HistorySyncStatus['error'];
  /** Whole-sync restarts after a manifest mismatch, and rejected batches in a row. */
  restarts: number;
  nacks: number;
  startedAt: number;
  completedAt: number | null;
}

type Live = 'requesting' | 'syncing' | 'phone_offline' | 'offline';

interface FileWait {
  resolve(part: { data: Uint8Array; totalSize: number }): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class SyncSink {
  #state: SinkState | null = null;
  #recentAt: number | null = null;
  #live: Live = 'requesting';
  #timer: ReturnType<typeof setTimeout> | undefined;
  #offlineAttempts = 0;
  #started = false;
  /** One request or batch is handled at a time. */
  #work: Promise<void> = Promise.resolve();
  readonly #listeners = new Set<(status: HistorySyncStatus) => void>();
  readonly #files = new Map<string, FileWait>();
  /** File requests name a sync; one ID serves them all. */
  readonly #fileSyncId = uuidv7();

  constructor(
    private readonly core: EngineCore,
    private readonly channel: OwnDeviceChannel,
    private readonly options: {
      /** Start the recent-window sync by itself when this device never synced (web). */
      autoStart: boolean;
      window?: SyncWindow;
      /** Delays between tries while the phone is offline; default 15 s rising to 5 min. */
      retryMs?: readonly number[];
      /** Group state arrived: group traffic held for it can be read now. */
      groupsArrived: (groupIds: string[]) => void;
    },
  ) {}

  get status(): HistorySyncStatus {
    const state = this.#state;
    const window = state?.window ?? this.options.window ?? DEFAULT_SYNC_WINDOW;
    const base = {
      conversationId: state?.conversationId ?? null,
      messages: state?.messages ?? 0,
      conversationsDone: state?.conversationsDone ?? 0,
      conversationsTotal: state?.conversationsTotal ?? 0,
      recentSyncedAt: this.#recentAt,
      error: state?.error ?? null,
      window,
    };
    if (!state) return { ...base, state: 'idle' };
    if (state.status !== 'running') return { ...base, state: state.status };
    return { ...base, state: this.#live };
  }

  onStatus(listener: (status: HistorySyncStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Loads the stored sync and resumes it, or starts the first one (`autoStart`). */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    const { store } = this.core;
    this.#state = ((await store.getSetting(STATE_KEY)) as SinkState | null | undefined) ?? null;
    this.#recentAt = ((await store.getSetting(RECENT_AT_KEY)) as number | null | undefined) ?? null;
    if (!this.#state && this.options.autoStart) {
      await this.syncRecent(this.options.window);
      return;
    }
    this.#emit();
    if (this.#state?.status === 'running') this.#schedule(0);
  }

  stop(): void {
    this.#started = false;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const [key, wait] of this.#files) {
      clearTimeout(wait.timer);
      wait.reject(new SyncError('offline', 'PingDost stopped'));
      this.#files.delete(key);
    }
  }

  /** This device's connection changed: a running sync waits for it, then resumes. */
  connection(online: boolean): void {
    if (this.#state?.status !== 'running') return;
    if (!online) {
      this.#setLive('offline');
      return;
    }
    this.#offlineAttempts = 0;
    this.#schedule(0);
  }

  /** Starts (or restarts) the recent-window sync. */
  async syncRecent(window: SyncWindow = this.options.window ?? DEFAULT_SYNC_WINDOW): Promise<void> {
    await this.#begin({ window, conversationId: null, before: null });
  }

  /** Asks the phone for messages of one conversation older than `before`. */
  async loadOlder(conversationId: string, before: MessageCursor | null): Promise<void> {
    if (this.#state?.status === 'running') {
      throw new SyncError('busy', 'Wait until the history sync finishes.');
    }
    await this.#begin({
      window: { days: 0, maxPerConversation: OLDER_PAGE },
      conversationId,
      before,
    });
  }

  pause(): Promise<void> {
    return this.#serial(async () => {
      const state = this.#state;
      if (state?.status !== 'running') return;
      clearTimeout(this.#timer);
      await this.#save({ ...state, status: 'paused' });
      // Best effort: the phone shows the sync as paused. A batch in flight is dropped here
      // and sent again on resume.
      const phone = await this.#phone();
      if (phone) {
        void this.channel.send(phone, {
          case: 'syncChunk',
          value: {
            syncId: uuidToBytes(state.syncId),
            sequence: state.lastStored,
            op: { case: 'ack', value: { ok: true, pause: true } },
          },
        });
      }
    });
  }

  /** Resumes a paused sync, or tries a failed one again. */
  resume(): Promise<void> {
    return this.#serial(async () => {
      const state = this.#state;
      if (state?.status !== 'paused' && state?.status !== 'failed') return;
      this.#offlineAttempts = 0;
      this.#live = state.lastStored > 0 ? 'syncing' : 'requesting';
      await this.#save({ ...state, status: 'running', error: null, nacks: 0 });
      this.#schedule(0);
    });
  }

  /**
   * Bytes of an attachment's ciphertext from the phone (ADR 0021): at most
   * `FILE_PART_BYTES`, with the whole size. Throws `SyncError`.
   */
  async fetchFilePart(
    attachmentId: string,
    offset: number,
    length: number = FILE_PART_BYTES,
  ): Promise<{ data: Uint8Array; totalSize: number }> {
    const phone = await this.#phone();
    if (!phone) throw new SyncError('no_phone', 'No phone is linked to this account.');
    const key = `${attachmentId}:${offset}`;
    const waiting = new Promise<{ data: Uint8Array; totalSize: number }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#files.delete(key);
        reject(new SyncError('timeout', 'Your phone did not answer.'));
      }, FILE_PART_TIMEOUT_MS);
      this.#files.get(key)?.reject(new SyncError('timeout', 'Asked again.'));
      this.#files.set(key, { resolve, reject, timer });
    });
    const result = await this.channel.send(phone, {
      case: 'syncChunk',
      value: {
        syncId: uuidToBytes(this.#fileSyncId),
        op: {
          case: 'fileRequest',
          value: {
            attachmentId: uuidToBytes(attachmentId),
            offset: BigInt(offset),
            length: Math.min(length, FILE_PART_BYTES),
          },
        },
      },
    });
    if (!result.ok) {
      const wait = this.#files.get(key);
      if (wait) {
        clearTimeout(wait.timer);
        this.#files.delete(key);
        wait.reject(
          result.code === 'RECIPIENT_OFFLINE'
            ? new SyncError('phone_offline', 'Your phone is offline.')
            : new SyncError('offline', 'You are offline.'),
        );
      }
    }
    return waiting;
  }

  async handle({ content }: OwnContent): Promise<void> {
    const body = content.body;
    if (body.case !== 'syncChunk') return;
    const chunk = body.value;
    if (chunk.op.case === 'filePart') {
      const part = chunk.op.value;
      const key = `${bytesToUuid(part.attachmentId)}:${Number(part.offset)}`;
      const wait = this.#files.get(key);
      if (!wait) return;
      clearTimeout(wait.timer);
      this.#files.delete(key);
      if (part.missing)
        wait.reject(new SyncError('missing', 'Your phone does not have this file.'));
      else wait.resolve({ data: part.data, totalSize: Number(part.totalSize) });
      return;
    }
    await this.#serial(async () => {
      const state = this.#state;
      const syncId = bytesToUuid(chunk.syncId);
      if (state?.syncId !== syncId || state.status !== 'running') return;
      switch (chunk.op.case) {
        case undefined:
          await this.#onBatch(state, chunk);
          break;
        case 'manifest':
          await this.#onManifest(state, chunk.op.value);
          break;
        case 'stop':
          if (chunk.op.value.reason === SyncStop_Reason.REFUSED) {
            await this.#save({ ...state, status: 'failed', error: 'refused' });
          }
          break;
        default:
          break;
      }
    });
  }

  /** Resolves once queued work is done (tests). */
  idle(): Promise<void> {
    return this.#work;
  }

  // Internals

  async #begin(scope: Pick<SinkState, 'window' | 'conversationId' | 'before'>): Promise<void> {
    await this.#serial(async () => {
      clearTimeout(this.#timer);
      this.#offlineAttempts = 0;
      this.#live = 'requesting';
      await this.#save({
        ...scope,
        syncId: uuidv7(),
        lastStored: 0,
        messages: 0,
        counts: {},
        conversationsDone: 0,
        conversationsTotal: 0,
        status: 'running',
        error: null,
        restarts: 0,
        nacks: 0,
        startedAt: this.core.now(),
        completedAt: null,
      });
    });
    this.#schedule(0);
  }

  #serial(work: () => Promise<void>): Promise<void> {
    const next = this.#work.then(work, work);
    this.#work = next.catch((error: unknown) => {
      this.core.log('warn', 'history sync step failed', { error: String(error) });
    });
    return next;
  }

  /** Runs `#request` after `ms` (replacing any timer). */
  #schedule(ms: number): void {
    clearTimeout(this.#timer);
    if (!this.#started) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#serial(() => this.#request());
    }, ms);
  }

  /** Asks the phone to start or resume the sync after the last stored batch. */
  async #request(): Promise<void> {
    const state = this.#state;
    if (state?.status !== 'running') return;
    const phone = await this.#phone();
    if (!phone) {
      await this.#save({ ...state, status: 'failed', error: 'no_phone' });
      return;
    }
    const result = await this.channel.send(phone, {
      case: 'syncChunk',
      value: {
        syncId: uuidToBytes(state.syncId),
        op: {
          case: 'request',
          value: {
            days: state.window.days,
            maxPerConversation: state.window.maxPerConversation,
            conversationId: state.conversationId
              ? uuidToBytes(state.conversationId)
              : new Uint8Array(0),
            beforeSortAtMs: BigInt(state.before?.sortAt ?? 0),
            beforeMessageId: state.before ? uuidToBytes(state.before.messageId) : new Uint8Array(0),
            resumeAfter: state.lastStored,
          },
        },
      },
    });
    this.#sent(result, state.lastStored > 0 ? 'syncing' : 'requesting');
  }

  /** After a request or an ack: wait for the next batch, or say why it cannot come. */
  #sent(result: SendResult, live: Live): void {
    if (result.ok) {
      this.#offlineAttempts = 0;
      this.#setLive(live);
      this.#schedule(WATCHDOG_MS);
      return;
    }
    if (result.code === 'RECIPIENT_OFFLINE') {
      this.#setLive('phone_offline');
      const delays = this.options.retryMs ?? OFFLINE_RETRY_MS;
      const delay = delays[Math.min(this.#offlineAttempts, delays.length - 1)] ?? WATCHDOG_MS;
      this.#offlineAttempts++;
      this.#schedule(delay);
      return;
    }
    if (result.code === 'OFFLINE' || result.code === 'TIMEOUT') {
      // Waits for `connection(true)`; the watchdog covers a missed one.
      this.#setLive('offline');
      this.#schedule(WATCHDOG_MS);
      return;
    }
    this.#setLive('phone_offline');
    this.#schedule(WATCHDOG_MS);
  }

  async #onBatch(state: SinkState, chunk: SyncChunk): Promise<void> {
    const phone = await this.#phone();
    if (!phone) return;
    const ack = (ok: boolean) =>
      this.channel.send(phone, {
        case: 'syncChunk',
        value: {
          syncId: chunk.syncId,
          sequence: chunk.sequence,
          op: { case: 'ack', value: { ok, pause: false } },
        },
      });
    if (chunk.sequence <= state.lastStored) {
      // Stored already (our acknowledgement was lost): acknowledge it again.
      this.#sent(await ack(true), 'syncing');
      return;
    }
    if (chunk.sequence !== state.lastStored + 1) return; // out of order: the watchdog resumes
    let batch: SyncBatch | undefined;
    if (bytesEqual(this.core.options.crypto.sha256(chunk.data), chunk.dataSha256)) {
      try {
        batch = decodeSyncBatch(chunk.data, SYNC_DATA_MAX);
      } catch {
        batch = undefined;
      }
    }
    if (!batch) {
      const nacks = state.nacks + 1;
      this.core.log('warn', 'history batch failed its integrity check', {
        sequence: chunk.sequence,
      });
      if (nacks > MAX_NACKS) {
        await this.#save({ ...state, status: 'failed', error: 'integrity', nacks });
        await this.channel.send(phone, stop(chunk.syncId, SyncStop_Reason.CANCELLED));
        return;
      }
      await this.#save({ ...state, nacks });
      this.#sent(await ack(false), 'syncing');
      return;
    }
    const groups = await this.#store(state, chunk.sequence, batch);
    if (groups.length > 0) this.options.groupsArrived(groups);
    this.#setLive('syncing');
    this.#sent(await ack(true), 'syncing');
  }

  /** Files one batch and the advanced cursor in one write; returns the groups it brought. */
  async #store(state: SinkState, sequence: number, batch: SyncBatch): Promise<string[]> {
    const { core } = this;
    const { store } = core;
    const counts = { ...state.counts };
    let received = 0;
    const groupIds: string[] = [];
    await core.mutex.run(async () => {
      const now = core.now();
      const write: WriteBatch = {};
      const conversations = new Map<string, ConversationRecord>();
      const latest = new Map<string, MessageRecord | undefined>();
      const conversationOf = async (id: string) => {
        if (!conversations.has(id)) {
          const stored = await store.getConversation(id);
          if (stored) conversations.set(id, stored);
        }
        return conversations.get(id);
      };
      for (const sync of batch.conversations) {
        const record = conversationFromSync(sync, now);
        if (record && !(await conversationOf(record.conversationId))) {
          conversations.set(record.conversationId, record);
        }
      }
      for (const sync of batch.groups) {
        const group = groupFromSync(sync, now);
        if (!group) continue;
        const existing = await store.getGroup(group.groupId);
        if (existing && existing.version >= group.version) continue;
        (write.groups ??= []).push(existing ? { ...group, createdAt: existing.createdAt } : group);
        groupIds.push(group.groupId);
      }
      const added = new Set<string>();
      for (const sync of batch.messages) {
        // Counted as sent, whatever happens to it here: the manifest check compares these.
        let conversationId: string;
        try {
          conversationId = bytesToUuid(sync.conversationId);
        } catch {
          continue;
        }
        counts[conversationId] = (counts[conversationId] ?? 0) + 1;
        received++;
        let message = messageFromSync(sync, core.self.userId, now);
        if (!message || added.has(message.messageId)) continue;
        if (await store.getMessage(message.messageId)) continue; // here already
        const conversation = await conversationOf(conversationId);
        if (!conversation) continue;
        const pending = await store.listOps(message.messageId);
        if (pending.length > 0) {
          message = applyPending(message, pending, core.opRules);
          write.deleteOps = [...(write.deleteOps ?? []), ...pending.map((op) => op.opId)];
        }
        added.add(message.messageId);
        (write.messages ??= []).push(message);
        if (!latest.has(conversationId)) {
          latest.set(
            conversationId,
            conversation.lastMessageId
              ? await store.getMessage(conversation.lastMessageId)
              : undefined,
          );
        }
        const last = latest.get(conversationId);
        const newest = !last || compareMessages(message, last) <= 0;
        const unread = message.direction === 'in' && message.readAt === null;
        if (newest) latest.set(conversationId, message);
        conversations.set(conversationId, {
          ...conversation,
          updatedAt: Math.max(conversation.updatedAt, message.sortAt),
          lastMessageId: newest ? message.messageId : conversation.lastMessageId,
          unreadCount: conversation.unreadCount + (unread ? 1 : 0),
        });
      }
      if (conversations.size > 0) write.conversations = [...conversations.values()];
      const next: SinkState = {
        ...state,
        lastStored: sequence,
        messages: state.messages + received,
        counts,
        conversationsDone: batch.conversationsDone,
        conversationsTotal: batch.conversationsTotal,
        nacks: 0,
      };
      write.settings = { [STATE_KEY]: next };
      await core.commit(write);
      this.#state = next;
    });
    this.#emit();
    return groupIds;
  }

  async #onManifest(state: SinkState, manifest: SyncManifest): Promise<void> {
    const sent = new Map<string, number>();
    for (const count of manifest.counts) {
      try {
        sent.set(bytesToUuid(count.conversationId), count.messages);
      } catch {
        // Not an ID: the comparison below fails.
      }
    }
    const stored = Object.entries(state.counts).filter(([, n]) => n > 0);
    const matches =
      manifest.batches === state.lastStored &&
      sent.size === stored.length &&
      stored.every(([id, n]) => sent.get(id) === n);
    clearTimeout(this.#timer);
    if (matches) {
      const now = this.core.now();
      const settings: Record<string, unknown> = {
        [STATE_KEY]: { ...state, status: 'done', completedAt: now },
      };
      if (state.conversationId === null) {
        settings[RECENT_AT_KEY] = now;
        this.#recentAt = now;
      }
      await this.core.commit({ settings });
      this.#state = { ...state, status: 'done', completedAt: now };
      this.core.log('info', 'history sync complete', {
        batches: state.lastStored,
        messages: state.messages,
      });
      this.#emit();
      return;
    }
    this.core.log('warn', 'history sync manifest does not match', { restarts: state.restarts });
    if (state.restarts >= 1) {
      await this.#save({ ...state, status: 'failed', error: 'integrity' });
      return;
    }
    // Once more from the start; what arrived already is skipped by ID.
    await this.#save({
      ...state,
      lastStored: 0,
      messages: 0,
      counts: {},
      restarts: state.restarts + 1,
    });
    this.#schedule(0);
  }

  /** This account's phone, from the verified own directory. */
  async #phone(): Promise<DirectoryDeviceRecord | undefined> {
    const devices = await this.channel.ownDevices();
    return devices.find((d) => d.role === 'primary') ?? devices.find((d) => d.platform !== 'web');
  }

  #setLive(live: Live): void {
    if (this.#live === live) return;
    this.#live = live;
    this.#emit();
  }

  async #save(state: SinkState): Promise<void> {
    await this.core.commit({ settings: { [STATE_KEY]: state } });
    this.#state = state;
    this.#emit();
  }

  #emit(): void {
    const status = this.status;
    for (const listener of [...this.#listeners]) listener(status);
  }
}
