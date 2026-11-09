// Live username availability while typing (Phase 34): local rules first, then the server after a
// pause. Only the newest name's answer is ever shown; older requests are aborted.
import { usernameProblem } from '@/forms/messages';
import type { UsernameAvailabilityResponse } from '@pingdost/shared-types';

export type Availability =
  | { state: 'idle' }
  | { state: 'checking'; username: string }
  | { state: 'invalid'; message: string }
  | { state: 'available'; username: string }
  | { state: 'taken'; username: string }
  | { state: 'reserved'; username: string }
  /** Offline, rate-limited or a server error: the submit decides. */
  | { state: 'unknown' };

export type AvailabilityCheck = (
  username: string,
  signal: AbortSignal,
) => Promise<UsernameAvailabilityResponse>;

export interface AvailabilityCheckerOptions {
  check: AvailabilityCheck;
  onChange: (availability: Availability) => void;
  /** Pause after the last keystroke before checking. */
  delayMs?: number;
  /** How long an answer is reused when the same name comes back. */
  cacheMs?: number;
  now?: () => number;
}

export interface AvailabilityChecker {
  update(raw: string): void;
  dispose(): void;
}

function fromResponse(response: UsernameAvailabilityResponse): Availability {
  if (response.available) return { state: 'available', username: response.username };
  if (response.reason === 'reserved') return { state: 'reserved', username: response.username };
  if (response.reason === 'invalid')
    return { state: 'invalid', message: 'This username is not allowed' };
  return { state: 'taken', username: response.username };
}

export function createAvailabilityChecker({
  check,
  onChange,
  delayMs = 400,
  cacheMs = 60_000,
  now = Date.now,
}: AvailabilityCheckerOptions): AvailabilityChecker {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: AbortController | undefined;
  const answers = new Map<string, { availability: Availability; at: number }>();

  function cancel(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    inFlight?.abort();
    inFlight = undefined;
  }

  async function run(name: string): Promise<void> {
    const problem = usernameProblem(name);
    if (problem) {
      onChange({ state: 'invalid', message: problem });
      return;
    }
    const controller = new AbortController();
    inFlight = controller;
    onChange({ state: 'checking', username: name });
    try {
      const availability = fromResponse(await check(name, controller.signal));
      if (controller.signal.aborted) return;
      answers.set(name, { availability, at: now() });
      onChange(availability);
    } catch {
      if (!controller.signal.aborted) onChange({ state: 'unknown' });
    } finally {
      if (inFlight === controller) inFlight = undefined;
    }
  }

  return {
    update(raw) {
      cancel();
      const name = raw.trim().toLowerCase();
      if (name === '') {
        onChange({ state: 'idle' });
        return;
      }
      const known = answers.get(name);
      if (known && now() - known.at < cacheMs) {
        onChange(known.availability);
        return;
      }
      // Nothing stale stays on screen while the user types.
      onChange({ state: 'idle' });
      timer = setTimeout(() => {
        timer = undefined;
        void run(name);
      }, delayMs);
    },
    dispose: cancel,
  };
}

/** The line under the username field, or undefined for none. */
export function availabilityNote(
  availability: Availability,
): { tone: 'success' | 'danger' | 'muted'; text: string; busy?: boolean } | undefined {
  switch (availability.state) {
    case 'idle':
      return undefined;
    case 'checking':
      return { tone: 'muted', text: 'Checking…', busy: true };
    case 'invalid':
      return { tone: 'danger', text: availability.message };
    case 'available':
      return { tone: 'success', text: `@${availability.username} is available` };
    case 'taken':
      return { tone: 'danger', text: 'Taken. Try adding numbers, _ or .' };
    case 'reserved':
      return { tone: 'danger', text: 'This username is reserved. Try another' };
    case 'unknown':
      return { tone: 'muted', text: 'Couldn’t check right now. We’ll check when you continue' };
  }
}
