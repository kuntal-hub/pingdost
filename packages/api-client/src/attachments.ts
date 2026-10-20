import {
  AttachmentStatusResponseSchema,
  CreateAttachmentResponseSchema,
  DownloadUrlResponseSchema,
  type AttachmentStatusResponse,
  type CreateAttachmentRequest,
  type CreateAttachmentResponse,
  type DownloadUrlResponse,
} from '@pingdost/shared-types';

import type { ApiClient } from './client';

/**
 * `/v1/attachments*` (Phase 14): staging encrypted attachments. The part uploads and the
 * download itself go to the signed URLs these return, without the access token.
 */
export interface AttachmentsApi {
  create(body: CreateAttachmentRequest): Promise<CreateAttachmentResponse>;
  status(attachmentId: string): Promise<AttachmentStatusResponse>;
  /** The server checks the size and SHA-256 of the whole ciphertext. */
  complete(attachmentId: string): Promise<AttachmentStatusResponse>;
  downloadUrl(attachmentId: string): Promise<DownloadUrlResponse>;
  /** This device has the file: once every recipient device acknowledged, it is deleted. */
  ack(attachmentId: string): Promise<void>;
}

export function attachmentsApi(client: ApiClient): AttachmentsApi {
  const path = (id: string, rest = '') => `/v1/attachments/${encodeURIComponent(id)}${rest}`;
  return {
    create: (body) =>
      client.request({
        method: 'POST',
        path: '/v1/attachments',
        body,
        response: CreateAttachmentResponseSchema,
      }),
    status: (id) =>
      client.request({
        method: 'GET',
        path: path(id, '/status'),
        response: AttachmentStatusResponseSchema,
      }),
    complete: (id) =>
      client.request({
        method: 'POST',
        path: path(id, '/complete'),
        response: AttachmentStatusResponseSchema,
      }),
    downloadUrl: (id) =>
      client.request({
        method: 'POST',
        path: path(id, '/download-url'),
        response: DownloadUrlResponseSchema,
      }),
    ack: (id) => client.request({ method: 'POST', path: path(id, '/ack') }),
  };
}
