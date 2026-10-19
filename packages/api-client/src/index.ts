// @pingdost/api-client: typed REST client (fetch) used by the web and mobile apps.
// Endpoint functions are written by hand from @pingdost/shared-types.
export { authApi } from './auth';
export type { AuthApi } from './auth';
export { createApiClient } from './client';
export type { ApiClient, ApiClientOptions, HttpMethod, RequestOptions } from './client';
export { ApiError } from './errors';
export type { ApiErrorKind } from './errors';
