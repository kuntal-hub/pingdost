/**
 * Account module: `GET/PATCH /v1/me`, exact username lookup and signed avatar uploads
 * (Phases 5–6). Group names and avatars are not here: they are E2EE group content.
 */
import type { FastifyPluginCallback, preHandlerAsyncHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  AvatarUploadSignatureSchema,
  MeResponseSchema,
  UpdateMeRequestSchema,
  UserLookupResponseSchema,
  IdSchema,
  UsernameSchema,
  type MeResponse,
  type UpdateMeRequest,
} from '@pingdost/shared-types';

import { isOwnAvatarUrl, signAvatarUpload, type CloudinarySettings } from './cloudinary';
import type { Clock } from '../../infra/clock';
import { WindowCounter } from '../../infra/counters';
import { AppError } from '../../infra/errors';
import type { RouteLimits } from '../../infra/rate-limits';
import type { Budget } from '../../infra/throttles';
import { authOf } from '../auth/guard';
import { DEFAULT_PRIVACY, type AuthCollections, type UserDoc } from '../auth/repo';

export interface AccountRoutesOptions {
  collections: AuthCollections;
  authenticate: preHandlerAsyncHookHandler;
  limits: RouteLimits;
  clock: Clock;
  lookupBudget: Budget;
  /** Undefined when the Cloudinary variables are not set: avatars are then disabled. */
  cloudinary: CloudinarySettings | undefined;
  /** After a user changed their privacy preferences (the presence cache). */
  onPrivacyChanged?: (userId: string) => void;
}

export function toMe(user: UserDoc): MeResponse {
  return {
    userId: user._id,
    username: user.username,
    email: user.email,
    status: user.status,
    authProviders: user.authProviders,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    // Accounts made before a preference existed get its default.
    privacy: { ...DEFAULT_PRIVACY, ...user.privacy },
    accountIdentityKey: user.accountIdentityKey,
    createdAt: user.createdAt.getTime(),
  };
}

export const accountRoutes: FastifyPluginCallback<AccountRoutesOptions> = (
  fastify,
  options,
  done,
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { collections, authenticate, limits, clock, cloudinary } = options;
  const lookups = new WindowCounter(
    options.lookupBudget.limit,
    options.lookupBudget.windowMs,
    clock,
  );

  async function currentUser(userId: string): Promise<UserDoc> {
    const user = await collections.users.findOne({ _id: userId });
    if (!user) throw new AppError('UNAUTHENTICATED');
    return user;
  }

  function changes(userId: string, input: UpdateMeRequest): Record<string, unknown> {
    const set: Record<string, unknown> = {};
    if (input.displayName !== undefined) set.displayName = input.displayName;
    if (input.avatarUrl !== undefined) {
      const ours =
        input.avatarUrl === null ||
        (cloudinary !== undefined && isOwnAvatarUrl(cloudinary, userId, input.avatarUrl));
      if (!ours) {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'avatarUrl must be your uploaded avatar.',
        });
      }
      set.avatarUrl = input.avatarUrl;
    }
    for (const [name, value] of Object.entries(input.privacy ?? {})) {
      if (value !== undefined) set[`privacy.${name}`] = value;
    }
    return set;
  }

  app.get(
    '/v1/me',
    {
      config: { rateLimit: limits.me },
      preHandler: authenticate,
      schema: { response: { 200: MeResponseSchema } },
    },
    async (request) => toMe(await currentUser(authOf(request).userId)),
  );

  app.patch(
    '/v1/me',
    {
      config: { rateLimit: limits.meUpdate },
      preHandler: authenticate,
      schema: { body: UpdateMeRequestSchema, response: { 200: MeResponseSchema } },
    },
    async (request) => {
      const { userId } = authOf(request);
      const user = await collections.users.findOneAndUpdate(
        { _id: userId },
        { $set: { ...changes(userId, request.body), updatedAt: new Date(clock.now()) } },
        { returnDocument: 'after' },
      );
      if (!user) throw new AppError('UNAUTHENTICATED');
      if (request.body.privacy) options.onPrivacyChanged?.(userId);
      return toMe(user);
    },
  );

  app.get(
    '/v1/users/by-username/:username',
    {
      config: { rateLimit: limits.userLookup },
      preHandler: authenticate,
      schema: {
        params: z.object({ username: UsernameSchema }),
        response: { 200: UserLookupResponseSchema },
      },
    },
    async (request) => {
      const budget = lookups.hit(authOf(request).userId);
      if (!budget.allowed) {
        throw new AppError('RATE_LIMITED', { retryAfterSeconds: budget.retryAfterSeconds });
      }
      // Exact match only (ARCHITECTURE A2): no prefix or fuzzy search.
      const user = await collections.users.findOne({
        username: request.params.username,
        status: 'active',
      });
      if (!user?.username) throw new AppError('NOT_FOUND');
      return {
        userId: user._id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
      };
    },
  );

  // The profile behind a user ID, e.g. of someone who started a chat (ADR 0012). IDs are
  // random UUIDv7s learned only from messages, so this cannot enumerate accounts.
  app.get(
    '/v1/users/:userId',
    {
      config: { rateLimit: limits.userProfile },
      preHandler: authenticate,
      schema: {
        params: z.object({ userId: IdSchema }),
        response: { 200: UserLookupResponseSchema },
      },
    },
    async (request) => {
      const user = await collections.users.findOne({
        _id: request.params.userId,
        status: 'active',
      });
      if (!user?.username) throw new AppError('NOT_FOUND');
      return {
        userId: user._id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
      };
    },
  );

  app.post(
    '/v1/me/avatar/sign',
    {
      config: { rateLimit: limits.avatarSign },
      preHandler: authenticate,
      schema: { response: { 200: AvatarUploadSignatureSchema } },
    },
    (request) => {
      if (!cloudinary) {
        throw new AppError('UNAVAILABLE', { detail: 'Avatar uploads are not configured.' });
      }
      return signAvatarUpload(cloudinary, authOf(request).userId, clock.now());
    },
  );

  done();
};
