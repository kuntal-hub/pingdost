/**
 * Per-route budgets for `@fastify/rate-limit` (in-memory store, keyed by client IP). Per-account
 * and per-email throttles live in the services (`AuthThrottleSettings`).
 */
const MINUTE = 60_000;
const HOUR = 3_600_000;

export interface RouteLimit {
  max: number;
  /** Milliseconds. */
  timeWindow: number;
}

export const DEFAULT_ROUTE_LIMITS = {
  register: { max: 10, timeWindow: HOUR },
  verifyEmail: { max: 30, timeWindow: 15 * MINUTE },
  resendOtp: { max: 10, timeWindow: HOUR },
  login: { max: 30, timeWindow: 15 * MINUTE },
  refresh: { max: 60, timeWindow: 15 * MINUTE },
  logout: { max: 60, timeWindow: 15 * MINUTE },
  forgotPassword: { max: 10, timeWindow: HOUR },
  resetPassword: { max: 30, timeWindow: 15 * MINUTE },
  changePassword: { max: 10, timeWindow: 15 * MINUTE },
  me: { max: 300, timeWindow: 15 * MINUTE },
} satisfies Record<string, RouteLimit>;

export type RouteLimitName = keyof typeof DEFAULT_ROUTE_LIMITS;
export type RouteLimits = Record<RouteLimitName, RouteLimit>;
