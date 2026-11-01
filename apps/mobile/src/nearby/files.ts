// Files over the nearby mesh on this phone (Phase 24, ADR 0027). With no Internet and the
// contact's phone reachable over nearby (directly or through relays), a file is not staged on the
// server: its manifest says `mesh` and its STREAM ciphertext goes as signed MESH_CHUNKs. Rows
// with `via = 'mesh'` are left alone by the upload/download runner (`attachments/transfers.ts`).
//
// Receiving: chunks land in `mesh_incoming_chunks` (SQLCipher) until the whole file is here;
// then it is written to the vault, checked completely, and only then is the delivery receipt
// sent (`engine.confirmMeshFile`, REQ §19.3).
import { create } from 'zustand';

import { attachmentContext, maybeAttachmentContext } from '@/attachments/context';
import { readRange, vaultFile, writeChunks } from '@/attachments/files';
import type { AttachmentRow } from '@/attachments/repo';
import { ensureRows, touched } from '@/attachments/transfers';
import type { SqlDatabase } from '@/engine/sqlite-store';
import {
  DEFAULT_MESH_FILE_MAX_BYTES,
  meshChunkRange,
  MeshFileReceiver,
} from '@pingdost/attachments';
import { attachmentDecryptInput, type MessageRecord } from '@pingdost/message-engine';
import { fromBase64 } from '@pingdost/protocol';
import type { MeshFileProgress, MeshFileSink, NearbyPeerTransport } from '@pingdost/transport';

import { SqliteChunkStorage } from './chunk-store';

const RETENTION_MS = 14 * 86_400_000;

interface MeshFilesState {
  /** Incoming: chunks held of the total. */
  incoming: Record<string, { held: number; count: number }>;
  /** Outgoing: chunks the recipient took, and relays that took any. */
  outgoing: Record<string, { delivered: number; count: number; relays: number }>;
}

export const useMeshFiles = create<MeshFilesState>()(() => ({ incoming: {}, outgoing: {} }));

let receiver: MeshFileReceiver | undefined;
let nearbyRef: NearbyPeerTransport | undefined;

/** The sink the nearby transport is built with; it takes chunks once `startMeshFiles` ran. */
export const meshFileSink: MeshFileSink = {
  progress: () => receiver?.progress() ?? [],
  accepts: (transferId) => receiver?.accepts(transferId) ?? false,
  chunk: (chunk, ack) => receiver?.chunk(chunk, ack),
};

function infoFor(message: MessageRecord | undefined, row: AttachmentRow) {
  const info = message?.attachment;
  return row.role === 'file' ? info : (info?.thumbnail ?? undefined);
}

async function expectRow(row: AttachmentRow): Promise<void> {
  const { engine } = attachmentContext();
  const info = infoFor(await engine.getMessage(row.messageId), row);
  if (!info || !receiver) return;
  receiver.expect(row.attachmentId, {
    ...attachmentDecryptInput(info),
    chunkHashListSha256: fromBase64(info.chunkHashListSha256),
  });
}

async function offerRow(row: AttachmentRow): Promise<void> {
  const mesh = nearbyRef?.mesh;
  const { engine } = attachmentContext();
  const message = await engine.getMessage(row.messageId);
  const info = infoFor(message, row);
  if (!mesh || !info || !row.recipients) return;
  const file = vaultFile(row.localPath ?? row.attachmentId);
  for (const recipientDeviceId of row.recipients) {
    mesh.sendFile({
      transferId: row.attachmentId,
      recipientDeviceId,
      count: info.chunkCount,
      createdAt: row.createdAt,
      expiresAt: message?.expiresAt ?? row.createdAt + RETENTION_MS,
      read: (index) => {
        const [start, end] = meshChunkRange(index, row.ciphertextSize);
        return readRange(file, start, end);
      },
    });
  }
}

/** The whole file checked out: into the vault, then the receipt (main file only). */
async function finishIncoming(
  transferId: string,
  read: () => AsyncIterable<Uint8Array>,
): Promise<void> {
  const { repo, engine } = attachmentContext();
  const row = await repo.get(transferId);
  if (!row) return;
  await writeChunks(vaultFile(transferId), read());
  await repo.update(transferId, {
    state: 'done',
    error: null,
    localPath: transferId,
    transferred: row.ciphertextSize,
  });
  touched(row.messageId);
  if (row.role === 'file') await engine.confirmMeshFile(row.messageId);
}

function updateIncoming(transferId: string): void {
  const status = receiver?.status(transferId);
  useMeshFiles.setState((state) => ({
    incoming: {
      ...state.incoming,
      [transferId]: { held: status?.held ?? 0, count: status?.count ?? 0 },
    },
  }));
}

function updateOutgoing(progress: MeshFileProgress): void {
  useMeshFiles.setState((state) => ({
    outgoing: {
      ...state.outgoing,
      [progress.transferId]: {
        delivered: progress.delivered,
        count: progress.count,
        relays: progress.relays,
      },
    },
  }));
}

/** A sent message reached its recipient (its E2EE receipt): its mesh files are done. */
async function settleOutgoing(message: MessageRecord): Promise<void> {
  if (message.direction !== 'out') return;
  if (message.state !== 'delivered_to_recipient_device' && message.state !== 'read') return;
  const context = maybeAttachmentContext();
  if (!context) return;
  for (const row of await context.repo.forMessage(message.messageId)) {
    if (row.via !== 'mesh' || row.direction !== 'up' || row.state === 'done') continue;
    nearbyRef?.mesh?.withdrawFile(row.attachmentId);
    await context.repo.update(row.attachmentId, { state: 'done', error: null });
    touched(row.messageId);
  }
}

/** Starts mesh file transfers with the chat (after `startTransfers`); returns the stop. */
export function startMeshFiles(
  db: SqlDatabase,
  nearby: NearbyPeerTransport | undefined,
): () => void {
  const context = attachmentContext();
  nearbyRef = nearby;
  receiver = new MeshFileReceiver(context.provider, new SqliteChunkStorage(db), {
    verified: finishIncoming,
    changed: updateIncoming,
    settled: () => nearby?.mesh?.transfersChanged(),
  });
  const current = receiver;
  void (async () => {
    await current.load();
    for (const row of await context.repo.inStates(['transferring', 'paused'])) {
      if (row.via !== 'mesh') continue;
      if (row.direction === 'down') {
        await expectRow(row);
        if (row.state === 'paused') current.pause(row.attachmentId);
      } else if (row.state === 'transferring') {
        await offerRow(row);
      }
    }
  })().catch(() => undefined);
  const stops = [
    nearby?.mesh?.onFileProgress(updateOutgoing) ?? (() => undefined),
    // A `mesh` manifest arrived: its rows (made once, also by the runner) expect the chunks.
    context.engine.onEvent((event) => {
      if (event.type !== 'received' || !event.message.attachment?.mesh) return;
      void ensureRows(event.message)
        .then(expectMeshRows)
        .catch(() => undefined);
    }),
    context.engine.subscribeAll((_, event) => {
      if (event.type === 'message') void settleOutgoing(event.message).catch(() => undefined);
    }),
  ];
  return () => {
    for (const stop of stops) stop();
    if (receiver === current) receiver = undefined;
    nearbyRef = undefined;
  };
}

/** New incoming rows for a `mesh` manifest: expect the chunks. */
export async function expectMeshRows(rows: AttachmentRow[]): Promise<void> {
  for (const row of rows) if (row.via === 'mesh' && row.direction === 'down') await expectRow(row);
}

/** A file just sent with a `mesh` manifest: offer its chunks to the recipient's devices. */
export async function sendMeshRows(rows: AttachmentRow[]): Promise<void> {
  for (const row of rows) if (row.via === 'mesh' && row.direction === 'up') await offerRow(row);
}

export async function pauseMesh(row: AttachmentRow): Promise<void> {
  const { repo } = attachmentContext();
  if (row.direction === 'up') nearbyRef?.mesh?.withdrawFile(row.attachmentId);
  else receiver?.pause(row.attachmentId);
  await repo.update(row.attachmentId, { state: 'paused' });
  touched(row.messageId);
}

export async function resumeMesh(row: AttachmentRow): Promise<void> {
  const { repo } = attachmentContext();
  await repo.update(row.attachmentId, { state: 'transferring', error: null });
  if (row.direction === 'up') await offerRow({ ...row, state: 'transferring' });
  else receiver?.resume(row.attachmentId);
  touched(row.messageId);
}

export async function cancelMesh(row: AttachmentRow): Promise<void> {
  const { repo } = attachmentContext();
  if (row.direction === 'up') nearbyRef?.mesh?.withdrawFile(row.attachmentId);
  else await receiver?.cancel(row.attachmentId);
  await repo.update(row.attachmentId, { state: 'failed', error: 'error' });
  touched(row.messageId);
}

/**
 * The recipient's phones to send a file to over the mesh, or null to stage it on the server as
 * usual: only a direct chat, no device reachable over the Internet, at least one over nearby
 * (directly or through relays), and the file within the mesh limit.
 */
export async function meshRecipients(
  conversationId: string,
  ciphertextSize: number,
  maxBytes: number = DEFAULT_MESH_FILE_MAX_BYTES,
): Promise<string[] | null> {
  const { engine } = attachmentContext();
  if (!nearbyRef?.mesh || ciphertextSize > maxBytes) return null;
  const conversation = await engine.getConversation(conversationId);
  if (conversation?.kind !== 'direct' || !conversation.peerUserId) return null;
  const routes = await engine.routesTo(conversation.peerUserId);
  if (routes.length === 0 || routes.some((r) => r.route === 'internet')) return null;
  const devices = routes
    .filter((r) => r.route === 'nearby' || r.route === 'mesh')
    .map((r) => r.deviceId);
  return devices.length > 0 ? devices : null;
}
