/** Wiring for attachment staging (ADR 0017): the configured store, its signer, the janitor. */
import { resolve } from 'node:path';

import type { Db } from 'mongodb';
import type { Logger } from 'pino';

import type { ServerConfig } from '@pingdost/config';

import { AttachmentService, type AttachmentSettings } from './service';
import { UrlSigner } from './signer';
import { FsAttachmentStore } from './store/fs';
import { S3AttachmentStore } from './store/s3';
import type { AttachmentStore } from './store/types';
import type { Clock } from '../../infra/clock';
import type { Metrics } from '../../infra/metrics';
import type { Job } from '../../infra/scheduler';
import { Hasher } from '../../infra/secrets';
import { deviceCollections } from '../device/repo';

export function attachmentSettings(config: ServerConfig): AttachmentSettings {
  return {
    maxPlaintextBytes: config.ATTACHMENT_MAX_BYTES,
    retentionMs: config.ATTACHMENT_MAX_RETENTION_SECONDS * 1_000,
    urlTtlMs: config.ATTACHMENT_PRESIGNED_URL_TTL_SECONDS * 1_000,
    userQuotaBytes: config.ATTACHMENT_USER_QUOTA_BYTES,
    totalQuotaBytes: config.ATTACHMENT_TOTAL_QUOTA_BYTES,
    orphanMs: config.ATTACHMENT_ORPHAN_SECONDS * 1_000,
  };
}

export function createUrlSigner(config: ServerConfig): UrlSigner {
  return new UrlSigner(
    new Hasher(config.SERVER_HMAC_PEPPER),
    config.PUBLIC_API_URL.replace(/\/+$/, ''),
  );
}

export function createAttachmentStore(
  config: ServerConfig,
  signer: UrlSigner,
  clock: Clock,
): AttachmentStore {
  if (config.ATTACHMENT_STORE === 's3') {
    if (!config.objectStore) throw new Error('ATTACHMENT_STORE=s3 needs ATTACHMENT_OBJECT_STORE_*');
    return new S3AttachmentStore(config.objectStore, clock);
  }
  return new FsAttachmentStore(resolve(config.ATTACHMENT_FS_ROOT), signer);
}

export function createAttachmentService(
  config: ServerConfig,
  deps: {
    db: Db;
    clock: Clock;
    metrics: Metrics;
    log: Logger;
    store?: AttachmentStore;
    settings?: Partial<AttachmentSettings>;
  },
): { service: AttachmentService; signer: UrlSigner } {
  const signer = createUrlSigner(config);
  const service = new AttachmentService({
    db: deps.db,
    store: deps.store ?? createAttachmentStore(config, signer, deps.clock),
    devices: deviceCollections(deps.db).devices,
    settings: { ...attachmentSettings(config), ...deps.settings },
    clock: deps.clock,
    metrics: deps.metrics,
    log: deps.log,
  });
  return { service, signer };
}

export function attachmentJobs(service: AttachmentService, intervalMs: number): Job[] {
  return [
    {
      name: 'attachment-janitor',
      intervalMs,
      run: async () => {
        await service.janitor();
      },
    },
  ];
}
