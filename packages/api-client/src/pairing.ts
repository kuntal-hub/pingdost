import {
  CompletePairingResponseSchema,
  CreatePairingResponseSchema,
  InspectPairingResponseSchema,
  PAIRING_SECRET_HEADER,
  PairingStatusResponseSchema,
  type ApprovePairingRequest,
  type CompletePairingRequest,
  type CreatePairingRequest,
  type CreatePairingResponse,
  type InspectPairingRequest,
  type InspectPairingResponse,
  type PairingStatusResponse,
  type RegisterDeviceResponse,
} from '@pingdost/shared-types';

import type { ApiClient } from './client';

/**
 * `/v1/pairing/*` (Phase 16, ADR 0019). The browser creates, polls and completes without an
 * account session; the primary phone inspects and approves with its own.
 */
export interface PairingApi {
  create(body: CreatePairingRequest): Promise<CreatePairingResponse>;
  status(
    pairingId: string,
    pollSecret: string,
    signal?: AbortSignal,
  ): Promise<PairingStatusResponse>;
  complete(pairingId: string, body: CompletePairingRequest): Promise<RegisterDeviceResponse>;
  inspect(body: InspectPairingRequest): Promise<InspectPairingResponse>;
  approve(body: ApprovePairingRequest): Promise<void>;
}

export function pairingApi(client: ApiClient): PairingApi {
  const request = (id: string, rest = '') =>
    `/v1/pairing/requests/${encodeURIComponent(id)}${rest}`;
  return {
    create: (body) =>
      client.request({
        method: 'POST',
        path: '/v1/pairing/requests',
        body,
        auth: false,
        response: CreatePairingResponseSchema,
      }),
    status: (pairingId, pollSecret, signal) =>
      client.request({
        method: 'GET',
        path: request(pairingId),
        auth: false,
        headers: { [PAIRING_SECRET_HEADER]: pollSecret },
        response: PairingStatusResponseSchema,
        ...(signal ? { signal } : {}),
      }),
    complete: (pairingId, body) =>
      client.request({
        method: 'POST',
        path: request(pairingId, '/complete'),
        body,
        auth: false,
        response: CompletePairingResponseSchema,
      }),
    inspect: (body) =>
      client.request({
        method: 'POST',
        path: '/v1/pairing/inspect',
        body,
        response: InspectPairingResponseSchema,
      }),
    approve: (body) => client.request({ method: 'POST', path: '/v1/pairing/approve', body }),
  };
}
