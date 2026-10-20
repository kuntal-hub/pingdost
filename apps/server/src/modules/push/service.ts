/**
 * Wake scheduling (ADR 0015). The gateway calls `wake` after each offline store; this keeps it
 * to at most one push per device per throttle window:
 * - the first wake goes out at once;
 * - later ones inside the window collapse into one wake at its end, skipped if the device has
 *   connected by then. So a message stored just after a wake is never left without one.
 * Urgent wakes skip the window. Transient provider failures are retried a bounded number of
 * times; an address the provider rejects is deleted.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import type { Logger } from 'pino';

import { PUSH_WAKE, type PushPayload, type PushProvider } from '@pingdost/shared-types';

import type { PushNotifier, PushSender } from './notifier';
import type { PushTokens } from './repo';
import type { Clock } from '../../infra/clock';
import type { Metrics } from '../../infra/metrics';

export interface PushServiceOptions {
  tokens: Pick<PushTokens, 'get' | 'deleteInvalid'>;
  /** Configured providers; a device whose provider is missing is not woken. */
  senders: Partial<Record<PushProvider, PushSender>>;
  throttleMs: number;
  clock: Clock;
  metrics: Metrics;
  log: Logger;
  /** Whether the device has a live socket (it then needs no deferred wake). */
  isConnected: (deviceId: string) => boolean;
  maxRetries?: number;
  /** First retry delay; it doubles per attempt (tests shorten it). */
  retryBaseMs?: number;
}

export type WakeResult =
  | 'sent'
  | 'throttled'
  | 'skipped_connected'
  | 'no_token'
  | 'unconfigured'
  | 'invalid_token'
  | 'failed';

interface DeviceState {
  lastAt: number;
  deferred?: NodeJS.Timeout;
}

/** Device states kept before stale ones are pruned. */
const PRUNE_AT = 10_000;
const MAX_BACKOFF_MS = 30_000;

export class PushService implements PushNotifier {
  readonly #devices = new Map<string, DeviceState>();
  readonly #inflight = new Set<Promise<void>>();
  readonly #abort = new AbortController();

  constructor(private readonly o: PushServiceOptions) {}

  wake(deviceId: string, urgent: boolean): void {
    if (this.#abort.signal.aborted) return;
    const now = this.o.clock.now();
    const state = this.#devices.get(deviceId);
    if (urgent || !state || now - state.lastAt >= this.o.throttleMs) {
      if (state?.deferred) clearTimeout(state.deferred);
      this.#devices.set(deviceId, { lastAt: now });
      this.#prune(now);
      this.#track(this.#deliver(deviceId, PUSH_WAKE));
      return;
    }
    this.#count('throttled');
    if (state.deferred) return;
    state.deferred = setTimeout(
      () => {
        state.deferred = undefined;
        if (this.o.isConnected(deviceId)) {
          this.#count('skipped_connected');
          return;
        }
        state.lastAt = this.o.clock.now();
        this.#track(this.#deliver(deviceId, PUSH_WAKE));
      },
      Math.max(0, state.lastAt + this.o.throttleMs - now),
    );
    state.deferred.unref();
  }

  /** Cancels deferred wakes and retries, then waits for sends in flight. */
  async close(): Promise<void> {
    this.#abort.abort();
    for (const state of this.#devices.values()) clearTimeout(state.deferred);
    this.#devices.clear();
    await Promise.allSettled([...this.#inflight]);
  }

  /** Resolves when every send started so far has finished (tests). */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
  }

  async #deliver(deviceId: string, payload: PushPayload): Promise<void> {
    const target = await this.o.tokens.get(deviceId);
    if (!target) return this.#count('no_token');
    const sender = this.o.senders[target.provider];
    if (!sender) return this.#count('unconfigured');
    const maxRetries = this.o.maxRetries ?? 2;
    for (let attempt = 0; ; attempt++) {
      const outcome = await sender.send(target, payload);
      if (outcome.result === 'sent') return this.#count('sent');
      if (outcome.result === 'invalid_token') {
        await this.o.tokens.deleteInvalid(deviceId, target.address);
        return this.#count('invalid_token');
      }
      const { retryAfterMs, status } = outcome;
      if (retryAfterMs === undefined || attempt >= maxRetries || this.#abort.signal.aborted) {
        this.o.log.warn({ provider: target.provider, status }, 'push wake failed');
        return this.#count('failed');
      }
      const base = this.o.retryBaseMs ?? 1_000;
      const backoff = Math.min(MAX_BACKOFF_MS, Math.max(retryAfterMs, base * 2 ** attempt));
      try {
        await sleep(backoff, undefined, { signal: this.#abort.signal });
      } catch {
        return this.#count('failed');
      }
    }
  }

  #track(send: Promise<void>): void {
    const tracked = send.catch((error: unknown) => {
      this.o.log.warn({ err: error }, 'push wake failed');
      this.#count('failed');
    });
    this.#inflight.add(tracked);
    void tracked.finally(() => this.#inflight.delete(tracked));
  }

  #count(result: WakeResult): void {
    this.o.metrics.pushWakes.inc({ result });
  }

  #prune(now: number): void {
    if (this.#devices.size < PRUNE_AT) return;
    for (const [deviceId, state] of this.#devices) {
      if (!state.deferred && now - state.lastAt >= this.o.throttleMs) {
        this.#devices.delete(deviceId);
      }
    }
  }
}
