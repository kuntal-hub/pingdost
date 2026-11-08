// Settings → Log out → "Remove data from this phone" (Phase 7 handoff, ADR 0022): signs this
// device out of the account for good, then deletes everything PingDost keeps here, so the
// phone can be given away or used with another account.
import { api, authStore } from '@/api';
import { startChat, stopChat } from '@/engine/runtime';

import { wipeThisPhone } from './wipe';

/**
 * 1. revokes this device on the server (needs a connection: otherwise the account would
 *    still list this phone);
 * 2. deletes the encrypted database, the files, and the keys in secure storage (`wipe.ts`).
 * Throws (and leaves everything in place) if the server cannot be reached.
 */
export async function removeDataFromThisPhone(): Promise<void> {
  const session = authStore.getState().session;
  if (!session) return;
  await stopChat();
  try {
    await api.push.unregisterToken().catch(() => undefined);
    if (session.deviceId) await api.devices.revoke(session.deviceId);
  } catch (error) {
    // Still this account's phone: carry on as before.
    void startChat().catch(() => undefined);
    throw error;
  }
  await wipeThisPhone();
}
