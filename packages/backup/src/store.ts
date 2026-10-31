/**
 * Engine store ↔ backup records (ADR 0022). Export reads through the `EngineStore` interface,
 * so the phone (SQLCipher) and any other store share it. Restore writes into an empty store
 * of a **new** device: no Olm account, sessions, outbox or receipts come back, and messages
 * that never left the old phone are marked failed.
 */
import type { CryptoProvider } from '@pingdost/crypto/core';
import type {
  AttachmentInfo,
  DirectoryRecord,
  EngineStore,
  GroupRecord,
  InboundGroupSessionRecord,
  MessageCursor,
  MessageRecord,
  WriteBatch,
} from '@pingdost/message-engine';
import { fromBase64, toBase64 } from '@pingdost/protocol';
import type { MessageState } from '@pingdost/shared-types';

import { BackupError } from './errors';
import type { BackupGroup, BackupMegolmSession, BackupRecord } from './records';
import type { BackupReader, BackupWriter } from './stream';

/** A local attachment file to include: its size and its bytes in order. */
export interface BackupFileSource {
  size: number;
  chunks(): AsyncIterable<Uint8Array>;
}

export interface ExportOptions {
  store: EngineStore;
  crypto: CryptoProvider;
  /** The key the store's pickles are encrypted with. */
  pickleKey: Uint8Array;
  writer: BackupWriter;
  selfUserId: string;
  /** `SigningKey.exportSecret()` of the account identity key. */
  identitySecret: string;
  /** The app's own preferences (privacy, notifications, …), as JSON. */
  settings?: Record<string, unknown>;
  /**
   * Files to include (optional): the local copy of an attachment or of its preview, or null to
   * skip it.
   */
  file?: (
    attachment: AttachmentInfo,
    message: MessageRecord,
    role: 'file' | 'thumbnail',
  ) => Promise<BackupFileSource | null>;
  onProgress?: (progress: ExportCounts) => void;
}

export interface ExportCounts {
  conversations: number;
  messages: number;
  groups: number;
  contacts: number;
  groupSessions: number;
  files: number;
  fileBytes: number;
}

const PAGE = 500;

export async function exportToBackup(options: ExportOptions): Promise<ExportCounts> {
  const { store, writer, crypto } = options;
  const counts: ExportCounts = {
    conversations: 0,
    messages: 0,
    groups: 0,
    contacts: 0,
    groupSessions: 0,
    files: 0,
    fileBytes: 0,
  };
  await writer.record({ t: 'identity', secret: options.identitySecret });

  const users = new Set<string>();
  const files: {
    attachment: AttachmentInfo;
    message: MessageRecord;
    role: 'file' | 'thumbnail';
  }[] = [];
  for (const conversation of await store.listConversations()) {
    await writer.record({ t: 'conversation', record: conversation });
    counts.conversations++;
    if (conversation.kind === 'direct' && conversation.peerUserId) {
      users.add(conversation.peerUserId);
    }
    let before: MessageCursor | undefined;
    for (;;) {
      const page = await store.listMessages(conversation.conversationId, { before, limit: PAGE });
      for (const message of page) {
        await writer.record({ t: 'message', record: message });
        counts.messages++;
        if (message.attachment && options.file) {
          files.push({ attachment: message.attachment, message, role: 'file' });
          const { thumbnail } = message.attachment;
          if (thumbnail) files.push({ attachment: thumbnail, message, role: 'thumbnail' });
        }
      }
      options.onProgress?.(counts);
      if (page.length < PAGE) break;
      const last = page.at(-1)!;
      before = { sortAt: last.sortAt, messageId: last.messageId };
    }
  }

  for (const group of await store.listGroups()) {
    await writer.record({ t: 'group', record: groupToBackup(group) });
    counts.groups++;
    for (const member of group.members) users.add(member.userId);
    for (const session of await store.listInboundGroupSessions(group.groupId)) {
      const exported = exportSession(crypto, session, options.pickleKey);
      if (!exported) continue;
      await writer.record({ t: 'megolm', record: exported });
      counts.groupSessions++;
    }
  }

  users.delete(options.selfUserId);
  for (const userId of users) {
    const directory = await store.getDirectory(userId);
    if (!directory) continue;
    await writer.record({ t: 'directory', record: directory });
    counts.contacts++;
  }

  if (options.settings) await writer.record({ t: 'settings', values: options.settings });

  const included = new Set<string>();
  for (const { attachment, message, role } of files) {
    if (included.has(attachment.attachmentId)) continue;
    const source = await options.file!(attachment, message, role);
    if (!source) continue;
    included.add(attachment.attachmentId);
    await writer.record({
      t: 'file',
      attachmentId: attachment.attachmentId,
      size: source.size,
      messageId: message.messageId,
      conversationId: message.conversationId,
      role,
    });
    let written = 0;
    for await (const chunk of source.chunks()) {
      written += chunk.length;
      if (written > source.size) throw new Error('backup: a file grew while it was read');
      await writer.fileData(chunk);
    }
    if (written !== source.size) throw new Error('backup: a file shrank while it was read');
    counts.files++;
    counts.fileBytes += source.size;
    options.onProgress?.(counts);
  }
  return counts;
}

function groupToBackup(group: GroupRecord): BackupGroup {
  return { ...group, avatar: group.avatar ? toBase64(group.avatar) : null };
}

/** The session from its first known index, without the device-bound pickle. */
function exportSession(
  crypto: CryptoProvider,
  session: InboundGroupSessionRecord,
  pickleKey: Uint8Array,
): BackupMegolmSession | undefined {
  let restored;
  try {
    restored = crypto.restoreInboundGroupSession(session.pickle, pickleKey);
  } catch {
    return undefined; // unreadable pickle: nothing to export
  }
  try {
    const exportedKey = restored.exportAt(restored.firstKnownIndex());
    if (!exportedKey) return undefined;
    return {
      sessionId: session.sessionId,
      groupId: session.groupId,
      senderUserId: session.senderUserId,
      senderDeviceId: session.senderDeviceId,
      senderKey: session.senderKey,
      exportedKey,
      firstKnownIndex: restored.firstKnownIndex(),
      seenIndices: session.seenIndices,
      createdAt: session.createdAt,
    };
  } finally {
    restored.dispose();
  }
}

/** Where a restored file's bytes go (the platform's vault). */
export interface RestoreFileSink {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  /** The restore failed half-way: remove what was written. */
  abort(): Promise<void>;
}

export interface RestoreOptions {
  reader: BackupReader;
  /** The new device's empty store. */
  store: EngineStore;
  crypto: CryptoProvider;
  /** The new device's pickle key. */
  pickleKey: Uint8Array;
  now?: () => number;
  /** A file from the backup: where to put it, or null to skip it. */
  file?: (file: Extract<BackupRecord, { t: 'file' }>) => Promise<RestoreFileSink | null>;
  onProgress?: (progress: { records: number; total: number }) => void;
  /** `reader.verify()` already passed (e.g. before the old phone was revoked): skip pass 1. */
  verified?: { records: number };
}

export interface RestoreResult {
  identitySecret: string;
  settings: Record<string, unknown> | null;
  counts: Omit<ExportCounts, 'fileBytes'>;
  /** Direct-chat peers: the new device asks each of their devices for a fresh session. */
  peerUserIds: string[];
}

/** Outgoing states that only make sense with the old phone's outbox. */
const UNSENT: readonly MessageState[] = ['local_queued', 'sending', 'waiting_for_nearby_route'];
const BATCH_RECORDS = 250;

/**
 * Checks the whole file first (nothing is written if any byte fails), then writes it in
 * batches. A failure in the second pass (storage) leaves a partial store: callers restore
 * into a fresh database and delete it on failure.
 */
export async function restoreFromBackup(options: RestoreOptions): Promise<RestoreResult> {
  const { reader, store, crypto } = options;
  const now = options.now ?? Date.now;
  const { records: total } = options.verified ?? (await reader.verify());

  const counts: RestoreResult['counts'] = {
    conversations: 0,
    messages: 0,
    groups: 0,
    contacts: 0,
    groupSessions: 0,
    files: 0,
  };
  let identitySecret: string | undefined;
  let settings: Record<string, unknown> | null = null;
  const peers = new Set<string>();
  let batch: WriteBatch = {};
  let pending = 0;
  let records = 0;
  let file: { sink: RestoreFileSink | null; attachmentId: string } | null = null;
  const flush = async () => {
    if (pending === 0) return;
    await store.apply(batch);
    batch = {};
    pending = 0;
    options.onProgress?.({ records, total });
  };
  const closeFile = async () => {
    if (file?.sink) {
      await file.sink.close();
      counts.files++;
    }
    file = null;
  };

  try {
    for await (const item of reader.items()) {
      if (item.type === 'file_data') {
        if (file?.sink) await file.sink.write(item.data);
        continue;
      }
      await closeFile();
      const { record } = item;
      records++;
      const seenAt = now();
      switch (record.t) {
        case 'identity':
          identitySecret = record.secret;
          break;
        case 'conversation':
          (batch.conversations ??= []).push(record.record);
          if (record.record.kind === 'direct' && record.record.peerUserId) {
            peers.add(record.record.peerUserId);
          }
          counts.conversations++;
          break;
        case 'message': {
          (batch.messages ??= []).push(restoredMessage(record.record));
          // Seen, so a resend of the same message from its sender is not stored twice.
          (batch.seen ??= []).push({ id: record.record.messageId, seenAt });
          counts.messages++;
          break;
        }
        case 'group':
          (batch.groups ??= []).push({
            ...record.record,
            avatar: record.record.avatar ? fromBase64(record.record.avatar) : null,
          });
          counts.groups++;
          break;
        case 'directory':
          (batch.directory ??= []).push(restoredDirectory(record.record));
          counts.contacts++;
          break;
        case 'megolm': {
          const session = importSession(crypto, record.record, options.pickleKey);
          if (session) {
            (batch.inboundGroupSessions ??= []).push(session);
            counts.groupSessions++;
          }
          break;
        }
        case 'settings':
          settings = record.values;
          break;
        case 'file':
          await flush(); // the messages that refer to it are stored first
          file = {
            attachmentId: record.attachmentId,
            sink: options.file ? await options.file(record) : null,
          };
          break;
        case 'manifest':
        case 'end':
          break;
      }
      if (++pending >= BATCH_RECORDS) await flush();
    }
    await closeFile();
    await flush();
  } catch (error) {
    // `file` is reassigned inside the loop's callbacks; TypeScript cannot see that.
    const open = file as { sink: RestoreFileSink | null } | null;
    await open?.sink?.abort().catch(() => undefined);
    throw error;
  }
  if (!identitySecret) throw new BackupError('corrupt');
  return { identitySecret, settings, counts, peerUserIds: [...peers] };
}

function restoredMessage(message: MessageRecord): MessageRecord {
  if (message.direction === 'out' && message.state && UNSENT.includes(message.state)) {
    return { ...message, state: 'failed' };
  }
  return message;
}

/** Kept with its verification, but refetched before it is used again. */
function restoredDirectory(record: DirectoryRecord): DirectoryRecord {
  return { ...record, fetchedAt: 0 };
}

function importSession(
  crypto: CryptoProvider,
  record: BackupMegolmSession,
  pickleKey: Uint8Array,
): InboundGroupSessionRecord | undefined {
  let session;
  try {
    session = crypto.importInboundGroupSession(record.exportedKey);
  } catch {
    return undefined;
  }
  try {
    if (session.sessionId() !== record.sessionId) return undefined;
    // `sharedAt` is left out: this device answers no key requests for the old device.
    return {
      sessionId: record.sessionId,
      groupId: record.groupId,
      senderUserId: record.senderUserId,
      senderDeviceId: record.senderDeviceId,
      senderKey: record.senderKey,
      pickle: session.pickle(pickleKey),
      firstKnownIndex: session.firstKnownIndex(),
      seenIndices: record.seenIndices,
      createdAt: record.createdAt,
    };
  } finally {
    session.dispose();
  }
}
