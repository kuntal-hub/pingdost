/**
 * `/v1/attachments*` (Phase 14, ADR 0017). The JSON routes need a device-bound session; the
 * part upload and the download (`fs` store only) are authorized by their HMAC-signed URL alone,
 * like presigned S3 URLs, and carry ciphertext only.
 */
import type { FastifyPluginCallback, preHandlerAsyncHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  AttachmentStatusResponseSchema,
  CreateAttachmentRequestSchema,
  CreateAttachmentResponseSchema,
  DownloadUrlResponseSchema,
  IdSchema,
} from '@pingdost/shared-types';

import type { AttachmentService, AuthDevice } from './service';
import type { UrlSigner } from './signer';
import { FsAttachmentStore } from './store/fs';
import type { Clock } from '../../infra/clock';
import { AppError } from '../../infra/errors';
import type { RouteLimits } from '../../infra/rate-limits';
import { authOf } from '../auth/guard';

export interface AttachmentRoutesOptions {
  attachments: AttachmentService;
  signer: UrlSigner;
  authenticate: preHandlerAsyncHookHandler;
  limits: RouteLimits;
  clock: Clock;
}

function device(request: Parameters<typeof authOf>[0]): AuthDevice {
  const { userId, deviceId } = authOf(request);
  if (!deviceId) throw new AppError('DEVICE_REQUIRED');
  return { userId, deviceId };
}

/** `bytes=start-end` (one range; either side may be open). */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'bad' | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return 'bad';
  let start: number;
  let end: number;
  if (match[1] === '') {
    // A suffix: the last N bytes.
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  return start > end || start >= size ? 'bad' : { start, end };
}

export const attachmentRoutes: FastifyPluginCallback<AttachmentRoutesOptions> = (
  fastify,
  options,
  done,
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { attachments, signer, authenticate, limits, clock } = options;
  const idParams = z.object({ attachmentId: IdSchema });

  app.post(
    '/v1/attachments',
    {
      config: { rateLimit: limits.attachmentsCreate },
      preHandler: authenticate,
      schema: {
        body: CreateAttachmentRequestSchema,
        response: { 201: CreateAttachmentResponseSchema },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await attachments.create(device(request), request.body)),
  );

  app.get(
    '/v1/attachments/:attachmentId/status',
    {
      config: { rateLimit: limits.attachmentsRead },
      preHandler: authenticate,
      schema: { params: idParams, response: { 200: AttachmentStatusResponseSchema } },
    },
    (request) => attachments.status(device(request), request.params.attachmentId),
  );

  app.post(
    '/v1/attachments/:attachmentId/complete',
    {
      config: { rateLimit: limits.attachmentsRead },
      preHandler: authenticate,
      schema: { params: idParams, response: { 200: AttachmentStatusResponseSchema } },
    },
    (request) => attachments.complete(device(request), request.params.attachmentId),
  );

  app.post(
    '/v1/attachments/:attachmentId/download-url',
    {
      config: { rateLimit: limits.attachmentsRead },
      preHandler: authenticate,
      schema: { params: idParams, response: { 200: DownloadUrlResponseSchema } },
    },
    (request) => attachments.downloadUrl(device(request), request.params.attachmentId),
  );

  app.post(
    '/v1/attachments/:attachmentId/ack',
    {
      config: { rateLimit: limits.attachmentsAck },
      preHandler: authenticate,
      schema: { params: idParams },
    },
    async (request, reply) => {
      await attachments.ack(device(request), request.params.attachmentId);
      return reply.code(204).send();
    },
  );

  // The `fs` store's signed URLs, served here (S3 serves its own).
  const store = attachments.store;
  if (store instanceof FsAttachmentStore) {
    app.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: attachments.partSize },
      (_request, body, finish) => finish(null, body),
    );
    const signed = z.object({ exp: z.coerce.number().int(), sig: z.string().min(1).max(64) });

    app.put(
      '/v1/attachments/:attachmentId/parts/:index',
      {
        bodyLimit: attachments.partSize,
        config: { rateLimit: limits.attachmentParts },
        schema: {
          params: z.object({ attachmentId: IdSchema, index: z.coerce.number().int().min(0) }),
          querystring: signed,
        },
      },
      async (request, reply) => {
        const { attachmentId, index } = request.params;
        const { exp, sig } = request.query;
        if (!signer.checkUpload(attachmentId, index, exp, sig, clock.now())) {
          throw new AppError('FORBIDDEN', { detail: 'The upload URL is invalid or expired.' });
        }
        const body = request.body;
        if (!(body instanceof Buffer)) {
          throw new AppError('VALIDATION_FAILED', { detail: 'Send application/octet-stream.' });
        }
        await attachments.acceptPart(attachmentId, index, body.length);
        await store.writePart(attachmentId, index, body);
        return reply.code(200).send();
      },
    );

    app.get(
      '/v1/attachments/:attachmentId/blob',
      {
        config: { rateLimit: limits.attachmentBlob },
        schema: { params: idParams, querystring: signed.extend({ device: IdSchema }) },
      },
      async (request, reply) => {
        const { attachmentId } = request.params;
        const { exp, sig, device: deviceId } = request.query;
        if (!signer.checkDownload(attachmentId, deviceId, exp, sig, clock.now())) {
          throw new AppError('FORBIDDEN', { detail: 'The download URL is invalid or expired.' });
        }
        await attachments.acceptDownload(attachmentId, deviceId);
        const size = await store.size(attachmentId);
        if (size === undefined) throw new AppError('ATTACHMENT_NOT_FOUND');
        void reply
          .header('cache-control', 'no-store')
          .header('accept-ranges', 'bytes')
          .type('application/octet-stream');
        const range = parseRange(request.headers.range, size);
        if (range === 'bad') {
          return reply.code(416).header('content-range', `bytes */${size}`).send();
        }
        if (range) {
          return reply
            .code(206)
            .header('content-range', `bytes ${range.start}-${range.end}/${size}`)
            .header('content-length', range.end - range.start + 1)
            .send(store.stream(attachmentId, range.start, range.end));
        }
        return reply.header('content-length', size).send(store.stream(attachmentId, 0, size - 1));
      },
    );
  }

  done();
};
