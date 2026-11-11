/**
 * Wake scheduling (ADR 0015). The gateway calls `wake` after each offline store; this keeps it
 * to at most one push per device per throttle window:
 * - the first wake goes out at once;
 * - later ones inside the window collapse into one wake at its end, skipped if the device has
 *   connected by then. So a message stored just after a wake is never left without one.
 * Urgent wakes skip the window. Transient provider failures are retried a bounded number of
 * times; an address the provider rejects is deleted.
 *
 * Call pushes (ADR 0028) have their own window, callThrottleMs: the caller re-sends its invite
 * every few seconds while the callee is offline, and one push per window is enough. Their
 * per-device times are the only call state the server keeps, in memory, for one window.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import type { Logger } from 'pino';

import {
  PUSH_CALL,
  PUSH_CIRCLE,
  PUSH_WAKE,
  type PushPayload,
  type PushProvider,
} from '@pingdost/shared-types';

import type { PushNotifier, PushSender } from './notifier';
import type { PushTokens } from './repo';
import type { Clock } from '../../infra/clock';
import type { Metrics } from '../../infra/metrics';

export interface PushServiceOptions {
  tokens: Pick<PushTokens, 'get' | 'deleteInvalid' | 'deleteInvalidVoip'>;
  /** Configured providers; a device whose provider is missing is not woken. */
  senders: Partial<Record<PushProvider, PushSender>>;
  throttleMs: number;
  /** At most one call push per device per window (default 15 s). */
  callThrottleMs?: number;
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
const CALL_THROTTLE_MS = 15_000;
/** At most one circle push per device in this window (Phase 37); the app fetches the lists. */
const CIRCLE_THROTTLE_MS = 60_000;

export class PushService implements PushNotifier {
  readonly #devices = new Map<string, DeviceState>();
  /** Device ID → when its last call push went out. */
  readonly #rings = new Map<string, number>();
  /** Device ID → when its last circle push went out. */
  readonly #circles = new Map<string, number>();
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

  ring(deviceId: string): void {
    if (this.#abort.signal.aborted) return;
    const now = this.o.clock.now();
    const window = this.o.callThrottleMs ?? CALL_THROTTLE_MS;
    const last = this.#rings.get(deviceId);
    if (last !== undefined && now - last < window) {
      this.o.metrics.callPushes.inc({ result: 'throttled' });
      return;
    }
    this.#rings.set(deviceId, now);
    if (this.#rings.size >= PRUNE_AT) {
      for (const [id, at] of this.#rings) if (now - at >= window) this.#rings.delete(id);
    }
    this.#track(
      this.#deliver(deviceId, PUSH_CALL, (result) => this.o.metrics.callPushes.inc({ result })),
    );
  }

  circle(deviceId: string): void {
    if (this.#abort.signal.aborted) return;
    const now = this.o.clock.now();
    const last = this.#circles.get(deviceId);
    if (last !== undefined && now - last < CIRCLE_THROTTLE_MS) return;
    this.#circles.set(deviceId, now);
    if (this.#circles.size >= PRUNE_AT) {
      for (const [id, at] of this.#circles) {
        if (now - at >= CIRCLE_THROTTLE_MS) this.#circles.delete(id);
      }
    }
    this.#track(this.#deliver(deviceId, PUSH_CIRCLE));
  }

  /** Cancels deferred wakes and retries, then waits for sends in flight. */
  async close(): Promise<void> {
    this.#abort.abort();
    for (const state of this.#devices.values()) clearTimeout(state.deferred);
    this.#devices.clear();
    this.#rings.clear();
    this.#circles.clear();
    await Promise.allSettled([...this.#inflight]);
    await Promise.allSettled(
      Object.values(this.o.senders).map((sender) => sender.close?.() ?? Promise.resolve()),
    );
  }

  /** Resolves when every send started so far has finished (tests). */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
  }

  async #deliver(
    deviceId: string,
    payload: PushPayload,
    count: (result: WakeResult) => void = (result) => this.#count(result),
  ): Promise<void> {
    const target = await this.o.tokens.get(deviceId);
    if (!target) return count('no_token');
    const sender = this.o.senders[target.provider];
    if (!sender) return count('unconfigured');
    const maxRetries = this.o.maxRetries ?? 2;
    for (let attempt = 0; ; attempt++) {
      const outcome = await sender.send(target, payload);
      if (outcome.result === 'sent') return count('sent');
      if (outcome.result === 'invalid_token') {
        if (outcome.voip && target.voip) {
          await this.o.tokens.deleteInvalidVoip(deviceId, target.voip);
        } else {
          await this.o.tokens.deleteInvalid(deviceId, target.address);
        }
        return count('invalid_token');
      }
      const { retryAfterMs, status } = outcome;
      if (retryAfterMs === undefined || attempt >= maxRetries || this.#abort.signal.aborted) {
        this.o.log.warn({ provider: target.provider, status, kind: payload.t }, 'push wake failed');
        return count('failed');
      }
      const base = this.o.retryBaseMs ?? 1_000;
      const backoff = Math.min(MAX_BACKOFF_MS, Math.max(retryAfterMs, base * 2 ** attempt));
      try {
        await sleep(backoff, undefined, { signal: this.#abort.signal });
      } catch {
        return count('failed');
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
