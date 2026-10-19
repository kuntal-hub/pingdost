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
  google: { max: 30, timeWindow: 15 * MINUTE },
  googleComplete: { max: 10, timeWindow: 15 * MINUTE },
  me: { max: 300, timeWindow: 15 * MINUTE },
  meUpdate: { max: 60, timeWindow: 15 * MINUTE },
  userLookup: { max: 60, timeWindow: 15 * MINUTE },
  userProfile: { max: 300, timeWindow: 15 * MINUTE },
  avatarSign: { max: 20, timeWindow: 15 * MINUTE },
  deviceChallenge: { max: 30, timeWindow: 15 * MINUTE },
  deviceRegister: { max: 10, timeWindow: 15 * MINUTE },
  devicesList: { max: 120, timeWindow: 15 * MINUTE },
  deviceRevoke: { max: 30, timeWindow: 15 * MINUTE },
  keysUpload: { max: 60, timeWindow: 15 * MINUTE },
  keysCount: { max: 120, timeWindow: 15 * MINUTE },
  keysDirectory: { max: 300, timeWindow: 15 * MINUTE },
  keysClaim: { max: 120, timeWindow: 15 * MINUTE },
  blocksList: { max: 120, timeWindow: 15 * MINUTE },
  blocksChange: { max: 60, timeWindow: 15 * MINUTE },
  reports: { max: 10, timeWindow: HOUR },
  /** WebSocket upgrades; frames on an open socket have their own per-socket limits. */
  wsConnect: { max: 60, timeWindow: 15 * MINUTE },
  metrics: { max: 120, timeWindow: 15 * MINUTE },
} satisfies Record<string, RouteLimit>;

export type RouteLimitName = keyof typeof DEFAULT_ROUTE_LIMITS;
export type RouteLimits = Record<RouteLimitName, RouteLimit>;
