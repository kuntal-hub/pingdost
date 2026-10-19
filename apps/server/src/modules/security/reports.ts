/**
 * Abuse reports (REQ §15, ADR 0014). The server cannot read chats, so a report holds only
 * what the reporter chose to send: a reason, optional details and, only if they picked
 * them, messages they decrypted on their device (plaintext they disclose on purpose).
 * Reports are deleted after `ABUSE_REPORT_RETENTION_SECONDS` (TTL index) and never logged.
 */
import type { Collection, Db } from 'mongodb';

import { uuidv7 } from '@pingdost/protocol';
import type { ParsedReportRequest, ReportReason, ReportedMessage } from '@pingdost/shared-types';

import type { Clock } from '../../infra/clock';
import { AppError } from '../../infra/errors';
import type { IndexSetup } from '../../infra/mongo';
import type { AuthCollections } from '../auth/repo';

export interface AbuseReportDoc {
  _id: string;
  reporterUserId: string;
  reportedUserId: string;
  reason: ReportReason;
  details: string | null;
  messages: ReportedMessage[];
  status: 'open';
  createdAt: Date;
  expiresAt: Date;
}

export const reportIndexes: IndexSetup = async (db) => {
  const reports = db.collection<AbuseReportDoc>('abuse_reports');
  await reports.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await reports.createIndex({ reportedUserId: 1, createdAt: -1 });
};

export class ReportService {
  readonly #reports: Collection<AbuseReportDoc>;

  constructor(
    db: Db,
    private readonly users: AuthCollections['users'],
    private readonly retentionSeconds: number,
    private readonly clock: Clock,
  ) {
    this.#reports = db.collection<AbuseReportDoc>('abuse_reports');
  }

  async create(reporterUserId: string, input: ParsedReportRequest): Promise<string> {
    if (input.reportedUserId === reporterUserId) {
      throw new AppError('VALIDATION_FAILED', { detail: 'You cannot report yourself.' });
    }
    if (!(await this.users.countDocuments({ _id: input.reportedUserId }, { limit: 1 }))) {
      throw new AppError('NOT_FOUND');
    }
    // Attached messages must be from the conversation between the two users.
    const parties = new Set([reporterUserId, input.reportedUserId]);
    if (input.messages.some((message) => !parties.has(message.senderUserId))) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'Attached messages must be from your chat with this user.',
      });
    }
    const now = this.clock.now();
    const reportId = uuidv7();
    await this.#reports.insertOne({
      _id: reportId,
      reporterUserId,
      reportedUserId: input.reportedUserId,
      reason: input.reason,
      details: input.details ? input.details : null,
      messages: input.messages,
      status: 'open',
      createdAt: new Date(now),
      expiresAt: new Date(now + this.retentionSeconds * 1000),
    });
    return reportId;
  }
}
