/**
 * Email/password auth (REQ §6.1, ARCHITECTURE A2, ADR 0007): registration with email OTP
 * verification, login with lockout, rotating refresh tokens with reuse detection, logout and
 * password reset/change.
 */
import type { Filter } from 'mongodb';
import type { Logger } from 'pino';

import type { ServerConfig } from '@pingdost/config';
import { uuidv7 } from '@pingdost/protocol';
import type {
  AuthSession,
  AuthTokens,
  LoginRequest,
  PasswordChangeRequest,
  PasswordResetRequest,
  RegisterRequest,
  RegisterResponse,
  VerifyEmailRequest,
} from '@pingdost/shared-types';

import type { PasswordHasher } from './passwords';
import {
  DEFAULT_PRIVACY,
  USED_REFRESH_HASHES_KEPT,
  type AuthCollections,
  type SessionDoc,
  type UserDoc,
} from './repo';
import { isReservedUsername } from './reserved-usernames';
import type { AccessTokens } from './tokens';
import type { Clock } from '../../infra/clock';
import { WindowCounter } from '../../infra/counters';
import { AppError } from '../../infra/errors';
import { duplicateKeyField } from '../../infra/mongo';
import { randomToken, safeEqual, sixDigitCode, type Hasher } from '../../infra/secrets';
import { otpEmail, type EmailProvider, type OtpPurpose } from '../email';
import type { RequestContext, SecurityEvents } from '../security/events';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Per-account and per-email budgets, on top of the per-IP route limits. */
export interface AuthThrottleSettings {
  /** Failed logins per identifier before it is locked for the rest of the window. */
  loginFailures: { limit: number; windowMs: number };
  /** OTP emails per address. */
  otpSends: { limit: number; windowMs: number };
  /** OTP checks per address and purpose, across codes. */
  otpChecks: { limit: number; windowMs: number };
}

export const DEFAULT_AUTH_THROTTLES: AuthThrottleSettings = {
  loginFailures: { limit: 5, windowMs: 15 * MINUTE_MS },
  otpSends: { limit: 5, windowMs: HOUR_MS },
  otpChecks: { limit: 15, windowMs: HOUR_MS },
};

export interface AuthServiceDeps {
  config: ServerConfig;
  collections: AuthCollections;
  passwords: PasswordHasher;
  tokens: AccessTokens;
  hasher: Hasher;
  email: EmailProvider;
  events: SecurityEvents;
  clock: Clock;
  log: Logger;
  throttles?: AuthThrottleSettings;
}

export class AuthService {
  readonly #d: AuthServiceDeps;
  readonly #loginFailures: WindowCounter;
  readonly #otpSends: WindowCounter;
  readonly #otpChecks: WindowCounter;

  constructor(deps: AuthServiceDeps) {
    this.#d = deps;
    const throttles = deps.throttles ?? DEFAULT_AUTH_THROTTLES;
    const counter = ({ limit, windowMs }: { limit: number; windowMs: number }) =>
      new WindowCounter(limit, windowMs, deps.clock);
    this.#loginFailures = counter(throttles.loginFailures);
    this.#otpSends = counter(throttles.otpSends);
    this.#otpChecks = counter(throttles.otpChecks);
  }

  // Registration and email verification

  async register(input: RegisterRequest, context: RequestContext): Promise<RegisterResponse> {
    const { users } = this.#d.collections;
    if (isReservedUsername(input.username)) throw new AppError('USERNAME_RESERVED');

    const existing = await users.findOne({ email: input.email });
    if (existing) {
      if (existing.status !== 'pending_verification') throw new AppError('EMAIL_TAKEN');
      // An unverified registration does not hold the address: the owner may start over.
      await users.deleteOne({ _id: existing._id, status: 'pending_verification' });
    }

    const now = this.#now();
    const user: UserDoc = {
      _id: uuidv7(),
      username: input.username,
      email: input.email,
      passwordHash: await this.#d.passwords.hash(input.password),
      authProviders: ['password'],
      status: 'pending_verification',
      displayName: null,
      avatarUrl: null,
      privacy: DEFAULT_PRIVACY,
      accountIdentityKey: null,
      createdAt: now,
      updatedAt: now,
      pendingExpiresAt: new Date(
        now.getTime() + this.#d.config.UNVERIFIED_ACCOUNT_TTL_SECONDS * 1000,
      ),
    };
    try {
      await users.insertOne(user);
    } catch (error) {
      const field = duplicateKeyField(error);
      if (field === 'username') throw new AppError('USERNAME_TAKEN');
      if (field === 'email') throw new AppError('EMAIL_TAKEN');
      throw error;
    }

    await this.#sendOtp('verify_email', user.email);
    await this.#d.events.record('register', context, user._id);
    return { userId: user._id, status: user.status };
  }

  async verifyEmail(input: VerifyEmailRequest, context: RequestContext): Promise<AuthSession> {
    await this.#checkOtp('verify_email', input.email, input.otp, context);
    const user = await this.#d.collections.users.findOneAndUpdate(
      { email: input.email, status: 'pending_verification' },
      { $set: { status: 'active', updatedAt: this.#now() }, $unset: { pendingExpiresAt: '' } },
      { returnDocument: 'after' },
    );
    // The account expired between sending and using the code.
    if (!user) throw new AppError('OTP_EXPIRED');
    return this.#sessionFor(user, context);
  }

  /** Always succeeds for unknown or verified addresses, so it reveals nothing. */
  async resendVerification(email: string): Promise<void> {
    const user = await this.#d.collections.users.findOne({ email });
    if (user?.status !== 'pending_verification') return;
    await this.#sendOtp('verify_email', email);
  }

  // Login, refresh, logout

  async login(input: LoginRequest, context: RequestContext): Promise<AuthSession> {
    const identifier = input.identifier.trim().toLowerCase();
    const lock = this.#loginFailures.peek(identifier);
    if (!lock.allowed) {
      throw new AppError('ACCOUNT_LOCKED', { retryAfterSeconds: lock.retryAfterSeconds });
    }

    const user = await this.#d.collections.users.findOne(
      identifier.includes('@') ? { email: identifier } : { username: identifier },
    );
    const ok = user?.passwordHash
      ? await this.#d.passwords.verify(user.passwordHash, input.password)
      : await this.#d.passwords.verifyAgainstDummy(input.password);
    if (!user || !ok) {
      this.#loginFailures.hit(identifier);
      await this.#d.events.record('login_fail', context, user?._id ?? null);
      throw new AppError('INVALID_CREDENTIALS');
    }
    this.#loginFailures.reset(identifier);

    if (user.status === 'pending_verification') throw new AppError('EMAIL_NOT_VERIFIED');
    if (user.status === 'disabled') throw new AppError('ACCOUNT_DISABLED');

    if (user.passwordHash && this.#d.passwords.needsRehash(user.passwordHash)) {
      await this.#setPassword(user._id, input.password);
    }
    await this.#d.events.record('login_ok', context, user._id);
    return this.#sessionFor(user, context);
  }

  /**
   * Rotates the refresh token. Presenting a token that was already rotated out means it was
   * copied: the whole session (token family) is revoked (ADR 0007).
   */
  async refresh(refreshToken: string, context: RequestContext): Promise<AuthTokens> {
    const { sessions } = this.#d.collections;
    const presented = this.#d.hasher.hash('refresh', refreshToken);
    const now = this.#now();
    const next = randomToken();
    const expiresAt = new Date(now.getTime() + this.#d.config.REFRESH_TOKEN_TTL_SECONDS * 1000);

    const session = await sessions.findOneAndUpdate(
      { refreshHash: presented, revokedAt: null, expiresAt: { $gt: now } },
      {
        $set: {
          refreshHash: this.#d.hasher.hash('refresh', next),
          lastUsedAt: now,
          expiresAt,
        },
        $push: { usedRefreshHashes: { $each: [presented], $slice: -USED_REFRESH_HASHES_KEPT } },
      },
      { returnDocument: 'after' },
    );
    if (session) return this.#tokens(session, next);

    const reused = await sessions.findOne({ usedRefreshHashes: presented });
    if (reused) {
      await this.#revoke({ _id: reused._id }, 'refresh_reuse');
      await this.#d.events.record('refresh_reuse', context, reused.userId);
      throw new AppError('TOKEN_REUSED');
    }
    throw new AppError('TOKEN_INVALID');
  }

  async logout(sessionId: string, userId: string, context: RequestContext): Promise<void> {
    await this.#revoke({ _id: sessionId }, 'logout');
    await this.#d.events.record('logout', context, userId);
  }

  // Passwords

  /** Always succeeds, so it reveals nothing about which addresses have accounts. */
  async forgotPassword(email: string): Promise<void> {
    const user = await this.#d.collections.users.findOne({ email });
    if (user?.status !== 'active' || !user.passwordHash) return;
    try {
      await this.#sendOtp('password_reset', email);
    } catch (error) {
      // Throttled, in cooldown or undeliverable: answer the same as for an unknown address.
      if (!(error instanceof AppError)) throw error;
      this.#d.log.info({ errorCode: error.code }, 'password reset code not sent');
    }
  }

  async resetPassword(input: PasswordResetRequest, context: RequestContext): Promise<void> {
    await this.#checkOtp('password_reset', input.email, input.otp, context);
    const user = await this.#d.collections.users.findOne({ email: input.email, status: 'active' });
    if (!user) throw new AppError('OTP_EXPIRED');
    await this.#setPassword(user._id, input.newPassword);
    await this.#revoke({ userId: user._id }, 'password_reset');
    this.#loginFailures.reset(user.email);
    if (user.username) this.#loginFailures.reset(user.username);
    await this.#d.events.record('password_reset', context, user._id);
  }

  async changePassword(
    userId: string,
    sessionId: string,
    input: PasswordChangeRequest,
    context: RequestContext,
  ): Promise<void> {
    const user = await this.#d.collections.users.findOne({ _id: userId });
    const ok = user?.passwordHash
      ? await this.#d.passwords.verify(user.passwordHash, input.currentPassword)
      : false;
    if (!user || !ok) throw new AppError('INVALID_CREDENTIALS');
    await this.#setPassword(userId, input.newPassword);
    // Other devices must sign in again; this one stays signed in.
    await this.#revoke({ userId, _id: { $ne: sessionId } }, 'password_change');
    await this.#d.events.record('password_change', context, userId);
  }

  // Helpers

  #now(): Date {
    return new Date(this.#d.clock.now());
  }

  async #setPassword(userId: string, password: string): Promise<void> {
    await this.#d.collections.users.updateOne(
      { _id: userId },
      { $set: { passwordHash: await this.#d.passwords.hash(password), updatedAt: this.#now() } },
    );
  }

  async #revoke(filter: Filter<SessionDoc>, reason: string): Promise<void> {
    await this.#d.collections.sessions.updateMany(
      { ...filter, revokedAt: null },
      { $set: { revokedAt: this.#now(), revokedReason: reason } },
    );
  }

  async #sessionFor(user: UserDoc, context: RequestContext): Promise<AuthSession> {
    const now = this.#now();
    const refreshToken = randomToken();
    const session: SessionDoc = {
      _id: uuidv7(),
      userId: user._id,
      deviceId: null,
      refreshHash: this.#d.hasher.hash('refresh', refreshToken),
      usedRefreshHashes: [],
      createdAt: now,
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + this.#d.config.REFRESH_TOKEN_TTL_SECONDS * 1000),
      revokedAt: null,
      revokedReason: null,
      userAgent: context.userAgent?.slice(0, 128) ?? null,
    };
    await this.#d.collections.sessions.insertOne(session);
    return {
      user: { userId: user._id, username: user.username, status: user.status },
      tokens: await this.#tokens(session, refreshToken),
    };
  }

  async #tokens(session: SessionDoc, refreshToken: string): Promise<AuthTokens> {
    const access = await this.#d.tokens.sign({ userId: session.userId, sessionId: session._id });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken,
      refreshTokenExpiresAt: session.expiresAt.getTime(),
    };
  }

  #otpHash(id: string, code: string): string {
    return this.#d.hasher.hash('otp', `${id}:${code}`);
  }

  /** Issues a fresh code (replacing any earlier one) and emails it. */
  async #sendOtp(purpose: OtpPurpose, email: string): Promise<void> {
    const { config, collections } = this.#d;
    const id = `${purpose}:${email}`;
    const now = this.#now();

    const previous = await collections.otps.findOne({ _id: id });
    const cooldownEnds = previous
      ? previous.lastSentAt.getTime() + config.EMAIL_OTP_RESEND_COOLDOWN_SECONDS * 1000
      : 0;
    if (cooldownEnds > now.getTime()) {
      throw new AppError('OTP_RESEND_COOLDOWN', {
        retryAfterSeconds: Math.ceil((cooldownEnds - now.getTime()) / 1000),
      });
    }
    const budget = this.#otpSends.hit(email);
    if (!budget.allowed) {
      throw new AppError('RATE_LIMITED', { retryAfterSeconds: budget.retryAfterSeconds });
    }

    const code = sixDigitCode();
    await collections.otps.replaceOne(
      { _id: id },
      {
        purpose,
        email,
        codeHash: this.#otpHash(id, code),
        attempts: 0,
        createdAt: now,
        lastSentAt: now,
        expiresAt: new Date(now.getTime() + config.EMAIL_OTP_TTL_SECONDS * 1000),
      },
      { upsert: true },
    );
    try {
      await this.#d.email.send({
        to: email,
        ...otpEmail(purpose, code, config.EMAIL_OTP_TTL_SECONDS),
      });
    } catch (error) {
      // No usable code was delivered: drop it so the cooldown does not block a retry.
      await collections.otps.deleteOne({ _id: id, lastSentAt: now });
      this.#d.log.error({ err: error, purpose }, 'OTP email not sent');
      throw new AppError('UNAVAILABLE', { detail: 'The email could not be sent. Try again.' });
    }
  }

  /**
   * Checks and consumes a code. Every check counts as an attempt (atomically, before the
   * comparison); the code is deleted after `EMAIL_OTP_MAX_ATTEMPTS` and when it is used.
   */
  async #checkOtp(
    purpose: OtpPurpose,
    email: string,
    code: string,
    context: RequestContext,
  ): Promise<void> {
    const { otps } = this.#d.collections;
    const id = `${purpose}:${email}`;
    const now = this.#now();
    const max = this.#d.config.EMAIL_OTP_MAX_ATTEMPTS;

    const budget = this.#otpChecks.hit(id);
    if (!budget.allowed) {
      throw new AppError('RATE_LIMITED', { retryAfterSeconds: budget.retryAfterSeconds });
    }

    const otp = await otps.findOneAndUpdate(
      { _id: id, expiresAt: { $gt: now }, attempts: { $lt: max } },
      { $inc: { attempts: 1 } },
      { returnDocument: 'after' },
    );
    if (!otp) {
      const exhausted = await otps.findOneAndDelete({ _id: id, attempts: { $gte: max } });
      await this.#d.events.record('otp_fail', context);
      throw new AppError(exhausted ? 'OTP_ATTEMPTS_EXCEEDED' : 'OTP_EXPIRED');
    }

    if (!safeEqual(otp.codeHash, this.#otpHash(id, code))) {
      await this.#d.events.record('otp_fail', context);
      if (otp.attempts >= max) {
        await otps.deleteOne({ _id: id });
        throw new AppError('OTP_ATTEMPTS_EXCEEDED');
      }
      throw new AppError('OTP_INVALID');
    }

    // Single use: only one request can delete it.
    const consumed = await otps.findOneAndDelete({ _id: id, codeHash: otp.codeHash });
    if (!consumed) throw new AppError('OTP_EXPIRED');
  }
}
