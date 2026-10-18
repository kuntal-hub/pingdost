import type { ZodType } from 'zod';

import {
  errorCodeForStatus,
  HEALTH_PATH,
  HealthResponseSchema,
  ProblemSchema,
  type HealthResponse,
} from '@pingdost/shared-types';

import { ApiError } from './errors';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiClientOptions {
  /** e.g. `https://api.pingdost.com`; paths are appended to it. */
  baseUrl: string;
  /** The current access token, or undefined when signed out. */
  getAccessToken?: () => string | undefined | Promise<string | undefined>;
  /**
   * Called after a 401 `TOKEN_EXPIRED`. Resolves true once new tokens are stored, and the
   * request is then retried once. Concurrent requests share one refresh.
   */
  onRefresh?: () => Promise<boolean>;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Per attempt; default 15 s. */
  timeoutMs?: number;
  /** Extra attempts for GETs after a network error, timeout or 502/503/504; default 2. */
  retries?: number;
  /** Delay before retry `attempt` (1-based); default exponential from 300 ms with jitter. */
  retryDelayMs?: (attempt: number) => number;
}

export interface RequestOptions<T> {
  method: HttpMethod;
  /** Starts with `/`. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  /** Sent as JSON. */
  body?: unknown;
  /** Validates a 2xx JSON body; omit for 204 responses. */
  response?: ZodType<T>;
  /** Send the access token; default true. */
  auth?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ApiClient {
  request<T = void>(options: RequestOptions<T>): Promise<T>;
  /** `GET /healthz`. */
  health(signal?: AbortSignal): Promise<HealthResponse>;
}

const RETRY_STATUSES = new Set([502, 503, 504]);

function defaultRetryDelay(attempt: number): number {
  const base = 300 * 2 ** (attempt - 1);
  return base + Math.random() * base * 0.5;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function buildUrl(baseUrl: string, path: string, query: RequestOptions<unknown>['query']): string {
  const url = `${baseUrl.replace(/\/+$/, '')}${path}`;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.append(key, String(value));
  }
  const search = params.toString();
  return search ? `${url}?${search}` : url;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const retries = options.retries ?? 2;
  const retryDelay = options.retryDelayMs ?? defaultRetryDelay;
  let refreshing: Promise<boolean> | undefined;

  function refreshOnce(): Promise<boolean> {
    if (!options.onRefresh) return Promise.resolve(false);
    refreshing ??= options.onRefresh().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }

  /** One HTTP exchange with its own timeout. */
  async function attempt<T>(request: RequestOptions<T>): Promise<Response> {
    const label = `${request.method} ${request.path}`;
    const headers: Record<string, string> = {
      accept: 'application/json, application/problem+json',
    };
    if (request.body !== undefined) headers['content-type'] = 'application/json';
    if (request.auth !== false) {
      const token = await options.getAccessToken?.();
      if (token) headers.authorization = `Bearer ${token}`;
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      request.timeoutMs ?? options.timeoutMs ?? 15_000,
    );
    const onAbort = () => controller.abort();
    request.signal?.addEventListener('abort', onAbort, { once: true });
    if (request.signal?.aborted) controller.abort();

    try {
      return await fetchFn(buildUrl(options.baseUrl, request.path, request.query), {
        method: request.method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: controller.signal,
      });
    } catch {
      if (request.signal?.aborted) {
        throw new ApiError('aborted', `${label} aborted`, { code: 'UNAVAILABLE' });
      }
      if (timedOut) throw new ApiError('timeout', `${label} timed out`, { code: 'UNAVAILABLE' });
      throw new ApiError('network', `${label} failed: no response`, { code: 'UNAVAILABLE' });
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    }
  }

  async function errorFrom(label: string, response: Response): Promise<ApiError> {
    const parsed = ProblemSchema.safeParse(await readJson(response));
    const problem = parsed.success ? parsed.data : undefined;
    const code = problem?.code ?? errorCodeForStatus(response.status);
    return new ApiError('http', `${label} failed: ${response.status} ${code}`, {
      status: response.status,
      code,
      problem,
    });
  }

  async function request<T = void>(request: RequestOptions<T>): Promise<T> {
    const label = `${request.method} ${request.path}`;
    // Only GETs are idempotent enough to retry blindly.
    const maxRetries = request.method === 'GET' ? retries : 0;
    let retried = 0;
    let refreshed = false;

    for (;;) {
      let response: Response;
      try {
        response = await attempt(request);
      } catch (error) {
        const transient =
          error instanceof ApiError && (error.kind === 'network' || error.kind === 'timeout');
        if (!transient || retried >= maxRetries) throw error;
        retried++;
        await sleep(retryDelay(retried), request.signal);
        continue;
      }

      if (response.ok) {
        if (!request.response) return undefined as T;
        const parsed = request.response.safeParse(await readJson(response));
        if (!parsed.success) {
          throw new ApiError('invalid_response', `${label} returned an unexpected body`, {
            status: response.status,
            code: 'INTERNAL',
          });
        }
        return parsed.data;
      }

      const error = await errorFrom(label, response);
      // The server rejected the token before doing anything, so any method may be resent.
      if (error.code === 'TOKEN_EXPIRED' && request.auth !== false && !refreshed) {
        refreshed = true;
        if (await refreshOnce()) continue;
      }
      if (RETRY_STATUSES.has(response.status) && retried < maxRetries) {
        retried++;
        await sleep(retryDelay(retried), request.signal);
        continue;
      }
      throw error;
    }
  }

  return {
    request,
    health: (signal) =>
      request({
        method: 'GET',
        path: HEALTH_PATH,
        auth: false,
        response: HealthResponseSchema,
        signal,
      }),
  };
}
