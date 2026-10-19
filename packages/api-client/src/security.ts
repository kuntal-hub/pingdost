import {
  BlockListResponseSchema,
  CreateReportResponseSchema,
  type CreateReportRequest,
  type CreateReportResponse,
} from '@pingdost/shared-types';

import type { ApiClient } from './client';

/** `/v1/blocks*`, `/v1/reports` (Phase 11). */
export interface SecurityApi {
  /** The users this account blocked. */
  listBlocks(): Promise<string[]>;
  block(userId: string): Promise<void>;
  unblock(userId: string): Promise<void>;
  /** Attached messages are plaintext the user chose to disclose. */
  report(body: CreateReportRequest): Promise<CreateReportResponse>;
}

export function securityApi(client: ApiClient): SecurityApi {
  return {
    listBlocks: async () =>
      (
        await client.request({
          method: 'GET',
          path: '/v1/blocks',
          response: BlockListResponseSchema,
        })
      ).userIds,
    block: (userId) =>
      client.request({ method: 'PUT', path: `/v1/blocks/${encodeURIComponent(userId)}` }),
    unblock: (userId) =>
      client.request({ method: 'DELETE', path: `/v1/blocks/${encodeURIComponent(userId)}` }),
    report: (body) =>
      client.request({
        method: 'POST',
        path: '/v1/reports',
        body,
        response: CreateReportResponseSchema,
      }),
  };
}
