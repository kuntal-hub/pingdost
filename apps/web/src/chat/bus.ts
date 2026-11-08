// The tabs of one browser talk over a BroadcastChannel (ADR 0020). The leader tab answers
// calls and announces everything that changes; followers ask and listen. Messages are
// structured-cloned, so only plain data crosses (errors as `WireError`).
import type { TransferStatus } from '@/attachments/transfers';
import type { ConversationEvent, EngineEvent, HistorySyncStatus } from '@pingdost/message-engine';
import type { IncomingCallSignal } from '@pingdost/protocol';
import type { PrivacyPrefs } from '@pingdost/shared-types';
import type { TransportStatus } from '@pingdost/transport';

import {
  ENGINE_METHODS,
  LEADER_METHODS,
  RemoteError,
  type ChatClient,
  type ChatEvents,
  type ClientMethod,
  type WireError,
} from './client';

export const CHANNEL = 'pingdost-chat';

export type BusMessage =
  | { type: 'hello'; tab: string }
  | { type: 'leader'; tab: string }
  | {
      type: 'call';
      id: string;
      from: string;
      method: ClientMethod;
      args: unknown[];
    }
  | { type: 'result'; id: string; to: string; ok: true; value: unknown }
  | { type: 'result'; id: string; to: string; ok: false; error: WireError }
  | { type: 'conversation'; conversationId: string; event: ConversationEvent }
  | { type: 'list' }
  | { type: 'engine'; event: EngineEvent }
  | { type: 'status'; status: TransportStatus }
  | { type: 'presence'; userId: string; online: boolean }
  | { type: 'prefs'; privacy: PrivacyPrefs | null; blocked: string[] }
  /** The history sync from the phone (ADR 0021). */
  | { type: 'sync'; status: HistorySyncStatus }
  /** An attachment download or upload in the leader tab. */
  | { type: 'transfer'; status: TransferStatus }
  /** A call signal for this device (ADR 0028): every tab runs its own call manager. */
  | { type: 'call_signal'; signal: IncomingCallSignal }
  /** A follower changed privacy settings or blocks: the leader reloads them. */
  | { type: 'prefs_changed' }
  | { type: 'signed_out'; notice?: string };

/** A call that waits longer than this failed (the leader is gone or busy). */
const CALL_TIMEOUT_MS = 30_000;

/**
 * The leader tab's answer to another tab's `hello`: who the leader is. A tab opened after the
 * leader started missed its first announcement, and makes no call until it knows.
 */
export function leaderGreeting(message: BusMessage, tab: string): BusMessage | undefined {
  return message.type === 'hello' ? { type: 'leader', tab } : undefined;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** A follower's client: every method is a call to the leader tab. */
export class RemoteChat {
  readonly client: ChatClient;
  #leader: string | undefined;
  #ready: Promise<void>;
  #markReady!: () => void;
  readonly #pending = new Map<string, Pending>();
  readonly #conversation = new Map<string, Set<(event: ConversationEvent) => void>>();
  readonly #list = new Set<() => void>();
  readonly #engine = new Set<(event: EngineEvent) => void>();
  readonly #sync = new Set<(status: HistorySyncStatus) => void>();
  readonly #transfer = new Set<(status: TransferStatus) => void>();
  readonly #callSignal = new Set<(signal: IncomingCallSignal) => void>();

  constructor(
    private readonly channel: BroadcastChannel,
    private readonly tab: string,
  ) {
    this.#ready = new Promise((resolve) => (this.#markReady = resolve));
    const call =
      (method: ClientMethod) =>
      (...args: unknown[]) =>
        this.#call(method, args);
    const methods = Object.fromEntries(
      [...ENGINE_METHODS, ...LEADER_METHODS].map((name) => [name, call(name)]),
    );
    const events: ChatEvents = {
      subscribe: (conversationId, listener) => {
        let set = this.#conversation.get(conversationId);
        if (!set) this.#conversation.set(conversationId, (set = new Set()));
        set.add(listener);
        return () => {
          set.delete(listener);
        };
      },
      onListChanged: (listener) => {
        this.#list.add(listener);
        return () => {
          this.#list.delete(listener);
        };
      },
      onEngineEvent: (listener) => {
        this.#engine.add(listener);
        return () => {
          this.#engine.delete(listener);
        };
      },
      onHistorySync: (listener) => {
        this.#sync.add(listener);
        return () => {
          this.#sync.delete(listener);
        };
      },
      onTransfer: (listener) => {
        this.#transfer.add(listener);
        return () => {
          this.#transfer.delete(listener);
        };
      },
      onCallSignal: (listener) => {
        this.#callSignal.add(listener);
        return () => {
          this.#callSignal.delete(listener);
        };
      },
    };
    // The methods are built from their names, so the compiler cannot check them here.
    this.client = { ...methods, ...events } as unknown as ChatClient;
    channel.postMessage({ type: 'hello', tab } satisfies BusMessage);
  }

  async #call(method: ClientMethod, args: unknown[]): Promise<unknown> {
    await this.#ready;
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new RemoteError({ name: 'Timeout', message: 'PingDost did not answer. Try again.' }),
        );
      }, CALL_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      this.channel.postMessage({
        type: 'call',
        id,
        from: this.tab,
        method,
        args,
      } satisfies BusMessage);
    });
  }

  /** Handles what the leader sends. */
  handle(message: BusMessage): void {
    switch (message.type) {
      case 'leader':
        if (this.#leader !== undefined && this.#leader !== message.tab) {
          // The old leader went away: its answers will not come.
          for (const [id, pending] of this.#pending) {
            clearTimeout(pending.timer);
            pending.reject(
              new RemoteError({
                name: 'Moved',
                message: 'PingDost moved to another tab. Try again.',
              }),
            );
            this.#pending.delete(id);
          }
        }
        this.#leader = message.tab;
        this.#markReady();
        for (const listener of this.#list) listener();
        break;
      case 'result': {
        if (message.to !== this.tab) return;
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(new RemoteError(message.error));
        break;
      }
      case 'conversation':
        for (const listener of this.#conversation.get(message.conversationId) ?? [])
          listener(message.event);
        break;
      case 'list':
        for (const listener of this.#list) listener();
        break;
      case 'engine':
        for (const listener of this.#engine) listener(message.event);
        break;
      case 'sync':
        for (const listener of this.#sync) listener(message.status);
        break;
      case 'transfer':
        for (const listener of this.#transfer) listener(message.status);
        break;
      case 'call_signal':
        for (const listener of this.#callSignal) listener(message.signal);
        break;
      default:
        break;
    }
  }

  dispose(): void {
    for (const pending of this.#pending.values()) clearTimeout(pending.timer);
    this.#pending.clear();
  }
}
