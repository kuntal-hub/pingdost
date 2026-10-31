/**
 * Background jobs (REQ §15, ARCHITECTURE A2). TTL indexes expire OTPs, unverified accounts,
 * sessions and security events. The mailbox adds the Redis → Mongo migration and the expiry
 * reaper (Phase 8), attachments the staging janitor (Phase 14); pairing cleanup comes later.
 */
import type { Logger } from 'pino';

import type { ServerConfig } from '@pingdost/config';

import { systemClock, type Clock } from './infra/clock';
import type { Metrics } from './infra/metrics';
import type { Mongo } from './infra/mongo';
import type { RedisHandle } from './infra/redis';
import { Scheduler, type Job } from './infra/scheduler';
import { attachmentJobs, createAttachmentService } from './modules/attachments';
import { mailboxJobs } from './modules/delivery/jobs';
import { MongoMailbox } from './modules/delivery/mongo-store';
import { RedisMailbox } from './modules/delivery/redis-store';
import { mailboxSettings } from './modules/delivery/settings';

export interface JobDeps {
  config: ServerConfig;
  mongo: Mongo;
  redis: RedisHandle;
  logger: Logger;
  metrics: Metrics;
  clock?: Clock;
}

export function createJobs(deps: JobDeps): Job[] {
  const settings = mailboxSettings(deps.config);
  const clock = deps.clock ?? systemClock;
  const { service } = createAttachmentService(deps.config, {
    db: deps.mongo.db,
    clock,
    metrics: deps.metrics,
    log: deps.logger.child({ component: 'attachments' }),
  });
  return [
    ...mailboxJobs({
      settings,
      clock,
      metrics: deps.metrics,
      log: deps.logger.child({ component: 'mailbox' }),
      redis: new RedisMailbox(deps.redis, settings.redisKeyPrefix),
      mongo: new MongoMailbox(deps.mongo.db),
    }),
    ...attachmentJobs(service, deps.config.ATTACHMENT_JANITOR_INTERVAL_SECONDS * 1_000),
    ...(deps.config.HEARTBEAT_URL
      ? [heartbeatJob(deps.config.HEARTBEAT_URL, deps.logger.child({ component: 'heartbeat' }))]
      : []),
  ];
}

export const HEARTBEAT_INTERVAL_MS = 5 * 60_000;

/**
 * Phase 20: proves the job loop runs (it takes a Mongo lease first) to an outside monitor. A
 * missed ping is the alert; a failed one is only logged (status only, never the URL).
 */
export function heartbeatJob(url: string, log: Logger): Job {
  return {
    name: 'heartbeat',
    intervalMs: HEARTBEAT_INTERVAL_MS,
    async run(signal) {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        });
        if (!response.ok) log.warn({ status: response.status }, 'heartbeat ping refused');
      } catch {
        log.warn('heartbeat ping failed');
      }
    },
  };
}

export function startScheduler(deps: JobDeps): Scheduler {
  const scheduler = new Scheduler(deps.mongo.db, deps.logger);
  for (const job of createJobs(deps)) scheduler.register(job);
  scheduler.start();
  return scheduler;
}
