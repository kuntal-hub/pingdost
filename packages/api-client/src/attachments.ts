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

/** The API's own signed routes (the `fs` store); an object store's URLs look different. */
const API_SIGNED_ROUTE = /^[a-z][a-z\d+.-]*:\/\/[^/?#]+(\/v1\/attachments\/[^#]*)$/i;

/**
 * A signed URL on the API's own attachment routes, moved to the address this client reaches
 * the API at. The server names itself with `PUBLIC_API_URL`, which only one kind of client can
 * share in development: a phone on the LAN, an emulator (`10.0.2.2`) and `adb reverse`
 * (`127.0.0.1`) each reach the same server under another address, and `localhost` from a
 * phone is the phone itself. The signature covers the path and query only, so it still holds.
 * Object-store URLs (`s3`) are left as they are.
 */
export function rebaseSignedUrl(url: string, baseUrl: string | undefined): string {
  if (!baseUrl) return url;
  const route = API_SIGNED_ROUTE.exec(url)?.[1];
  return route ? `${baseUrl.replace(/\/+$/, '')}${route}` : url;
}

export function attachmentsApi(client: ApiClient): AttachmentsApi {
  const path = (id: string, rest = '') => `/v1/attachments/${encodeURIComponent(id)}${rest}`;
  const rebase = (url: string) => rebaseSignedUrl(url, client.baseUrl);
  const withUploadUrls = <T extends { uploadUrls: { index: number; url: string }[] }>(
    body: T,
  ): T => ({ ...body, uploadUrls: body.uploadUrls.map((u) => ({ ...u, url: rebase(u.url) })) });
  return {
    create: async (body) =>
      withUploadUrls(
        await client.request({
          method: 'POST',
          path: '/v1/attachments',
          body,
          response: CreateAttachmentResponseSchema,
        }),
      ),
    status: async (id) =>
      withUploadUrls(
        await client.request({
          method: 'GET',
          path: path(id, '/status'),
          response: AttachmentStatusResponseSchema,
        }),
      ),
    complete: async (id) =>
      withUploadUrls(
        await client.request({
          method: 'POST',
          path: path(id, '/complete'),
          response: AttachmentStatusResponseSchema,
        }),
      ),
    downloadUrl: async (id) => {
      const link = await client.request({
        method: 'POST',
        path: path(id, '/download-url'),
        response: DownloadUrlResponseSchema,
      });
      return { ...link, url: rebase(link.url) };
    },
    ack: (id) => client.request({ method: 'POST', path: path(id, '/ack') }),
  };
}
