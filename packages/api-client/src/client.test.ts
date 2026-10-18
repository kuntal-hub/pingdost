import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { problemType } from '@pingdost/shared-types';

import { createApiClient, type ApiClientOptions } from './client';
import { ApiError } from './errors';

const BASE = 'https://api.example.test/';

function json(status: number, body: unknown, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } });
}

function problem(status: number, code: string): Response {
  return json(
    status,
    { type: problemType('INTERNAL'), title: code, status, code },
    'application/problem+json',
  );
}

function client(responses: (Response | Error)[], options: Partial<ApiClientOptions> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(() => {
    const next = responses.shift();
    if (next === undefined) throw new Error('no more responses');
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  return {
    fetch,
    api: createApiClient({ baseUrl: BASE, fetch, retryDelayMs: () => 0, ...options }),
  };
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe('createApiClient', () => {
  it('calls /healthz without a token and validates the body', async () => {
    const { api, fetch } = client([json(200, { status: 'ok' })], {
      getAccessToken: () => 'secret',
    });
    await expect(api.health()).resolves.toEqual({ status: 'ok' });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://api.example.test/healthz');
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
  });

  it('sends the bearer token, JSON body and query, and handles 204', async () => {
    const { api, fetch } = client([new Response(null, { status: 204 })], {
      getAccessToken: () => Promise.resolve('token-1'),
    });
    await api.request({
      method: 'POST',
      path: '/v1/things',
      query: { a: 1, b: undefined },
      body: { x: 1 },
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://api.example.test/v1/things?a=1');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer token-1');
    expect(headers.get('content-type')).toBe('application/json');
    expect(init?.body).toBe('{"x":1}');
  });

  it('maps problem+json to ApiError with its code', async () => {
    const { api } = client([problem(409, 'USERNAME_TAKEN')]);
    const error = await rejection(
      api.request({ method: 'POST', path: '/v1/auth/register', body: {} }),
    );
    expect(error).toMatchObject({ kind: 'http', status: 409, code: 'USERNAME_TAKEN' });
    expect(error.problem?.title).toBe('USERNAME_TAKEN');
    expect(error.message).toBe('POST /v1/auth/register failed: 409 USERNAME_TAKEN');
  });

  it('falls back to a generic code for non-problem errors and unknown codes', async () => {
    const { api } = client([new Response('nope', { status: 403 }), problem(400, 'SOMETHING_NEW')]);
    expect(await rejection(api.request({ method: 'POST', path: '/x' }))).toMatchObject({
      code: 'FORBIDDEN',
      problem: undefined,
    });
    expect(await rejection(api.request({ method: 'POST', path: '/x' }))).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('rejects a 2xx body that does not match the schema', async () => {
    const { api } = client([json(200, { status: 'broken' })]);
    expect(await rejection(api.health())).toMatchObject({ kind: 'invalid_response' });
  });

  it('retries GETs on network errors and 503, up to the limit', async () => {
    const { api, fetch } = client([
      new TypeError('offline'),
      problem(503, 'UNAVAILABLE'),
      json(200, { status: 'ok' }),
    ]);
    await expect(api.health()).resolves.toEqual({ status: 'ok' });
    expect(fetch).toHaveBeenCalledTimes(3);

    const failing = client([problem(503, 'UNAVAILABLE'), problem(503, 'UNAVAILABLE')], {
      retries: 1,
    });
    expect(await rejection(failing.api.health())).toMatchObject({
      status: 503,
      code: 'UNAVAILABLE',
    });
    expect(failing.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-GET requests or client errors', async () => {
    const post = client([problem(503, 'UNAVAILABLE')]);
    await rejection(post.api.request({ method: 'POST', path: '/x' }));
    expect(post.fetch).toHaveBeenCalledTimes(1);

    const notFound = client([problem(404, 'NOT_FOUND')]);
    await rejection(notFound.api.request({ method: 'GET', path: '/x' }));
    expect(notFound.fetch).toHaveBeenCalledTimes(1);
  });

  it('refreshes once on TOKEN_EXPIRED and resends with the new token', async () => {
    let token = 'old';
    const onRefresh = vi.fn(() => {
      token = 'new';
      return Promise.resolve(true);
    });
    const { api, fetch } = client([problem(401, 'TOKEN_EXPIRED'), json(200, { id: 1 })], {
      getAccessToken: () => token,
      onRefresh,
    });
    await expect(
      api.request({ method: 'POST', path: '/v1/x', response: z.object({ id: z.number() }) }),
    ).resolves.toEqual({ id: 1 });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('authorization')).toBe('Bearer new');
  });

  it('gives up when the refresh fails or the token expires again', async () => {
    const failed = client([problem(401, 'TOKEN_EXPIRED')], {
      onRefresh: () => Promise.resolve(false),
    });
    expect(await rejection(failed.api.request({ method: 'GET', path: '/x' }))).toMatchObject({
      code: 'TOKEN_EXPIRED',
    });

    const again = client([problem(401, 'TOKEN_EXPIRED'), problem(401, 'TOKEN_EXPIRED')], {
      onRefresh: () => Promise.resolve(true),
    });
    await rejection(again.api.request({ method: 'GET', path: '/x' }));
    expect(again.fetch).toHaveBeenCalledTimes(2);
  });

  it('shares one refresh between concurrent requests', async () => {
    let release: (value: boolean) => void = () => undefined;
    const onRefresh = vi.fn(() => new Promise<boolean>((resolve) => (release = resolve)));
    const { api } = client(
      [
        problem(401, 'TOKEN_EXPIRED'),
        problem(401, 'TOKEN_EXPIRED'),
        new Response(null, { status: 204 }),
        new Response(null, { status: 204 }),
      ],
      { onRefresh },
    );
    const both = Promise.all([
      api.request({ method: 'GET', path: '/a' }),
      api.request({ method: 'GET', path: '/b' }),
    ]);
    await vi.waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    release(true);
    await both;
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('times out a request that gets no response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const api = createApiClient({
      baseUrl: BASE,
      fetch,
      timeoutMs: 20,
      retries: 1,
      retryDelayMs: () => 0,
    });
    expect(await rejection(api.health())).toMatchObject({ kind: 'timeout', code: 'UNAVAILABLE' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops without retrying when the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const { api, fetch } = client([new DOMException('aborted', 'AbortError')]);
    expect(await rejection(api.health(controller.signal))).toMatchObject({ kind: 'aborted' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
