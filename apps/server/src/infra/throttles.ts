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
}

export const DEFAULT_THROTTLES: ThrottleSettings = {
  loginFailures: { limit: 5, windowMs: 15 * MINUTE_MS },
  otpSends: { limit: 5, windowMs: HOUR_MS },
  otpChecks: { limit: 15, windowMs: HOUR_MS },
  usernameLookups: { limit: 30, windowMs: 15 * MINUTE_MS },
  keyClaims: { limit: 500, windowMs: HOUR_MS },
};
