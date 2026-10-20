// Migration 006's `attachments` table (ADR 0018): one row per staged file of a message (the
// file and its thumbnail), holding its transfer and where its encrypted local copy is. Writes go
// through the engine store's queue (`exclusive`), so they never land in an open batch.
import type { SqlDatabase } from '@/engine/sqlite-store';

export type TransferRole = 'file' | 'thumbnail';
/** `up`: this phone sends it; `down`: this phone fetches it. */
export type TransferDirection = 'up' | 'down';
export type TransferState =
  /** Not fetched (auto-download is off for it, or it waits for Wi-Fi). */
  | 'pending'
  /** Queued or running. */
  | 'transferring'
  | 'paused'
  | 'failed'
  /** The server no longer has it, and this phone has no copy. */
  | 'gone'
  | 'done'
  /** The local copy was deleted (storage controls). */
  | 'removed';

export type TransferError =
  | 'network'
  | 'too_large'
  | 'quota'
  | 'staging_full'
  | 'integrity'
  | 'not_allowed'
  | 'error'
  /** Downloaded and checked, but the server has not heard yet (retried later). */
  | 'ack';

export interface AttachmentRow {
  attachmentId: string;
  messageId: string;
  conversationId: string;
  role: TransferRole;
  direction: TransferDirection;
  state: TransferState;
  ciphertextSize: number;
  transferred: number;
  /** The vault file's name, once there is a local copy (or part of one). */
  localPath: string | null;
  error: TransferError | null;
  /** Uploads: the devices staged for, fixed when the server first accepted the upload. */
  recipients: string[] | null;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  attachment_id: string;
  message_id: string;
  conversation_id: string;
  role: string;
  direction: string;
  state: string;
  ciphertext_size: number;
  transferred: number;
  local_path: string | null;
  error: string | null;
  recipients: string | null;
  created_at: number;
  updated_at: number;
}

const fromRow = (r: Row): AttachmentRow => ({
  attachmentId: r.attachment_id,
  messageId: r.message_id,
  conversationId: r.conversation_id,
  role: r.role as TransferRole,
  direction: r.direction as TransferDirection,
  state: r.state as TransferState,
  ciphertextSize: r.ciphertext_size,
  transferred: r.transferred,
  localPath: r.local_path,
  error: r.error as TransferError | null,
  recipients: r.recipients ? (JSON.parse(r.recipients) as string[]) : null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const COLUMNS: Record<keyof AttachmentRow, string> = {
  attachmentId: 'attachment_id',
  messageId: 'message_id',
  conversationId: 'conversation_id',
  role: 'role',
  direction: 'direction',
  state: 'state',
  ciphertextSize: 'ciphertext_size',
  transferred: 'transferred',
  localPath: 'local_path',
  error: 'error',
  recipients: 'recipients',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/** Per-chat local media: what the storage screen lists. */
export interface ChatUsage {
  conversationId: string;
  files: number;
  fileBytes: number;
  thumbnailBytes: number;
}

/** A downloaded or sent file of one chat, newest first. */
export interface MediaItem extends AttachmentRow {
  sortAt: number;
  /** The manifest JSON of its message (`AttachmentInfo`). */
  attachment: string;
}

export class AttachmentRepo {
  constructor(
    private readonly db: SqlDatabase,
    private readonly serialize: <T>(work: () => Promise<T>) => Promise<T> = (work) => work(),
    private readonly now: () => number = Date.now,
  ) {}

  /** Adds rows that are not there yet (an existing row keeps its state). */
  insert(rows: AttachmentRow[]): Promise<void> {
    if (rows.length === 0) return Promise.resolve();
    return this.serialize(async () => {
      for (const row of rows) {
        await this.db.runAsync(
          `INSERT INTO attachments (attachment_id, message_id, conversation_id, role, direction,
             state, ciphertext_size, transferred, local_path, error, recipients, created_at,
             updated_at)
           VALUES (${placeholders(13)}) ON CONFLICT (attachment_id) DO NOTHING`,
          [
            row.attachmentId,
            row.messageId,
            row.conversationId,
            row.role,
            row.direction,
            row.state,
            row.ciphertextSize,
            row.transferred,
            row.localPath,
            row.error,
            row.recipients ? JSON.stringify(row.recipients) : null,
            row.createdAt,
            row.updatedAt,
          ],
        );
      }
    });
  }

  /** Changes some fields of a row; `updatedAt` follows. */
  update(
    attachmentId: string,
    change: Partial<Omit<AttachmentRow, 'attachmentId' | 'createdAt' | 'updatedAt'>>,
  ): Promise<void> {
    const entries = Object.entries(change) as [keyof AttachmentRow, unknown][];
    if (entries.length === 0) return Promise.resolve();
    const sets = entries.map(([key]) => `${COLUMNS[key]} = ?`);
    const values = entries.map(([key, value]) =>
      key === 'recipients' && value ? JSON.stringify(value) : (value as string | number | null),
    );
    return this.serialize(async () => {
      await this.db.runAsync(
        `UPDATE attachments SET ${sets.join(', ')}, updated_at = ? WHERE attachment_id = ?`,
        [...values, this.now(), attachmentId],
      );
    });
  }

  async get(attachmentId: string): Promise<AttachmentRow | undefined> {
    const row = await this.db.getFirstAsync<Row>(
      'SELECT * FROM attachments WHERE attachment_id = ?',
      [attachmentId],
    );
    return row ? fromRow(row) : undefined;
  }

  async forMessage(messageId: string): Promise<AttachmentRow[]> {
    const rows = await this.db.getAllAsync<Row>(
      `SELECT * FROM attachments WHERE message_id = ? ORDER BY role = 'file', attachment_id`,
      [messageId],
    );
    return rows.map(fromRow);
  }

  /** Rows in these states, thumbnails first, oldest first. */
  async inStates(states: readonly TransferState[]): Promise<AttachmentRow[]> {
    const rows = await this.db.getAllAsync<Row>(
      `SELECT * FROM attachments WHERE state IN (${placeholders(states.length)})
       ORDER BY role = 'file', created_at`,
      [...states],
    );
    return rows.map(fromRow);
  }

  async withError(error: TransferError): Promise<AttachmentRow[]> {
    const rows = await this.db.getAllAsync<Row>('SELECT * FROM attachments WHERE error = ?', [
      error,
    ]);
    return rows.map(fromRow);
  }

  /** Rows whose message was deleted, or deleted for everyone (no manifest any more). */
  async orphans(): Promise<AttachmentRow[]> {
    const rows = await this.db.getAllAsync<Row>(
      `SELECT a.* FROM attachments a LEFT JOIN messages m ON m.message_id = a.message_id
       WHERE m.message_id IS NULL OR m.attachment IS NULL`,
      [],
    );
    return rows.map(fromRow);
  }

  /** Every vault file name a row still points at. */
  async localPaths(): Promise<Set<string>> {
    const rows = await this.db.getAllAsync<{ local_path: string }>(
      'SELECT local_path FROM attachments WHERE local_path IS NOT NULL',
      [],
    );
    return new Set(rows.map((r) => r.local_path));
  }

  delete(attachmentIds: readonly string[]): Promise<void> {
    if (attachmentIds.length === 0) return Promise.resolve();
    return this.serialize(async () => {
      await this.db.runAsync(
        `DELETE FROM attachments WHERE attachment_id IN (${placeholders(attachmentIds.length)})`,
        [...attachmentIds],
      );
    });
  }

  /** Local copies per chat (files and thumbnails kept on this phone). */
  async usageByConversation(): Promise<ChatUsage[]> {
    const rows = await this.db.getAllAsync<{
      conversation_id: string;
      files: number;
      file_bytes: number;
      thumbnail_bytes: number;
    }>(
      `SELECT conversation_id,
         SUM(role = 'file') AS files,
         SUM(CASE WHEN role = 'file' THEN ciphertext_size ELSE 0 END) AS file_bytes,
         SUM(CASE WHEN role = 'thumbnail' THEN ciphertext_size ELSE 0 END) AS thumbnail_bytes
       FROM attachments WHERE state = 'done' AND local_path IS NOT NULL
       GROUP BY conversation_id ORDER BY file_bytes DESC`,
      [],
    );
    return rows.map((r) => ({
      conversationId: r.conversation_id,
      files: r.files,
      fileBytes: r.file_bytes,
      thumbnailBytes: r.thumbnail_bytes,
    }));
  }

  /** The files of one chat kept on this phone, newest first. */
  async mediaIn(conversationId: string): Promise<MediaItem[]> {
    const rows = await this.db.getAllAsync<Row & { sort_at: number; attachment: string }>(
      `SELECT a.*, m.sort_at, m.attachment FROM attachments a
       JOIN messages m ON m.message_id = a.message_id
       WHERE a.conversation_id = ? AND a.role = 'file' AND a.state = 'done'
         AND a.local_path IS NOT NULL AND m.attachment IS NOT NULL
       ORDER BY m.sort_at DESC`,
      [conversationId],
    );
    return rows.map((r) => ({ ...fromRow(r), sortAt: r.sort_at, attachment: r.attachment }));
  }
}
