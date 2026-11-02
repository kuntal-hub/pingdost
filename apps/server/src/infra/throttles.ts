/**
 * Per-account and per-email budgets (in-memory `WindowCounter`s), on top of the per-IP
 * route limits in `rate-limits.ts` (ADR 0007, ADR 0008).
 */
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export interface Budget {
  limit: number;
  windowMs: number;
}

export interface ThrottleSettings {
  /** Failed logins per identifier before it is locked for the rest of the window. */
  loginFailures: Budget;
  /** OTP emails per address. */
  otpSends: Budget;
  /** OTP checks per address and purpose, across codes. */
  otpChecks: Budget;
  /** Exact username lookups per account. */
  usernameLookups: Budget;
  /** One-time keys claimed per account (one per device in each claim). */
  keyClaims: Budget;
  /** Phone replacement attempts per account: requests, codes and replacements (ADR 0022). */
  phoneReplacements: Budget;
  /**
   * Envelopes one account may leave in the mailbox for one recipient device (the offline
   * path; online deliveries are not counted). Phase 27: bounds never-delivered queues.
   */
  storedPerRecipientDevice: Budget;
  /** Ciphertext bytes one account may leave in the mailbox, across all recipients. */
  storedBytesPerSender: Budget;
}

const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_THROTTLES: ThrottleSettings = {
  loginFailures: { limit: 5, windowMs: 15 * MINUTE_MS },
  otpSends: { limit: 5, windowMs: HOUR_MS },
  otpChecks: { limit: 15, windowMs: HOUR_MS },
  usernameLookups: { limit: 30, windowMs: 15 * MINUTE_MS },
  keyClaims: { limit: 500, windowMs: HOUR_MS },
  phoneReplacements: { limit: 10, windowMs: HOUR_MS },
  // Generous for people (messages, receipts, edits and group fan-out to offline devices);
  // one account can then hold at most about 14 × 32 MiB in the 14-day mailbox.
  storedPerRecipientDevice: { limit: 5_000, windowMs: DAY_MS },
  storedBytesPerSender: { limit: 32 * 1024 * 1024, windowMs: DAY_MS },
};
