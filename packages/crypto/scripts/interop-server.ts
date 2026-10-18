/**
 * Dev-only interop peer for the phone (Phase 3): a tiny HTTP server that plays the other
 * device with the WASM CryptoProvider. Run `pnpm --filter @pingdost/crypto interop-server`,
 * then `adb reverse tcp:8787 tcp:8787` so the phone reaches it at http://localhost:8787.
 *
 * Logs name steps and outcomes only: no keys, plaintext or ciphertext (ARCHITECTURE A10).
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';

import {
  describeError,
  fromBase64,
  fromWireOlm,
  INTEROP_TEXT,
  toBase64,
  toWireOlm,
  type InteropResponse,
  type MegolmRequest,
  type OlmReplyRequest,
  type OlmStartRequest,
} from '../src/conformance/index';
import { createWasmCryptoProvider } from '../src/index';
import type { CryptoProvider, OlmSession } from '../src/index';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_RUNS = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class RequestError extends Error {}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RequestError('body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** The request handler; exported so tests can run the whole flow in-process. */
export function createInteropServer(provider: CryptoProvider, log = console.log): Server {
  // One Node-side account and Olm session per phone run.
  const runs = new Map<string, OlmSession>();

  function requireSession(runId: unknown): OlmSession {
    const session = typeof runId === 'string' ? runs.get(runId) : undefined;
    if (!session) throw new RequestError('unknown runId');
    return session;
  }

  const routes: Record<string, (body: unknown) => object> = {
    '/v1/olm/start': (body) => {
      const { identityKey, oneTimeKey } = body as OlmStartRequest;
      const account = provider.createAccount();
      const session = account.createOutboundSession(identityKey, oneTimeKey);
      const runId = randomUUID();
      if (runs.size >= MAX_RUNS) runs.clear();
      runs.set(runId, session);
      return {
        runId,
        identityKey: account.identityKeys().curve25519,
        implementation: provider.implementation,
        message: toWireOlm(session.encrypt(encoder.encode(INTEROP_TEXT.olmFromNode))),
      };
    },
    '/v1/olm/reply': (body) => {
      const { runId, message } = body as OlmReplyRequest;
      const session = requireSession(runId);
      const plaintext = decoder.decode(session.decrypt(fromWireOlm(message)));
      if (plaintext !== INTEROP_TEXT.olmFromPhone) throw new RequestError('unexpected plaintext');
      return {
        message: toWireOlm(session.encrypt(encoder.encode(INTEROP_TEXT.olmRatchetFromNode))),
      };
    },
    '/v1/megolm': (body) => {
      const { runId, roomKey, groupMessage } = body as MegolmRequest;
      const session = requireSession(runId);
      const phoneKey = decoder.decode(session.decrypt(fromWireOlm(roomKey)));
      const inbound = provider.createInboundGroupSession(phoneKey);
      const result = inbound.decrypt(fromBase64(groupMessage));
      if (decoder.decode(result.plaintext) !== INTEROP_TEXT.megolmFromPhone) {
        throw new RequestError('unexpected plaintext');
      }
      const group = provider.createOutboundGroupSession();
      return {
        messageIndex: result.messageIndex,
        roomKey: toWireOlm(session.encrypt(encoder.encode(group.sessionKey()))),
        groupMessage: toBase64(group.encrypt(encoder.encode(INTEROP_TEXT.megolmFromNode))),
      };
    },
  };

  return createServer((request, response) => {
    const url = request.url ?? '';
    const route = request.method === 'POST' && Object.hasOwn(routes, url) ? routes[url] : undefined;
    const send = (status: number, payload: InteropResponse<object>) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    if (!route) {
      send(404, { ok: false, error: 'not found' });
      return;
    }
    readJson(request)
      .then((body) => {
        const result = route(body);
        log(`[interop] ${request.url} ok`);
        send(200, { ok: true, ...result });
      })
      .catch((error: unknown) => {
        const detail = error instanceof RequestError ? error.message : describeError(error);
        log(`[interop] ${request.url} failed: ${detail}`);
        send(error instanceof RequestError ? 400 : 500, { ok: false, error: detail });
      });
  });
}

async function main() {
  const host = process.env.INTEROP_HOST ?? '127.0.0.1';
  const port = Number(process.env.INTEROP_PORT ?? 8787);
  const provider = await createWasmCryptoProvider();
  createInteropServer(provider).listen(port, host, () => {
    console.log(`[interop] ${provider.implementation} listening on http://${host}:${port}`);
    console.log(`[interop] phone over USB: adb reverse tcp:${port} tcp:${port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
