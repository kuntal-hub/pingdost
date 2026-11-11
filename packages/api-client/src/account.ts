import {
  AvatarUploadSignatureSchema,
  ClaimKeysResponseSchema,
  DeviceChallengeResponseSchema,
  DeviceOwnerResponseSchema,
  ListDevicesResponseSchema,
  MeResponseSchema,
  OneTimeKeyCountSchema,
  RegisterDeviceResponseSchema,
  UserKeysResponseSchema,
  UserLookupResponseSchema,
  UserSearchResponseSchema,
  type AvatarUploadSignature,
  type ClaimKeysResponse,
  type DeleteAccountRequest,
  type DeviceChallengeResponse,
  type DeviceOwnerResponse,
  type DeviceSummary,
  type MeResponse,
  type RegisterDeviceRequest,
  type RegisterDeviceResponse,
  type UpdateMeRequest,
  type UploadKeysRequest,
  type UserKeysResponse,
  type UserLookupResponse,
  type UserSearchResult,
} from '@pingdost/shared-types';

import type { ApiClient } from './client';

/** `/v1/me`, `/v1/users/*` (Phases 5–6). */
export interface AccountApi {
  me(): Promise<MeResponse>;
  updateMe(body: UpdateMeRequest): Promise<MeResponse>;
  lookupUsername(username: string): Promise<UserLookupResponse>;
  /** The profile behind a user ID (e.g. of someone who started a chat). */
  profile(userId: string): Promise<UserLookupResponse>;
  /**
   * People search (Phase 38): name and username prefixes from 2 characters, or a whole email.
   * At most 10 results with their circle state, never an email.
   */
  searchUsers(q: string, signal?: AbortSignal): Promise<UserSearchResult[]>;
  signAvatarUpload(): Promise<AvatarUploadSignature>;
  /** Emails a code that confirms deleting the account (ADR 0036). */
  sendDeletionCode(): Promise<void>;
  /** Deletes the account for good: every device is revoked and the account record removed. */
  deleteAccount(body: DeleteAccountRequest): Promise<void>;
}

export function accountApi(client: ApiClient): AccountApi {
  return {
    me: () => client.request({ method: 'GET', path: '/v1/me', response: MeResponseSchema }),
    updateMe: (body) =>
      client.request({ method: 'PATCH', path: '/v1/me', body, response: MeResponseSchema }),
    lookupUsername: (username) =>
      client.request({
        method: 'GET',
        path: `/v1/users/by-username/${encodeURIComponent(username)}`,
        response: UserLookupResponseSchema,
      }),
    searchUsers: async (q, signal) =>
      (
        await client.request({
          method: 'GET',
          path: '/v1/users/search',
          query: { q },
          response: UserSearchResponseSchema,
          ...(signal ? { signal } : {}),
        })
      ).results,
    profile: (userId) =>
      client.request({
        method: 'GET',
        path: `/v1/users/${encodeURIComponent(userId)}`,
        response: UserLookupResponseSchema,
      }),
    signAvatarUpload: () =>
      client.request({
        method: 'POST',
        path: '/v1/me/avatar/sign',
        response: AvatarUploadSignatureSchema,
      }),
    sendDeletionCode: () => client.request({ method: 'POST', path: '/v1/me/delete/code' }),
    deleteAccount: (body) => client.request({ method: 'POST', path: '/v1/me/delete', body }),
  };
}

/** `/v1/devices*` (Phase 6). */
export interface DevicesApi {
  challenge(): Promise<DeviceChallengeResponse>;
  /** Returns a device-bound token pair: store it before the next request. */
  register(body: RegisterDeviceRequest): Promise<RegisterDeviceResponse>;
  list(): Promise<DeviceSummary[]>;
  revoke(deviceId: string): Promise<void>;
}

export function devicesApi(client: ApiClient): DevicesApi {
  return {
    challenge: () =>
      client.request({
        method: 'POST',
        path: '/v1/devices/challenge',
        response: DeviceChallengeResponseSchema,
      }),
    register: (body) =>
      client.request({
        method: 'POST',
        path: '/v1/devices',
        body,
        response: RegisterDeviceResponseSchema,
      }),
    list: async () =>
      (
        await client.request({
          method: 'GET',
          path: '/v1/devices',
          response: ListDevicesResponseSchema,
        })
      ).devices,
    revoke: (deviceId) =>
      client.request({ method: 'DELETE', path: `/v1/devices/${encodeURIComponent(deviceId)}` }),
  };
}

/** `/v1/keys/*` (Phase 6). Verify certificates and key signatures before trusting them. */
export interface KeysApi {
  upload(body: UploadKeysRequest): Promise<number>;
  count(): Promise<number>;
  directory(userId: string): Promise<UserKeysResponse>;
  /** Which user owns an active device. */
  deviceOwner(deviceId: string): Promise<DeviceOwnerResponse>;
  claim(deviceIds: string[]): Promise<ClaimKeysResponse>;
}

export function keysApi(client: ApiClient): KeysApi {
  return {
    upload: async (body) =>
      (
        await client.request({
          method: 'POST',
          path: '/v1/keys/otks',
          body,
          response: OneTimeKeyCountSchema,
        })
      ).count,
    count: async () =>
      (
        await client.request({
          method: 'GET',
          path: '/v1/keys/otks/count',
          response: OneTimeKeyCountSchema,
        })
      ).count,
    directory: (userId) =>
      client.request({
        method: 'GET',
        path: `/v1/keys/users/${encodeURIComponent(userId)}`,
        response: UserKeysResponseSchema,
      }),
    deviceOwner: (deviceId) =>
      client.request({
        method: 'GET',
        path: `/v1/keys/devices/${encodeURIComponent(deviceId)}`,
        response: DeviceOwnerResponseSchema,
      }),
    claim: (deviceIds) =>
      client.request({
        method: 'POST',
        path: '/v1/keys/claim',
        body: { deviceIds },
        response: ClaimKeysResponseSchema,
      }),
  };
}
