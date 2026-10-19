/**
 * Background jobs (REQ §15, ARCHITECTURE A2). TTL indexes already expire OTPs, unverified
 * accounts, sessions and security events, so Phase 5 has no jobs. Phase 8 adds the mailbox
 * migration and reaper here.
 */
import type { Logger } from 'pino';

import type { ServerConfig } from '@pingdost/config';

import type { Mongo } from './infra/mongo';
import type { RedisHandle } from './infra/redis';
import { Scheduler, type Job } from './infra/scheduler';

export interface JobDeps {
  config: ServerConfig;
  mongo: Mongo;
  redis: RedisHandle;
  logger: Logger;
}

/** Phase 8 passes `JobDeps` here for the mailbox jobs. */
export function createJobs(): Job[] {
  return [];
}

export function startScheduler(deps: JobDeps): Scheduler {
  const scheduler = new Scheduler(deps.mongo.db, deps.logger);
  for (const job of createJobs()) scheduler.register(job);
  scheduler.start();
  return scheduler;
}
