# @pingdost/api-client

Typed REST client (fetch) for the web and mobile apps.

`createApiClient({ baseUrl, getAccessToken, onRefresh })` provides:

- `request()`: JSON bodies, Zod-validated responses, and problem+json errors mapped to `ApiError` (`kind`, `status`, `code`, `problem`);
- per-attempt timeouts (AbortController);
- up to 2 retries for GETs after network errors, timeouts or 502/503/504;
- one shared token refresh after `TOKEN_EXPIRED`.

Endpoint functions are written by hand from `@pingdost/shared-types`. Only `health()` exists so far.
