// A call push (`{"t":"call"}`, ADR 0028/0029): an E2EE call invite is waiting for this phone.
// The push says nothing else, so the app, possibly started headless, connects and waits for
// the caller's next copy of the invite (it re-sends one every 3 s while ringing). The call
// runtime then rings: a call notification with a full-screen intent. The socket stays open
// while the call rings or runs; if no invite comes within 15 s, the wake ends.
import { AppState } from 'react-native';

import { authStore } from '@/api';
import { stageOf } from '@/auth/auth-store';
import { startChat } from '@/engine/runtime';

import { callInProgress } from './runtime';

const INVITE_WAIT_MS = 15_000;
/** The longest a call can ring (45 s) plus a margin; an answered call is in the app. */
const RING_WAIT_MS = 60_000;

let waking: Promise<void> | undefined;

/** Handles one call push; concurrent ones share it. Never throws. */
export function handleCallWake(): Promise<void> {
  waking ??= wake()
    .catch((error: unknown) => {
      if (__DEV__) console.warn('[calls] call wake failed', error);
    })
    .finally(() => {
      waking = undefined;
    });
  return waking;
}

function until(condition: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (condition() || Date.now() > deadline) resolve();
      else setTimeout(check, 250);
    };
    check();
  });
}

async function wake(): Promise<void> {
  await authStore.getState().hydrate();
  if (stageOf(authStore.getState()) !== 'ready') return;
  const { transport } = await startChat();
  if (AppState.currentState === 'active') return;
  transport.start();
  await until(callInProgress, INVITE_WAIT_MS);
  await until(() => !callInProgress() || AppState.currentState === 'active', RING_WAIT_MS);
  if (AppState.currentState !== 'active' && !callInProgress()) transport.stop();
}
