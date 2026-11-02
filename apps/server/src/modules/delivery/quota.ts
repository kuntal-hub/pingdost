/**
 * Per-sender budgets for the offline path (Phase 27, REQ §18 "never-delivered message
 * queues"): how many envelopes one account may leave for one recipient device, and how many
 * ciphertext bytes it may leave in the mailbox overall, per day. In memory, like the other
 * throttles (ARCHITECTURE A2), so it costs no Redis commands (ADR 0010). Online deliveries
 * and duplicates are not counted.
 */
import type { EnvelopeRecord } from './record';
import { DeliveryError } from './service';
import type { Clock } from '../../infra/clock';
import { WindowCounter } from '../../infra/counters';
import type { Budget } from '../../infra/throttles';

export interface MailboxQuotaBudgets {
  storedPerRecipientDevice: Budget;
  storedBytesPerSender: Budget;
}

export class MailboxQuota {
  readonly #perDevice: WindowCounter;
  readonly #bytes: WindowCounter;

  constructor(budgets: MailboxQuotaBudgets, clock: Clock) {
    const { storedPerRecipientDevice: device, storedBytesPerSender: bytes } = budgets;
    this.#perDevice = new WindowCounter(device.limit, device.windowMs, clock);
    this.#bytes = new WindowCounter(bytes.limit, bytes.windowMs, clock);
  }

  /** Throws `RATE_LIMITED` (the sender keeps it in its outbox) if storing would exceed one. */
  check(senderUserId: string, record: EnvelopeRecord): void {
    const pair = `${senderUserId}:${record.recipientDeviceId}`;
    if (
      !this.#perDevice.peek(pair).allowed ||
      !this.#bytes.peek(senderUserId, record.packet.length).allowed
    ) {
      throw new DeliveryError('RATE_LIMITED', 'mailbox budget for this sender is spent');
    }
  }

  /** Counts an envelope the mailbox newly stored. */
  count(senderUserId: string, record: EnvelopeRecord): void {
    this.#perDevice.hit(`${senderUserId}:${record.recipientDeviceId}`);
    this.#bytes.hit(senderUserId, record.packet.length);
  }
}
