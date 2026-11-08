// Settings → Delete account (Phase 27, ADR 0036; Google Play requires an in-app path): with an
// email code, the server deletes the account and revokes every device; then this phone removes
// everything PingDost keeps on it, as "Remove data from this phone" does.
import { api } from '@/api';
import { startChat, stopChat } from '@/engine/runtime';

import { wipeThisPhone } from './wipe';

/** Emails the code that confirms the deletion. */
export function sendDeletionCode(): Promise<void> {
  return api.account.sendDeletionCode();
}

/**
 * Deletes the account, then wipes this phone. Throws (and leaves everything in place) when the
 * server refuses the code or cannot be reached.
 */
export async function deleteAccount(otp: string): Promise<void> {
  // Stopped first: the server revokes this device, and the socket would wipe it mid-request.
  await stopChat();
  try {
    await api.account.deleteAccount({ otp });
  } catch (error) {
    void startChat().catch(() => undefined);
    throw error;
  }
  await wipeThisPhone();
}
