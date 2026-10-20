// A push wake (Phase 12, ADR 0015): `{"t":"wake"}` means "your mailbox has something". The app,
// possibly started headless by the OS, connects, lets the mailbox drain (decrypt, store,
// receipts, local notifications via `installNotifier`), then closes the socket again unless the
// user opened the app meanwhile. Android allows a data message's handler only seconds, so this
// is bounded.
import { AppState } from 'react-native';

import { authStore } from '@/api';
import { stageOf } from '@/auth/auth-store';
import { startChat } from '@/engine/runtime';
import type { MessageEngine } from '@pingdost/message-engine';
import type { Transport } from '@pingdost/transport';

/** How long to wait for the socket before giving up. */
const CONNECT_TIMEOUT_MS = 10_000;
/** Done once nothing new arrived for this long (receipts leave after 200 ms). */
const QUIET_MS = 2_500;
/** The whole wake, whatever happens. */
const MAX_WAKE_MS = 20_000;

let waking: Promise<void> | undefined;

/** Handles one wake; concurrent wakes share it. Never throws. */
export function handleWake(): Promise<void> {
  waking ??= wake()
    .catch((error: unknown) => {
      if (__DEV__) console.warn('[push] wake failed', error);
    })
    .finally(() => {
      waking = undefined;
    });
  return waking;
}

async function wake(): Promise<void> {
  await authStore.getState().hydrate();
  if (stageOf(authStore.getState()) !== 'ready') return;
  const { engine, transport } = await startChat();
  // On screen the socket is already open and stays open.
  if (AppState.currentState === 'active') return;
  transport.start();
  await drained(engine, transport);
  await engine.idle();
  if (AppState.currentState !== 'active') transport.stop();
}

/** Resolves once the mailbox has gone quiet, the socket never came up, or time ran out. */
function drained(engine: MessageEngine, transport: Transport): Promise<void> {
  return new Promise((resolve) => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const cleanup: (() => void)[] = [];
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let online = false;
    const finish = () => {
      for (const timer of timers) clearTimeout(timer);
      clearTimeout(quiet);
      for (const remove of cleanup.splice(0)) remove();
      resolve();
    };
    const restartQuiet = () => {
      if (!online) return;
      clearTimeout(quiet);
      quiet = setTimeout(finish, QUIET_MS);
    };
    timers.push(setTimeout(finish, MAX_WAKE_MS));
    timers.push(setTimeout(() => !online && finish(), CONNECT_TIMEOUT_MS));
    cleanup.push(engine.onConversationListChanged(restartQuiet));
    cleanup.push(
      transport.status$.subscribe(
        (status) => {
          if (status !== 'online' || online) return;
          online = true;
          restartQuiet();
        },
        { emitCurrent: true },
      ),
    );
  });
}
