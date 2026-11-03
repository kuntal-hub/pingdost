// iOS VoIP pushes and CallKit events (Phase 29, ADR 0032), from the first line of JS on. A VoIP
// push can launch the app in the background: the native side has already reported a "PingDost"
// call to CallKit, so here the app connects (`handleCallWake`) to receive the E2EE invite. The
// call runtime starts later (with the engine), so CallKit events wait here until it takes them:
// a user can answer on the lock screen before any of that has run.
// The entry (`index.ts`) loads this file before the app.
import { Platform } from 'react-native';

import type { CallKitEvent } from './callkit';
import { handleCallWake } from './wake';
import { callKitNative } from '../../modules/pingdost-calls/src';

const waiting: CallKitEvent[] = [];
let consumer: ((event: CallKitEvent) => void) | null = null;

function deliver(event: CallKitEvent): void {
  if (event.type === 'push') void handleCallWake();
  if (consumer) consumer(event);
  else waiting.push(event);
}

const native = Platform.OS === 'ios' ? callKitNative() : null;
if (native) {
  native.addListener('callkit', deliver);
  for (const event of native.takePendingCallKitEvents()) deliver(event);
  // Calls reported for pushes before JS ran: connect for their invites.
  if (native.pendingPushCalls().length > 0) void handleCallWake();
}

/** The call runtime takes CallKit events from here on; returns the stop function. */
export function consumeCallKitEvents(handler: (event: CallKitEvent) => void): () => void {
  consumer = handler;
  for (const event of waiting.splice(0)) handler(event);
  return () => {
    if (consumer === handler) consumer = null;
  };
}
