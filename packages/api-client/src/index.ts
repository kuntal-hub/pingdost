// @pingdost/api-client: typed REST client (fetch) used by the web and mobile apps.
// Endpoint functions are written by hand from @pingdost/shared-types.
export { accountApi, devicesApi, keysApi } from './account';
export type { AccountApi, DevicesApi, KeysApi } from './account';
export { authApi } from './auth';
export type { AuthApi } from './auth';
export { createApiClient } from './client';
export type { ApiClient, ApiClientOptions, HttpMethod, RequestOptions } from './client';
export { ApiError } from './errors';
export type { ApiErrorKind } from './errors';
export { groupsApi } from './groups';
export type { GroupsApi } from './groups';
export { pushApi } from './push';
export type { PushApi } from './push';
export { securityApi } from './security';
export type { SecurityApi } from './security';
