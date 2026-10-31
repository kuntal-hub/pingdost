/**
 * What a backup body holds (ADR 0022), as JSON records between binary file frames:
 *
 * 1. `manifest` (always first): who and when, and the header's SHA-256;
 * 2. `identity`: the account identity key secret (ADR 0003);
 * 3. history: `conversation`, `group`, `message`, `directory` (contacts' verified keys);
 * 4. `megolm`: inbound group sessions as exported keys (`exportAt(firstKnownIndex)`);
 * 5. `settings`: the app's own preferences;
 * 6. `file` records, each followed by its bytes in file frames (optional);
 * 7. `end` (always last): the frame count and the SHA-256 of every frame before it.
 *
 * Never: the device Olm account, Olm sessions, outbound Megolm sessions, the outbox, receipts
 * owed, or seen IDs (ADR 0003: restoring ratchet state can reuse message keys).
 */
import { z } from 'zod';

import type {
  ConversationRecord,
  DirectoryRecord,
  GroupRecord,
  MessageRecord,
} from '@pingdost/message-engine';

export interface BackupManifest {
  t: 'manifest';
  format: number;
  createdAt: number;
  userId: string;
  /** The public account identity key, so a restore can check the account before anything. */
  accountIdentityKey: string;
  /** SHA-256 of the cleartext header (base64). */
  headerSha256: string;
  /** e.g. `pingdost-android/1.0.0`. */
  app: string;
  /** Whether attachment files follow. */
  includesFiles: boolean;
}

/** A group as stored, with the avatar as base64. */
export type BackupGroup = Omit<GroupRecord, 'avatar'> & { avatar: string | null };

/** An inbound Megolm session without its device-bound pickle. */
export interface BackupMegolmSession {
  sessionId: string;
  groupId: string;
  senderUserId: string;
  senderDeviceId: string;
  senderKey: string;
  /** `exportAt(firstKnownIndex)`, base64. Secret. */
  exportedKey: string;
  firstKnownIndex: number;
  seenIndices: number[];
  createdAt: number;
}

export type BackupRecord =
  | BackupManifest
  | { t: 'identity'; secret: string }
  | { t: 'conversation'; record: ConversationRecord }
  | { t: 'group'; record: BackupGroup }
  | { t: 'message'; record: MessageRecord }
  | { t: 'directory'; record: DirectoryRecord }
  | { t: 'megolm'; record: BackupMegolmSession }
  | { t: 'settings'; values: Record<string, unknown> }
  /** `size` bytes of the attachment's local ciphertext follow in file frames. */
  | {
      t: 'file';
      attachmentId: string;
      size: number;
      /** The message it belongs to, and whether it is the file or its preview. */
      messageId: string;
      conversationId: string;
      role: 'file' | 'thumbnail';
    }
  | { t: 'end'; frames: number; sha256: string };

const id = z.string().min(1).max(64);
const time = z.number().int().nonnegative();

/**
 * Light checks on each record: the body is authenticated with the user's own key, so these
 * catch bugs and other builds' quirks rather than attacks. Unknown record types are skipped
 * (add-only, like the wire protocol).
 */
const schemas = {
  manifest: z.object({
    format: z.number().int(),
    createdAt: time,
    userId: id,
    accountIdentityKey: z.string().min(1),
    headerSha256: z.string().min(1),
    app: z.string().max(100),
    includesFiles: z.boolean(),
  }),
  identity: z.object({ secret: z.string().min(1) }),
  conversation: z.object({
    record: z.looseObject({ conversationId: id, kind: z.enum(['direct', 'group']) }),
  }),
  group: z.object({ record: z.looseObject({ groupId: id, members: z.array(z.unknown()) }) }),
  message: z.object({
    record: z.looseObject({
      messageId: id,
      conversationId: id,
      kind: z.string(),
      body: z.string(),
    }),
  }),
  directory: z.object({ record: z.looseObject({ userId: id, devices: z.array(z.unknown()) }) }),
  megolm: z.object({
    record: z.looseObject({
      sessionId: z.string().min(1),
      groupId: id,
      senderDeviceId: id,
      exportedKey: z.string().min(1),
      seenIndices: z.array(z.number().int()),
    }),
  }),
  settings: z.object({ values: z.record(z.string(), z.unknown()) }),
  file: z.object({
    attachmentId: id,
    size: z.number().int().nonnegative(),
    messageId: id,
    conversationId: id,
    role: z.enum(['file', 'thumbnail']),
  }),
  end: z.object({ frames: z.number().int().nonnegative(), sha256: z.string().min(1) }),
} satisfies Record<BackupRecord['t'], z.ZodType>;

/** The record, or undefined for a type this build does not know. Throws if malformed. */
export function checkRecord(value: unknown): BackupRecord | undefined {
  const type = (value as { t?: unknown } | null)?.t;
  if (typeof type !== 'string') throw new Error('record without a type');
  if (!(type in schemas)) return undefined;
  schemas[type as BackupRecord['t']].parse(value);
  return value as BackupRecord;
}
