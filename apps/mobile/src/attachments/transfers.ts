// Attachment transfers on this phone (REQ §10.2, §19.3; ADR 0018). Rows in `attachments`
// say what should happen; this runner does it and survives restarts:
// - uploads: per message, the thumbnail then the file, read from the vault copy (a resume
//   never re-encrypts); then the held message is released to the engine;
// - downloads: the ciphertext is appended to the vault copy (resumed with a Range request),
//   checked completely, then acknowledged, so the server deletes its copy once every
//   recipient device has one;
// - thumbnails always download; full files follow the auto-download setting;
// - pause, resume, cancel and retry; "network" failures restart when the connection is back;
// - deleted messages (`content_removed`) take their rows and files with them.
import { File } from 'expo-file-system';
import * as Network from 'expo-network';
import { create } from 'zustand';

import { AttachmentError, downloadCiphertext, uploadAttachment } from '@pingdost/attachments';
import type { MessageEngine, MessageRecord } from '@pingdost/message-engine';
import { fromBase64 } from '@pingdost/protocol';

import {
  attachmentContext,
  maybeAttachmentContext,
  setAttachmentContext,
  type AttachmentContext,
} from './context';
import { Appender, readRange, removeFile, vaultDir, vaultFile } from './files';
import { verifyVaultFile } from './pipeline';
import { currentNetwork, networkKindOf, useAttachmentPrefs } from './prefs';
import type { AttachmentRow, TransferError, TransferRole } from './repo';
import { autoFetch, transferErrorFor, type NetworkKind } from './rules';

interface TransferStore {
  /** Bytes moved so far per attachment while its transfer runs. */
  progress: Record<string, number>;
  /** Bumped whenever a message's rows change, so its bubble reloads them. */
  revisions: Record<string, number>;
}

export const useTransferStore = create<TransferStore>()(() => ({ progress: {}, revisions: {} }));

export function touched(messageId: string): void {
  useTransferStore.setState((state) => ({
    revisions: { ...state.revisions, [messageId]: (state.revisions[messageId] ?? 0) + 1 },
  }));
}

function setProgress(attachmentId: string, bytes: number | undefined): void {
  useTransferStore.setState((state) => {
    const progress = { ...state.progress };
    if (bytes === undefined) delete progress[attachmentId];
    else progress[attachmentId] = bytes;
    return { progress };
  });
}

/** Big files share two slots; thumbnails have their own, so previews never wait. */
const SLOTS = { big: 2, small: 4 } as const;
type Lane = keyof typeof SLOTS;

interface Job {
  lane: Lane;
  controller: AbortController;
  /** Attachment IDs the job works on. */
  ids: string[];
  /** Settles when the job has stopped touching its files. */
  settled: Promise<unknown>;
}

const jobs = new Map<string, Job>();
let kicking: Promise<void> | undefined;
let kickAgain = false;

const uploadKey = (messageId: string) => `up:${messageId}`;
const downloadKey = (attachmentId: string) => `down:${attachmentId}`;
const keyOf = (row: AttachmentRow) =>
  row.direction === 'up' ? uploadKey(row.messageId) : downloadKey(row.attachmentId);

async function update(
  row: Pick<AttachmentRow, 'attachmentId' | 'messageId'>,
  change: Parameters<AttachmentContext['repo']['update']>[1],
): Promise<void> {
  await attachmentContext().repo.update(row.attachmentId, change);
  touched(row.messageId);
}

/** What went wrong, as a stored error; undefined when the job was stopped on purpose. */
function classify(error: unknown, signal: AbortSignal): TransferError | 'gone' | undefined {
  if (signal.aborted) return undefined;
  if (error instanceof AttachmentError) {
    if (error.code === 'aborted') return undefined;
    if (error.code === 'gone') return 'gone';
    return transferErrorFor(error.code);
  }
  const { kind, code } = (error ?? {}) as { kind?: string; code?: string };
  if (kind === 'network' || kind === 'timeout') return 'network';
  if (code) return transferErrorFor(code);
  // e.g. "key directory unavailable" while offline.
  if (error instanceof Error && /unavailable|network/i.test(error.message)) return 'network';
  return 'error';
}

function infoFor(message: MessageRecord | undefined, role: TransferRole) {
  const info = message?.kind === 'attachment' ? message.attachment : null;
  return role === 'thumbnail' ? (info?.thumbnail ?? null) : info;
}

// Uploads

async function runUpload(messageId: string, signal: AbortSignal): Promise<void> {
  const { engine, repo, api } = attachmentContext();
  const message = await engine.getMessage(messageId);
  const rows = (await repo.forMessage(messageId)).filter((r) => r.direction === 'up');
  if (!message?.attachment || message.kind !== 'attachment') {
    // Not awaited: collecting stops this very job.
    void collectGarbage().catch(() => undefined);
    return;
  }
  let recipients = rows.find((r) => r.recipients)?.recipients ?? null;
  if (!recipients) {
    recipients = await engine.attachmentRecipients(message.conversationId);
    for (const row of rows) await repo.update(row.attachmentId, { recipients });
  }
  // The thumbnail first: the recipient's preview should not wait for a large file.
  const ordered = [...rows].sort((a, b) =>
    a.role === 'thumbnail' ? -1 : b.role === 'thumbnail' ? 1 : 0,
  );
  for (const row of ordered) {
    const info = infoFor(message, row.role);
    if (!info || row.state === 'done') continue;
    // No other device to deliver to: nothing to stage.
    if (recipients.length > 0) {
      await uploadAttachment({
        api,
        attachmentId: row.attachmentId,
        ciphertextSize: info.ciphertextSize,
        ciphertextSha256: fromBase64(info.ciphertextSha256),
        recipientDeviceIds: recipients,
        ...(message.expiresAt !== null ? { expiresAt: message.expiresAt } : {}),
        readRange: (start, end) => readRange(vaultFile(row.attachmentId), start, end),
        onProgress: (sent) => setProgress(row.attachmentId, sent),
        signal,
      });
    }
    // The file row stays "transferring" until the message is released, so a crash in between
    // resumes here (the server answers that the upload is complete).
    if (row.role === 'thumbnail') {
      await update(row, { state: 'done', transferred: info.ciphertextSize, error: null });
    }
  }
  await engine.releaseAttachment(messageId);
  for (const row of ordered) {
    if (row.role === 'file') {
      await update(row, { state: 'done', transferred: row.ciphertextSize, error: null });
    }
  }
}

// Downloads

async function runDownload(attachmentId: string, signal: AbortSignal): Promise<void> {
  const { engine, repo, api, provider } = attachmentContext();
  const row = await repo.get(attachmentId);
  if (!row) return;
  const info = infoFor(await engine.getMessage(row.messageId), row.role);
  if (!info) {
    // Not awaited: collecting stops this very job.
    void collectGarbage().catch(() => undefined);
    return;
  }
  const appender = new Appender(vaultFile(attachmentId));
  if (row.localPath !== attachmentId) await repo.update(attachmentId, { localPath: attachmentId });
  try {
    await downloadCiphertext({
      api,
      attachmentId,
      ciphertextSize: info.ciphertextSize,
      savedBytes: appender.size,
      write: (chunk) => appender.write(chunk),
      reset: () => appender.reset(),
      onProgress: (received) => setProgress(attachmentId, received),
      signal,
    });
  } finally {
    appender.close();
  }
  try {
    await verifyVaultFile(provider, info);
  } catch (error) {
    // Not what the sender encrypted: drop it, so a retry starts clean.
    removeFile(vaultFile(attachmentId));
    throw error instanceof AttachmentError
      ? error
      : new AttachmentError('integrity', 'check failed');
  }
  await update(row, { state: 'done', transferred: info.ciphertextSize, error: null });
  await acknowledge(row);
}

/** Tells the server this device has the file; retried later if it cannot be reached. */
async function acknowledge(row: AttachmentRow): Promise<void> {
  try {
    await attachmentContext().api.ack(row.attachmentId);
    if (row.error === 'ack') await update(row, { error: null });
  } catch (error) {
    const code = (error as { code?: string }).code;
    // Already gone on the server: nothing left to acknowledge.
    if (code === 'ATTACHMENT_NOT_FOUND' || code === 'ATTACHMENT_EXPIRED') {
      if (row.error === 'ack') await update(row, { error: null });
      return;
    }
    await update(row, { error: 'ack' });
  }
}

// The runner

function slotsFree(lane: Lane): boolean {
  let used = 0;
  for (const job of jobs.values()) if (job.lane === lane) used++;
  return used < SLOTS[lane];
}

function start(key: string, row: AttachmentRow, ids: string[]): void {
  const lane: Lane = row.role === 'thumbnail' && row.direction === 'down' ? 'small' : 'big';
  if (!slotsFree(lane)) return;
  const controller = new AbortController();
  const work =
    row.direction === 'up'
      ? runUpload(row.messageId, controller.signal)
      : runDownload(row.attachmentId, controller.signal);
  jobs.set(key, { lane, controller, ids, settled: work.catch(() => undefined) });
  void work
    .catch(async (error: unknown) => {
      const failure = classify(error, controller.signal);
      if (!failure || !maybeAttachmentContext()) return;
      const { repo } = attachmentContext();
      for (const id of ids) {
        const current = await repo.get(id);
        if (!current || current.state === 'done') continue;
        await update(
          current,
          failure === 'gone' ? { state: 'gone', error: null } : { state: 'failed', error: failure },
        );
      }
    })
    .finally(() => {
      if (jobs.get(key)?.controller === controller) jobs.delete(key);
      for (const id of ids) setProgress(id, undefined);
      void kick();
    });
}

async function fill(): Promise<void> {
  const context = maybeAttachmentContext();
  if (!context) return;
  const rows = await context.repo.inStates(['transferring']);
  const uploads = new Map<string, AttachmentRow[]>();
  for (const row of rows) {
    if (row.via === 'mesh') continue;
    if (row.direction === 'up')
      uploads.set(row.messageId, [...(uploads.get(row.messageId) ?? []), row]);
  }
  for (const row of rows) {
    // Files over the nearby mesh move in `nearby/files.ts` (ADR 0027).
    if (row.via === 'mesh') continue;
    const key = keyOf(row);
    if (jobs.has(key)) continue;
    const ids =
      row.direction === 'up'
        ? (uploads.get(row.messageId) ?? [row]).map((r) => r.attachmentId)
        : [row.attachmentId];
    start(key, row, ids);
  }
}

/** Starts whatever is queued and fits the free slots. */
export function kick(): Promise<void> {
  if (kicking) {
    kickAgain = true;
    return kicking;
  }
  kicking = (async () => {
    try {
      do {
        kickAgain = false;
        await fill();
      } while (kickAgain);
    } catch {
      // The database is closing (sign-out); the next start picks the work up.
    } finally {
      kicking = undefined;
    }
  })();
  return kicking;
}

/** Aborts a job; resolves once it has let go of its files. Set the rows' state first. */
async function stop(key: string): Promise<void> {
  const job = jobs.get(key);
  if (!job) return;
  job.controller.abort();
  jobs.delete(key);
  await job.settled;
}

// Rows for messages

async function newRows(message: MessageRecord): Promise<AttachmentRow[]> {
  const { deviceId } = attachmentContext();
  const info = message.kind === 'attachment' ? message.attachment : null;
  if (!info) return [];
  // This phone's own sends get their rows when they are made; one without (sent before
  // Phase 15, or its rows were lost) has nothing to fetch.
  if (message.senderDeviceId === deviceId) return [];
  const policy = (await useAttachmentPrefs.getState().load()).autoDownload;
  const network = await currentNetwork();
  const now = Date.now();
  const row = (
    role: TransferRole,
    ciphertextSize: number,
    attachmentId: string,
  ): AttachmentRow => ({
    attachmentId,
    messageId: message.messageId,
    conversationId: message.conversationId,
    role,
    direction: 'down',
    // Over the mesh it comes when it comes (no data cost): take it as it arrives.
    state: info.mesh || autoFetch(role, policy, network) ? 'transferring' : 'pending',
    ciphertextSize,
    transferred: 0,
    localPath: null,
    error: null,
    recipients: null,
    createdAt: now,
    updatedAt: now,
    via: info.mesh ? 'mesh' : null,
  });
  const rows = [row('file', info.ciphertextSize, info.attachmentId)];
  if (info.thumbnail)
    rows.push(row('thumbnail', info.thumbnail.ciphertextSize, info.thumbnail.attachmentId));
  return rows;
}

/** The message's rows, made (and auto-downloads queued) the first time it is seen. */
export async function ensureRows(message: MessageRecord): Promise<AttachmentRow[]> {
  const context = maybeAttachmentContext();
  if (!context || message.kind !== 'attachment' || !message.attachment) return [];
  const existing = await context.repo.forMessage(message.messageId);
  if (existing.length > 0) return existing;
  const rows = await newRows(message);
  if (rows.length === 0) return [];
  await context.repo.insert(rows);
  if (rows.some((r) => r.state === 'transferring')) void kick();
  return context.repo.forMessage(message.messageId);
}

// Controls (the bubble's buttons)

/** Downloads a file now (a tap), or retries a failed transfer. */
export async function fetchNow(row: AttachmentRow): Promise<void> {
  if (row.direction === 'up') return resumeUpload(row.messageId);
  await update(row, { state: 'transferring', error: null });
  void kick();
}

export async function pause(row: AttachmentRow): Promise<void> {
  const { repo } = attachmentContext();
  const rows = row.direction === 'up' ? await repo.forMessage(row.messageId) : [row];
  // Paused first, so the runner does not pick the rows up again when the job stops.
  for (const r of rows) {
    if (r.state === 'done') continue;
    const moved = useTransferStore.getState().progress[r.attachmentId] ?? r.transferred;
    await update(r, { state: 'paused', transferred: moved });
  }
  await stop(keyOf(row));
}

export async function resumeUpload(messageId: string): Promise<void> {
  const { repo } = attachmentContext();
  for (const r of await repo.forMessage(messageId)) {
    if (r.direction === 'up' && r.state !== 'done')
      await update(r, { state: 'transferring', error: null });
  }
  void kick();
}

/** Stops a download and drops what arrived; the file can be fetched again later. */
export async function cancelDownload(row: AttachmentRow): Promise<void> {
  await update(row, { state: 'pending', transferred: 0, error: null, localPath: null });
  await stop(keyOf(row));
  removeFile(vaultFile(row.attachmentId));
}

/** Stops an upload and removes its message from this phone (it was never sent). */
export async function cancelUpload(messageId: string): Promise<void> {
  const { engine, repo } = attachmentContext();
  for (const r of await repo.forMessage(messageId)) await update(r, { state: 'paused' });
  await stop(uploadKey(messageId));
  await engine.deleteForMe([messageId]);
  await collectGarbage();
}

// Housekeeping

/** Rows and vault files of messages that were deleted, or deleted for everyone. */
export async function collectGarbage(): Promise<void> {
  const context = maybeAttachmentContext();
  if (!context) return;
  const orphans = await context.repo.orphans();
  if (orphans.length === 0) return;
  for (const row of orphans) {
    await stop(keyOf(row));
    removeFile(vaultFile(row.localPath ?? row.attachmentId));
  }
  await context.repo.delete(orphans.map((r) => r.attachmentId));
  for (const messageId of new Set(orphans.map((r) => r.messageId))) touched(messageId);
}

/** Vault files no row points at (a send interrupted mid-way). Run before anything is sent. */
async function sweepVault(): Promise<void> {
  const { repo } = attachmentContext();
  const known = await repo.localPaths();
  for (const entry of vaultDir().list()) {
    if (entry instanceof File && !known.has(entry.name)) removeFile(entry);
  }
}

/** The connection is back: failed-for-network transfers and pending acknowledgements retry. */
async function reconnected(engine: MessageEngine): Promise<void> {
  const context = maybeAttachmentContext();
  if (!context || context.engine !== engine) return;
  for (const row of await context.repo.withError('network')) {
    if (row.state === 'failed') await update(row, { state: 'transferring', error: null });
  }
  for (const row of await context.repo.withError('ack')) await acknowledge(row);
  // On Wi-Fi, recent files that waited for it start.
  const policy = (await useAttachmentPrefs.getState().load()).autoDownload;
  const network = await currentNetwork();
  const recent = Date.now() - 7 * 86_400_000;
  for (const row of await context.repo.inStates(['pending'])) {
    if (
      row.direction === 'down' &&
      row.createdAt > recent &&
      autoFetch(row.role, policy, network)
    ) {
      await update(row, { state: 'transferring' });
    }
  }
  void kick();
}

/** Starts the runner with the chat; returns its stop. */
export function startTransfers(context: AttachmentContext): () => void {
  setAttachmentContext(context);
  const { engine } = context;
  let last: NetworkKind | undefined;
  void (async () => {
    await collectGarbage();
    await sweepVault();
    await reconnected(engine);
  })().catch(() => undefined);

  const events = engine.onEvent((event) => {
    if (event.type === 'received') void ensureRows(event.message).catch(() => undefined);
    if (event.type === 'content_removed') void collectGarbage().catch(() => undefined);
  });
  const network = Network.addNetworkStateListener((state) => {
    const kind = networkKindOf(state);
    // Back online, or moved onto Wi-Fi (files that waited for it can start).
    if (kind !== 'offline' && kind !== last && (last === 'offline' || kind === 'wifi')) {
      void reconnected(engine).catch(() => undefined);
    }
    last = kind;
  });
  return () => {
    events();
    network.remove();
    for (const key of [...jobs.keys()]) void stop(key);
    setAttachmentContext(undefined);
  };
}
