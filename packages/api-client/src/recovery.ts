import {
  ListPrimaryTransfersResponseSchema,
  PrimaryTransferStatusResponseSchema,
  RegisterDeviceResponseSchema,
  StartPrimaryTransferResponseSchema,
  type ApprovePrimaryTransferRequest,
  type CompletePrimaryTransferRequest,
  type ListPrimaryTransfersResponse,
  type PrimaryTransferStatusResponse,
  type RegisterDeviceResponse,
  type ReplacePrimaryRequest,
  type StartPrimaryTransferRequest,
  type StartPrimaryTransferResponse,
} from '@pingdost/shared-types';

import type { ApiClient } from './client';

/**
 * Replacing the primary phone (Phase 19, ADR 0022). The new phone calls `start`, `status`,
 * `complete`, `sendReplaceCode` and `replace` with a recent, device-less session; the old
 * phone `pending`, `approve` and `deny`; a linked browser `pending` and `deny`.
 */
export interface RecoveryApi {
  start(body: StartPrimaryTransferRequest): Promise<StartPrimaryTransferResponse>;
  status(requestId: string, signal?: AbortSignal): Promise<PrimaryTransferStatusResponse>;
  complete(
    requestId: string,
    body: CompletePrimaryTransferRequest,
  ): Promise<RegisterDeviceResponse>;
  pending(): Promise<ListPrimaryTransfersResponse>;
  approve(requestId: string, body: ApprovePrimaryTransferRequest): Promise<void>;
  deny(requestId: string): Promise<void>;
  sendReplaceCode(): Promise<void>;
  replace(body: ReplacePrimaryRequest): Promise<RegisterDeviceResponse>;
}

export function recoveryApi(client: ApiClient): RecoveryApi {
  const transfer = (id: string, rest = '') =>
    `/v1/devices/primary-transfer/${encodeURIComponent(id)}${rest}`;
  return {
    start: (body) =>
      client.request({
        method: 'POST',
        path: '/v1/devices/primary-transfer',
        body,
        response: StartPrimaryTransferResponseSchema,
      }),
    status: (requestId, signal) =>
      client.request({
        method: 'GET',
        path: transfer(requestId),
        response: PrimaryTransferStatusResponseSchema,
        ...(signal ? { signal } : {}),
      }),
    complete: (requestId, body) =>
      client.request({
        method: 'POST',
        path: transfer(requestId, '/complete'),
        body,
        response: RegisterDeviceResponseSchema,
      }),
    pending: () =>
      client.request({
        method: 'GET',
        path: '/v1/devices/primary-transfer',
        response: ListPrimaryTransfersResponseSchema,
      }),
    approve: (requestId, body) =>
      client.request({ method: 'POST', path: transfer(requestId, '/approve'), body }),
    deny: (requestId) => client.request({ method: 'POST', path: transfer(requestId, '/deny') }),
    sendReplaceCode: () =>
      client.request({ method: 'POST', path: '/v1/devices/primary-replace/otp' }),
    replace: (body) =>
      client.request({
        method: 'POST',
        path: '/v1/devices/primary-replace',
        body,
        response: RegisterDeviceResponseSchema,
      }),
  };
}
