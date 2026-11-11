import {
  CircleRequestsResponseSchema,
  CircleResponseSchema,
  SendCircleRequestResponseSchema,
  type CircleMember,
  type CircleRequestsResponse,
  type SendCircleRequestResponse,
} from '@pingdost/shared-types';

import type { ApiClient } from './client';

/** `/v1/circle*` (Phase 37, ADR 0041). */
export interface CirclesApi {
  /** The people in this account's circle, oldest link first. */
  list(): Promise<CircleMember[]>;
  /** Removes the link; no notice is sent. */
  remove(userId: string): Promise<void>;
  requests(): Promise<CircleRequestsResponse>;
  /** `linked` when they had asked first (this accepts it) or the link already existed. */
  request(userId: string): Promise<SendCircleRequestResponse['status']>;
  accept(userId: string): Promise<void>;
  /** Silent: they keep seeing "requested" until it expires. */
  decline(userId: string): Promise<void>;
  /** Withdraws this account's own request to `userId`. */
  withdraw(userId: string): Promise<void>;
}

export function circlesApi(client: ApiClient): CirclesApi {
  const id = (userId: string) => encodeURIComponent(userId);
  return {
    list: async () =>
      (await client.request({ method: 'GET', path: '/v1/circle', response: CircleResponseSchema }))
        .members,
    remove: (userId) => client.request({ method: 'DELETE', path: `/v1/circle/${id(userId)}` }),
    requests: () =>
      client.request({
        method: 'GET',
        path: '/v1/circle/requests',
        response: CircleRequestsResponseSchema,
      }),
    request: async (userId) =>
      (
        await client.request({
          method: 'POST',
          path: '/v1/circle/requests',
          body: { userId },
          response: SendCircleRequestResponseSchema,
        })
      ).status,
    accept: (userId) =>
      client.request({ method: 'POST', path: `/v1/circle/requests/${id(userId)}/accept` }),
    decline: (userId) =>
      client.request({ method: 'POST', path: `/v1/circle/requests/${id(userId)}/decline` }),
    withdraw: (userId) =>
      client.request({ method: 'DELETE', path: `/v1/circle/requests/${id(userId)}` }),
  };
}
