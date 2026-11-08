/**
 * Security audit events (REQ §5.1): minimal metadata with a documented retention
 * (`SECURITY_EVENT_RETENTION_SECONDS`, TTL index). IPs are stored only as keyed hashes and
 * user agents truncated. Recording never fails a request.
 */
import type { Collection, Db } from 'mongodb';
import type { Logger } from 'pino';

import { uuidv7 } from '@pingdost/protocol';

import type { Clock } from '../../infra/clock';
import type { IndexSetup } from '../../infra/mongo';
import type { Hasher } from '../../infra/secrets';

export type SecurityEventType =
  | 'register'
  | 'login_ok'
  | 'login_fail'
  | 'otp_fail'
  | 'refresh_reuse'
  | 'password_reset'
  | 'password_change'
  | 'logout'
  | 'google_link'
  | 'device_register'
  | 'device_resume'
  | 'device_revoke'
  /** The primary phone approved a browser (ADR 0019). */
  | 'pairing_approve'
  /** The approved browser proved its keys and became a linked device. */
  | 'device_link'
  /** Replacing the primary phone (ADR 0022): a new phone asked, the old one decided. */
  | 'primary_transfer_request'
  | 'primary_transfer_approve'
  | 'primary_transfer_deny'
  | 'primary_transfer_complete'
  /** A new phone with the backup's account key and an email code replaced the primary. */
  | 'primary_replace'
  /** A new phone started fresh with a new account key: every device was revoked. */
  | 'identity_reset'
  /** The account was deleted with an email code (ADR 0036); only this event keeps its ID. */
  | 'account_delete';

export interface SecurityEventDoc {
  _id: string;
  type: SecurityEventType;
  userId: string | null;
  /** HMAC of the client IP (not reversible without the server pepper). */
  ipHash: string | null;
  /** First 128 characters. */
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date;
}

/** Who made the request, as far as the audit log needs to know. */
export interface RequestContext {
  ip: string | undefined;
  userAgent: string | undefined;
}

export const securityEventIndexes: IndexSetup = async (db) => {
  const events = db.collection<SecurityEventDoc>('security_events');
  await events.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await events.createIndex({ userId: 1, createdAt: -1 });
};

export class SecurityEvents {
  readonly #events: Collection<SecurityEventDoc>;

  constructor(
    db: Db,
    private readonly hasher: Hasher,
    private readonly retentionSeconds: number,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {
    this.#events = db.collection<SecurityEventDoc>('security_events');
  }

  async record(
    type: SecurityEventType,
    context: RequestContext,
    userId: string | null = null,
  ): Promise<void> {
    const now = this.clock.now();
    try {
      await this.#events.insertOne({
        _id: uuidv7(),
        type,
        userId,
        ipHash: context.ip ? this.hasher.hash('ip', context.ip) : null,
        userAgent: context.userAgent?.slice(0, 128) ?? null,
        createdAt: new Date(now),
        expiresAt: new Date(now + this.retentionSeconds * 1000),
      });
    } catch (error) {
      this.log.warn({ err: error, eventType: type }, 'security event not recorded');
    }
  }
}
