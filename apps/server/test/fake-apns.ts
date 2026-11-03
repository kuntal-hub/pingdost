/**
 * A fake APNs gateway (ADR 0032): a cleartext HTTP/2 server on 127.0.0.1 that records every
 * request exactly as `ApnsSender` sent it and answers like Apple (200, or a status with a
 * `{"reason"}` body). Used by the push unit tests and `push.int.test.ts`.
 */
import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Http2Server, type IncomingHttpHeaders } from 'node:http2';
import type { AddressInfo } from 'node:net';

export interface ApnsCall {
  /** `production` or `sandbox`: which of the two fake origins received it. */
  gateway: 'production' | 'sandbox';
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export type ApnsReply = { status: number; reason?: string };

export interface FakeApns {
  calls: ApnsCall[];
  origins: { production: string; sandbox: string };
  /** Decides the reply per request (default 200). */
  reply: (call: ApnsCall) => ApnsReply;
  close(): Promise<void>;
}

/** A P-256 key like Apple's `.p8` (PKCS#8 PEM) and its public half. */
export function apnsKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

function listen(server: Http2Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

export async function startFakeApns(): Promise<FakeApns> {
  const fake: Partial<FakeApns> & { calls: ApnsCall[] } = {
    calls: [],
    reply: () => ({ status: 200 }),
  };
  const servers = (['production', 'sandbox'] as const).map((gateway) => {
    const server = createServer();
    server.on('stream', (stream, headers) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        const call: ApnsCall = {
          gateway,
          path: String(headers[':path']),
          headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        fake.calls.push(call);
        const { status, reason } = fake.reply ? fake.reply(call) : ({ status: 200 } as ApnsReply);
        stream.respond({ ':status': status, 'apns-id': '00000000-0000-0000-0000-000000000001' });
        stream.end(reason === undefined ? undefined : JSON.stringify({ reason }));
      });
    });
    return server;
  });
  const [production, sandbox] = await Promise.all(servers.map(listen));
  fake.origins = { production: production ?? '', sandbox: sandbox ?? '' };
  fake.close = async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  };
  return fake as FakeApns;
}
