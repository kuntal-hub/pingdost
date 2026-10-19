/**
 * Operational metrics (REQ §9.4, §18; ARCHITECTURE A3) in the Prometheus text format, served
 * at `/metrics` behind `METRICS_TOKEN`. Labels and values hold counts, ages and states only:
 * never IDs, keys or content. Each app instance owns its registry, so tests stay isolated.
 */
import { Counter, Gauge, Registry } from 'prom-client';

export type AcceptPath = 'online' | 'redis' | 'mongo';

/** Mailbox gauges that cost a Redis command to read: refreshed by the migration job. */
export interface StageSnapshot {
  /** Envelopes in the Redis hot stage. */
  stageCount: number;
  /** Seconds since the oldest Redis-staged envelope was created. */
  oldestAgeSeconds: number;
  /** Due envelopes waiting for migration. */
  dueBacklog: number;
  /** Due for over half the grace period (alert: the Redis safety TTL will delete them). */
  overdue: number;
}

export class Metrics {
  readonly registry = new Registry();

  readonly envelopesAccepted = new Counter({
    name: 'pingdost_envelopes_accepted_total',
    help: 'Envelopes answered with Accepted, by the path that holds them.',
    labelNames: ['path'] as const,
    registers: [this.registry],
  });
  readonly envelopesBlocked = new Counter({
    name: 'pingdost_envelopes_blocked_total',
    help: 'Sends dropped because the recipient blocked the sender (answered Accepted).',
    registers: [this.registry],
  });
  readonly envelopeDuplicates = new Counter({
    name: 'pingdost_envelope_duplicates_total',
    help: 'Sends of an envelope ID the mailbox already held.',
    registers: [this.registry],
  });
  readonly sendRejected = new Counter({
    name: 'pingdost_send_rejected_total',
    help: 'Sends answered with an error, by error code.',
    labelNames: ['code'] as const,
    registers: [this.registry],
  });
  readonly envelopesAcked = new Counter({
    name: 'pingdost_envelopes_acked_total',
    help: 'Envelope IDs acknowledged by recipient devices.',
    registers: [this.registry],
  });
  readonly migrations = new Counter({
    name: 'pingdost_mailbox_migrations_total',
    help: 'Envelopes moved from the Redis stage to Mongo.',
    registers: [this.registry],
  });
  readonly migrationFailures = new Counter({
    name: 'pingdost_mailbox_migration_failures_total',
    help: 'Migration attempts that failed and left the Redis copy in place.',
    registers: [this.registry],
  });
  readonly expiredDeleted = new Counter({
    name: 'pingdost_mailbox_expired_deleted_total',
    help: 'Undelivered envelopes deleted at their absolute expiry, by store.',
    labelNames: ['store'] as const,
    registers: [this.registry],
  });
  readonly deletionFailures = new Counter({
    name: 'pingdost_mailbox_deletion_failures_total',
    help: 'Acknowledged envelopes that could not be deleted from a store.',
    labelNames: ['store'] as const,
    registers: [this.registry],
  });
  readonly wsConnections = new Gauge({
    name: 'pingdost_ws_connections',
    help: 'Authenticated WebSocket connections on this instance.',
    registers: [this.registry],
  });
  readonly stageCount = new Gauge({
    name: 'pingdost_mailbox_redis_stage_count',
    help: 'Envelopes in the Redis hot stage (as of the last migration run).',
    registers: [this.registry],
  });
  readonly stageOldestAge = new Gauge({
    name: 'pingdost_mailbox_redis_oldest_age_seconds',
    help: 'Age of the oldest Redis-staged envelope (as of the last migration run).',
    registers: [this.registry],
  });
  readonly dueBacklog = new Gauge({
    name: 'pingdost_mailbox_due_backlog',
    help: 'Due envelopes waiting for migration (as of the last migration run).',
    registers: [this.registry],
  });
  readonly dueOverdue = new Gauge({
    name: 'pingdost_mailbox_due_overdue',
    help: 'Envelopes due for migration for over half the grace period; above 0 means data is at risk.',
    registers: [this.registry],
  });

  constructor(collectors: {
    /** Commands sent to Redis since start. */
    redisCommands: () => number;
    /** Mongo mailbox count and oldest age; read on each scrape (Mongo is not metered). */
    mongoMailbox: () => Promise<{ count: number; oldestAgeSeconds: number }>;
  }) {
    new Gauge({
      name: 'pingdost_redis_commands',
      help: 'Commands this instance sent to Redis since it started.',
      registers: [this.registry],
      collect() {
        this.set(collectors.redisCommands());
      },
    });
    const mongoCount = new Gauge({
      name: 'pingdost_mailbox_mongo_pending_count',
      help: 'Envelopes in the Mongo delayed mailbox.',
      registers: [this.registry],
    });
    new Gauge({
      name: 'pingdost_mailbox_mongo_oldest_age_seconds',
      help: 'Age of the oldest envelope in the Mongo delayed mailbox.',
      registers: [this.registry],
      async collect() {
        const mailbox = await collectors.mongoMailbox();
        this.set(mailbox.oldestAgeSeconds);
        mongoCount.set(mailbox.count);
      },
    });
  }

  recordStage(snapshot: StageSnapshot): void {
    this.stageCount.set(snapshot.stageCount);
    this.stageOldestAge.set(snapshot.oldestAgeSeconds);
    this.dueBacklog.set(snapshot.dueBacklog);
    this.dueOverdue.set(snapshot.overdue);
  }
}
