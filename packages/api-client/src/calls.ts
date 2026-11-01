import {
  TurnCredentialsResponseSchema,
  type TurnCredentialsResponse,
} from '@pingdost/shared-types';

import type { ApiClient } from './client';

/** `/v1/calls/*` (Phase 25, ADR 0028). Signaling itself is E2EE over the WebSocket. */
export interface CallsApi {
  /** STUN and short-lived TURN credentials; fetch them for each call. */
  turnCredentials(): Promise<TurnCredentialsResponse>;
}

export function callsApi(client: ApiClient): CallsApi {
  return {
    turnCredentials: () =>
      client.request({
        method: 'GET',
        path: '/v1/calls/turn-credentials',
        response: TurnCredentialsResponseSchema,
      }),
  };
}
