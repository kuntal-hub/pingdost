/** `/v1/auth/*` routes (Phase 5). DTOs come from `@pingdost/shared-types`. */
import type { FastifyPluginCallback, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import {
  AuthSessionSchema,
  AuthTokensSchema,
  EmailRequestSchema,
  LoginRequestSchema,
  PasswordChangeRequestSchema,
  PasswordResetRequestSchema,
  RefreshRequestSchema,
  RegisterRequestSchema,
  RegisterResponseSchema,
  VerifyEmailRequestSchema,
} from '@pingdost/shared-types';

import { authOf } from './guard';
import type { AuthService } from './service';
import type { RouteLimits } from '../../infra/rate-limits';
import type { RequestContext } from '../security/events';

export interface AuthRoutesOptions {
  service: AuthService;
  authenticate: preHandlerAsyncHookHandler;
  limits: RouteLimits;
}

export function contextOf(request: FastifyRequest): RequestContext {
  return { ip: request.ip, userAgent: request.headers['user-agent'] };
}

export const authRoutes: FastifyPluginCallback<AuthRoutesOptions> = (fastify, options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { service, authenticate, limits } = options;

  app.post(
    '/v1/auth/register',
    {
      config: { rateLimit: limits.register },
      schema: { body: RegisterRequestSchema, response: { 201: RegisterResponseSchema } },
    },
    async (request, reply) =>
      reply.code(201).send(await service.register(request.body, contextOf(request))),
  );

  app.post(
    '/v1/auth/email/verify',
    {
      config: { rateLimit: limits.verifyEmail },
      schema: { body: VerifyEmailRequestSchema, response: { 200: AuthSessionSchema } },
    },
    async (request) => service.verifyEmail(request.body, contextOf(request)),
  );

  app.post(
    '/v1/auth/email/resend',
    { config: { rateLimit: limits.resendOtp }, schema: { body: EmailRequestSchema } },
    async (request, reply) => {
      await service.resendVerification(request.body.email);
      return reply.code(204).send();
    },
  );

  app.post(
    '/v1/auth/login',
    {
      config: { rateLimit: limits.login },
      schema: { body: LoginRequestSchema, response: { 200: AuthSessionSchema } },
    },
    async (request) => service.login(request.body, contextOf(request)),
  );

  app.post(
    '/v1/auth/refresh',
    {
      config: { rateLimit: limits.refresh },
      schema: { body: RefreshRequestSchema, response: { 200: AuthTokensSchema } },
    },
    async (request) => service.refresh(request.body.refreshToken, contextOf(request)),
  );

  app.post(
    '/v1/auth/logout',
    { config: { rateLimit: limits.logout }, preHandler: authenticate },
    async (request, reply) => {
      const { sessionId, userId } = authOf(request);
      await service.logout(sessionId, userId, contextOf(request));
      return reply.code(204).send();
    },
  );

  app.post(
    '/v1/auth/password/forgot',
    { config: { rateLimit: limits.forgotPassword }, schema: { body: EmailRequestSchema } },
    async (request, reply) => {
      await service.forgotPassword(request.body.email);
      return reply.code(204).send();
    },
  );

  app.post(
    '/v1/auth/password/reset',
    { config: { rateLimit: limits.resetPassword }, schema: { body: PasswordResetRequestSchema } },
    async (request, reply) => {
      await service.resetPassword(request.body, contextOf(request));
      return reply.code(204).send();
    },
  );

  app.post(
    '/v1/auth/password/change',
    {
      config: { rateLimit: limits.changePassword },
      preHandler: authenticate,
      schema: { body: PasswordChangeRequestSchema },
    },
    async (request, reply) => {
      const { userId, sessionId } = authOf(request);
      await service.changePassword(userId, sessionId, request.body, contextOf(request));
      return reply.code(204).send();
    },
  );
  done();
};
