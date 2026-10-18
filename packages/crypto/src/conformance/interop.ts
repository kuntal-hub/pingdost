/**
 * Phone ↔ Node interop proof (Phase 3, closes the REQ §7.1 gate). The phone runs
 * `runInteropClient` with the native provider against `scripts/interop-server.ts`, which uses
 * the WASM provider. Bytes travel as base64 in JSON over plain HTTP: dev-only, test data only.
 */
import type { CryptoProvider, OlmAccount, OlmCiphertext, OlmSession } from '../types';
import { fromBase64, toBase64 } from './base64';
import { checkEqual, describeError, type StepResult } from './check';
import { bytes, text } from './scenarios';

/** The fixed messages each side expects to decrypt. */
export const INTEROP_TEXT = {
  olmFromNode: 'olm: node -> phone',
  olmFromPhone: 'olm: phone -> node',
  olmRatchetFromNode: 'olm ratchet: node -> phone',
  megolmFromPhone: 'megolm: phone -> node',
  megolmFromNode: 'megolm: node -> phone',
} as const;

export interface WireOlmMessage {
  type: OlmCiphertext['type'];
  body: string;
}

export const toWireOlm = (message: OlmCiphertext): WireOlmMessage => ({
  type: message.type,
  body: toBase64(message.body),
});

export const fromWireOlm = (message: WireOlmMessage): OlmCiphertext => ({
  type: message.type,
  body: fromBase64(message.body),
});

/** `POST /v1/olm/start` */
export interface OlmStartRequest {
  identityKey: string;
  oneTimeKey: string;
}
export interface OlmStartResponse {
  runId: string;
  identityKey: string;
  implementation: string;
  message: WireOlmMessage;
}

/** `POST /v1/olm/reply` */
export interface OlmReplyRequest {
  runId: string;
  message: WireOlmMessage;
}
/** `POST /v1/megolm` */
export interface MegolmRequest {
  runId: string;
  /** The phone's Megolm session key, sent over Olm. */
  roomKey: WireOlmMessage;
  groupMessage: string;
}

/** Every response carries `ok`; on success the step's fields follow. */
export type InteropResponse<T> = ({ ok: true } & T) | { ok: false; error: string };
export type OlmReplyResponse = InteropResponse<{ message: WireOlmMessage }>;
export type MegolmResponse = InteropResponse<{
  messageIndex: number;
  roomKey: WireOlmMessage;
  groupMessage: string;
}>;

export type FetchLike = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface InteropClientOptions {
  provider: CryptoProvider;
  /** The phone's persisted device account. */
  account: OlmAccount;
  /** Called after the account changes (one-time key published or used) so it can be re-saved. */
  persistAccount: () => Promise<void>;
  baseUrl: string;
  fetch: FetchLike;
  onStep: (step: StepResult) => void;
}

export const INTEROP_STEPS = [
  { id: 'olm-start', title: 'Phone sends identity key + one-time key; Node opens an Olm session' },
  { id: 'olm-inbound', title: "Phone decrypts Node's pre-key message" },
  { id: 'olm-reply', title: 'Phone replies over Olm; Node decrypts it' },
  { id: 'olm-ratchet', title: "Phone decrypts Node's ratchet (normal) message" },
  { id: 'megolm-to-node', title: 'Megolm phone → Node: room key over Olm, then a group message' },
  { id: 'megolm-to-phone', title: 'Megolm Node → phone: room key over Olm, then a group message' },
] as const;

type StepId = (typeof INTEROP_STEPS)[number]['id'];

/** Runs every interop step in order, stopping at the first failure. Returns true if all pass. */
export async function runInteropClient(options: InteropClientOptions): Promise<boolean> {
  const { provider, account, baseUrl, onStep } = options;

  async function post<T>(path: string, body: unknown): Promise<T> {
    const response = await options.fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${path}`);
    const result = (await response.json()) as InteropResponse<object>;
    if (!result.ok) throw new Error(`Node side failed: ${result.error}`);
    return result as T;
  }

  async function step(id: StepId, run: () => Promise<void> | void): Promise<boolean> {
    const title = INTEROP_STEPS.find((s) => s.id === id)?.title ?? id;
    try {
      await run();
      onStep({ id, title, ok: true });
      return true;
    } catch (error) {
      onStep({ id, title, ok: false, detail: describeError(error) });
      return false;
    }
  }

  let start: OlmStartResponse | undefined;
  let session: OlmSession | undefined;
  let ratchetMessage: WireOlmMessage | undefined;
  let megolmReply: Extract<MegolmResponse, { ok: true }> | undefined;
  const requireSession = () => {
    if (!session) throw new Error('no Olm session');
    return session;
  };

  const steps: [StepId, () => Promise<void> | void][] = [
    [
      'olm-start',
      async () => {
        account.generateOneTimeKeys(1);
        const [oneTimeKey] = account.oneTimeKeys();
        if (!oneTimeKey) throw new Error('no one-time key generated');
        account.markKeysAsPublished();
        await options.persistAccount();
        start = await post<OlmStartResponse>('/v1/olm/start', {
          identityKey: account.identityKeys().curve25519,
          oneTimeKey: oneTimeKey.publicKey,
        } satisfies OlmStartRequest);
        checkEqual(start.message.type, 'prekey', 'Node sent a pre-key message');
      },
    ],
    [
      'olm-inbound',
      async () => {
        if (!start) throw new Error('no start response');
        const inbound = account.createInboundSession(start.identityKey, fromWireOlm(start.message));
        await options.persistAccount(); // the one-time key is now used up
        session = inbound.session;
        checkEqual(text(inbound.plaintext), INTEROP_TEXT.olmFromNode, 'Olm plaintext from Node');
      },
    ],
    [
      'olm-reply',
      async () => {
        if (!start) throw new Error('no start response');
        const reply = requireSession().encrypt(bytes(INTEROP_TEXT.olmFromPhone));
        checkEqual(reply.type, 'normal', 'reply is a normal message');
        const result = await post<Extract<OlmReplyResponse, { ok: true }>>('/v1/olm/reply', {
          runId: start.runId,
          message: toWireOlm(reply),
        });
        ratchetMessage = result.message;
      },
    ],
    [
      'olm-ratchet',
      () => {
        if (!ratchetMessage) throw new Error('no ratchet message');
        checkEqual(ratchetMessage.type, 'normal', 'Node sent a normal message');
        const plaintext = requireSession().decrypt(fromWireOlm(ratchetMessage));
        checkEqual(text(plaintext), INTEROP_TEXT.olmRatchetFromNode, 'ratchet plaintext');
      },
    ],
    [
      'megolm-to-node',
      async () => {
        if (!start) throw new Error('no start response');
        const group = provider.createOutboundGroupSession();
        const roomKey = requireSession().encrypt(bytes(group.sessionKey()));
        const groupMessage = group.encrypt(bytes(INTEROP_TEXT.megolmFromPhone));
        megolmReply = await post<Extract<MegolmResponse, { ok: true }>>('/v1/megolm', {
          runId: start.runId,
          roomKey: toWireOlm(roomKey),
          groupMessage: toBase64(groupMessage),
        } satisfies MegolmRequest);
        checkEqual(megolmReply.messageIndex, 0, 'Node decrypted message index 0');
      },
    ],
    [
      'megolm-to-phone',
      () => {
        if (!megolmReply) throw new Error('no Megolm reply');
        const sessionKey = text(requireSession().decrypt(fromWireOlm(megolmReply.roomKey)));
        const inbound = provider.createInboundGroupSession(sessionKey);
        const result = inbound.decrypt(fromBase64(megolmReply.groupMessage));
        checkEqual(text(result.plaintext), INTEROP_TEXT.megolmFromNode, 'Megolm plaintext');
      },
    ],
  ];

  for (const [id, run] of steps) {
    if (!(await step(id, run))) return false;
  }
  return true;
}
