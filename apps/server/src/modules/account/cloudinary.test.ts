// The avatar's deletion at Cloudinary when an account is deleted (ADR 0036): the documented
// destroy call (checked 2026-11-09 at cloudinary.com/documentation/
// image_upload_api_reference_destroy_by_public_id), signed like uploads.
import { describe, expect, it } from 'vitest';

import { cloudinarySignature, destroyAvatar } from './cloudinary';

const settings = { cloudName: 'demo', apiKey: 'key-1', apiSecret: 'secret-1' };
const USER = '01920000-0000-7000-8000-0000000000a1';

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    calls.push({ url: input instanceof Request ? input.url : input.toString(), init });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { calls, fetchFn };
}

describe('destroyAvatar', () => {
  it('posts a signed destroy for avatars/<userId>', async () => {
    const { calls, fetchFn } = fakeFetch(200, { result: 'ok' });
    await destroyAvatar(settings, USER, 1_794_200_000_000, fetchFn);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.cloudinary.com/v1_1/demo/image/destroy');
    expect(calls[0]!.init?.method).toBe('POST');
    const fields = Object.fromEntries(calls[0]!.init?.body as URLSearchParams);
    const signed = { invalidate: 'true', public_id: `avatars/${USER}`, timestamp: '1794200000' };
    expect(fields).toEqual({
      ...signed,
      api_key: 'key-1',
      signature: cloudinarySignature(signed, 'secret-1'),
    });
  });

  it('fails when Cloudinary refuses or does not delete it', async () => {
    await expect(
      destroyAvatar(settings, USER, 0, fakeFetch(401, { error: { message: 'x' } }).fetchFn),
    ).rejects.toThrow('401');
    await expect(
      destroyAvatar(settings, USER, 0, fakeFetch(200, { result: 'not found' }).fetchFn),
    ).rejects.toThrow('not found');
  });
});
