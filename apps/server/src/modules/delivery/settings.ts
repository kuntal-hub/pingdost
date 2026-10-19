/** Mailbox timings and limits (REQ §9.1, ARCHITECTURE A3, A11), in milliseconds. */
import type { ServerConfig } from '@pingdost/config';

export interface MailboxSettings {
  /** How long an envelope stays in the Redis hot stage before migration. */
  stageMs: number;
  /** Extra time the Redis copy lives after the stage, so the migration can still run. */
  graceMs: number;
  /** Absolute retention from the server's receive time. */
  retentionMs: number;
  /** How long the online path waits for the recipient's transport ACK. */
  onlineAckTimeoutMs: number;
  migrationPollMs: number;
  reaperIntervalMs: number;
  envelopeMaxBytes: number;
  /** Prefix for every Redis key (tests give each server its own). */
  redisKeyPrefix: string;
  /** Envelopes per migration run. */
  migrationBatchSize: number;
  /** Envelopes per fetch batch on (re)connect. */
  fetchBatchSize: number;
  /** The per-envelope migration lock. */
  migrationLockMs: number;
}

export function mailboxSettings(config: ServerConfig): MailboxSettings {
  return {
    stageMs: config.MESSAGE_REDIS_STAGE_SECONDS * 1000,
    graceMs: config.MESSAGE_MIGRATION_GRACE_SECONDS * 1000,
    retentionMs: config.MESSAGE_MAX_RETENTION_SECONDS * 1000,
    onlineAckTimeoutMs: config.MESSAGE_ONLINE_ACK_TIMEOUT_MS,
    migrationPollMs: config.MESSAGE_MIGRATION_POLL_SECONDS * 1000,
    reaperIntervalMs: config.MESSAGE_REAPER_INTERVAL_SECONDS * 1000,
    envelopeMaxBytes: config.ENVELOPE_MAX_BYTES,
    redisKeyPrefix: '',
    migrationBatchSize: 200,
    fetchBatchSize: 50,
    migrationLockMs: 60_000,
  };
}
