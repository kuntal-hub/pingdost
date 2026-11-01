// @pingdost/api-client: typed REST client (fetch) used by the web and mobile apps.
// Endpoint functions are written by hand from @pingdost/shared-types.
export { accountApi, devicesApi, keysApi } from './account';
export type { AccountApi, DevicesApi, KeysApi } from './account';
export { attachmentsApi } from './attachments';
export type { AttachmentsApi } from './attachments';
export { authApi } from './auth';
export type { AuthApi } from './auth';
export { callsApi } from './calls';
export type { CallsApi } from './calls';
export { createApiClient } from './client';
export type { ApiClient, ApiClientOptions, HttpMethod, RequestOptions } from './client';
export { ApiError } from './errors';
export type { ApiErrorKind } from './errors';
export { groupsApi } from './groups';
export type { GroupsApi } from './groups';
export { pairingApi } from './pairing';
export type { PairingApi } from './pairing';
export { pushApi } from './push';
export { recoveryApi } from './recovery';
export type { RecoveryApi } from './recovery';
export type { PushApi } from './push';
export { securityApi } from './security';
export type { SecurityApi } from './security';
