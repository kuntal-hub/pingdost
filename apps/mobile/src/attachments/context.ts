// What the attachment modules share while the chat runs: set by `startTransfers` when the
// engine starts, cleared when it stops.
import type { AttachmentsApi } from '@pingdost/api-client';
import type { CryptoProvider } from '@pingdost/crypto/core';
import type { MessageEngine } from '@pingdost/message-engine';

import type { AttachmentRepo } from './repo';

export interface AttachmentContext {
  engine: MessageEngine;
  provider: CryptoProvider;
  repo: AttachmentRepo;
  api: AttachmentsApi;
  deviceId: string;
}

let current: AttachmentContext | undefined;

export function setAttachmentContext(context: AttachmentContext | undefined): void {
  current = context;
}

export function attachmentContext(): AttachmentContext {
  if (!current) throw new Error('attachments need the running chat');
  return current;
}

export function maybeAttachmentContext(): AttachmentContext | undefined {
  return current;
}
