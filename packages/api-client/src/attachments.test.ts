import { describe, expect, it, vi } from 'vitest';

import { attachmentsApi, rebaseSignedUrl } from './attachments';
import { createApiClient } from './client';

const ID = '01890a5d-ac96-774b-bcce-b302099a8057';
const SIGNED = `/v1/attachments/${ID}/parts/0?exp=1900000000000&sig=abc`;

describe('rebaseSignedUrl', () => {
  it("moves the API's own signed routes to the client's base URL", () => {
    expect(rebaseSignedUrl(`http://localhost:3000${SIGNED}`, 'http://192.168.1.5:3000')).toBe(
      `http://192.168.1.5:3000${SIGNED}`,
    );
    expect(rebaseSignedUrl(`https://api.pingdost.com${SIGNED}`, 'http://10.0.2.2:3000/')).toBe(
      `http://10.0.2.2:3000${SIGNED}`,
    );
  });

  it('keeps the same URL when the server already named the right address', () => {
    const url = `https://api.pingdost.com${SIGNED}`;
    expect(rebaseSignedUrl(url, 'https://api.pingdost.com')).toBe(url);
  });

  it('leaves object-store URLs and other paths alone', () => {
    const s3 = `https://bucket.r2.example/attachments/${ID}?X-Amz-Signature=x`;
    expect(rebaseSignedUrl(s3, 'http://192.168.1.5:3000')).toBe(s3);
    const other = 'http://localhost:3000/v1/keys/claim';
    expect(rebaseSignedUrl(other, 'http://192.168.1.5:3000')).toBe(other);
  });

  it('does nothing without a base URL', () => {
    const url = `http://localhost:3000${SIGNED}`;
    expect(rebaseSignedUrl(url, undefined)).toBe(url);
  });
});

describe('attachmentsApi', () => {
  const urls = { urlsExpireAt: 1_900_000_000_000, expiresAt: 1_900_000_000_000 };
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

  function api(body: unknown) {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(json(body)));
    return attachmentsApi(createApiClient({ baseUrl: 'http://192.168.1.5:3000/', fetch }));
  }

  it('hands out upload and download URLs on the address the client uses', async () => {
    const created = await api({
      attachmentId: ID,
      partSize: 1_048_576,
      partCount: 1,
      uploadUrls: [{ index: 0, url: `http://localhost:3000${SIGNED}` }],
      ...urls,
    }).create({
      attachmentId: ID,
      ciphertextBytes: 10,
      ciphertextSha256: 'AAAA',
      recipientDeviceIds: [ID],
    });
    expect(created.uploadUrls).toEqual([{ index: 0, url: `http://192.168.1.5:3000${SIGNED}` }]);

    const status = await api({
      attachmentId: ID,
      status: 'uploading',
      partSize: 1_048_576,
      partCount: 1,
      receivedParts: [],
      uploadUrls: [{ index: 0, url: `http://localhost:3000${SIGNED}` }],
      ...urls,
    }).status(ID);
    expect(status.uploadUrls[0]?.url).toBe(`http://192.168.1.5:3000${SIGNED}`);

    const blob = `/v1/attachments/${ID}/blob?device=${ID}&exp=1900000000000&sig=abc`;
    const link = await api({
      url: `http://localhost:3000${blob}`,
      expiresAt: 1_900_000_000_000,
      ciphertextBytes: 10,
    }).downloadUrl(ID);
    expect(link.url).toBe(`http://192.168.1.5:3000${blob}`);
  });
});
