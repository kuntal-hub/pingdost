/**
 * Background jobs (REQ §15, ARCHITECTURE A2). TTL indexes expire OTPs, unverified accounts,
 * sessions and security events. The mailbox adds the Redis → Mongo migration and the expiry
 * reaper (Phase 8); later phases add the attachment janitor and pairing cleanup.
 */
import type { Logger } from 'pino';

import type { ServerConfig } from '@pingdost/config';

import { systemClock, type Clock } from './infra/clock';
import type { Metrics } from './infra/metrics';
import type { Mongo } from './infra/mongo';
import type { RedisHandle } from './infra/redis';
import { Scheduler, type Job } from './infra/scheduler';
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
  return mailboxJobs({
    settings,
    clock: deps.clock ?? systemClock,
    metrics: deps.metrics,
    log: deps.logger.child({ component: 'mailbox' }),
    redis: new RedisMailbox(deps.redis, settings.redisKeyPrefix),
    mongo: new MongoMailbox(deps.mongo.db),
  });
}

export function startScheduler(deps: JobDeps): Scheduler {
  const scheduler = new Scheduler(deps.mongo.db, deps.logger);
  for (const job of createJobs(deps)) scheduler.register(job);
  scheduler.start();
  return scheduler;
}
