import type { PushTokenRequest } from '@pingdost/shared-types';

import type { ApiClient } from './client';

/** `/v1/push/token` (Phase 12): the calling device's wake address. */
export interface PushApi {
  /** Registers or replaces this device's token; idempotent. */
  registerToken(body: PushTokenRequest): Promise<void>;
  /** Stops wakes for this device (sign-out); idempotent. */
  unregisterToken(): Promise<void>;
}

export function pushApi(client: ApiClient): PushApi {
  return {
    registerToken: (body) => client.request({ method: 'PUT', path: '/v1/push/token', body }),
    unregisterToken: () => client.request({ method: 'DELETE', path: '/v1/push/token' }),
  };
}
