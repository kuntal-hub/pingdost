// After the phone approved: the tokens go into use, the browser's one-time and fallback keys
// are published (so the phone and contacts can open Olm sessions to it), and its account and
// device record are sealed in IndexedDB. Until the last step nothing is saved, so a browser
// closed half-way starts at the pairing screen again.
import { cryptoProvider } from '@/crypto/provider';
import {
  adoptTokens,
  api,
  enterApp,
  saveAccount,
  savePairing,
  type LinkedDevice,
} from '@/session/session';

import { pairBrowser, type PairingDeps } from './pairing';

type Callbacks = Pick<PairingDeps, 'onCode' | 'onApproved' | 'onOffline'>;

export async function linkThisBrowser(
  name: string,
  callbacks: Callbacks,
  signal: AbortSignal,
): Promise<void> {
  const provider = await cryptoProvider();
  const linked = await pairBrowser(
    { provider, api: api.pairing, origin: window.location.origin, name, ...callbacks },
    signal,
  );
  const { account } = linked;
  try {
    adoptTokens(linked.tokens);
    const me = await api.account.me();
    const device: LinkedDevice = {
      deviceId: linked.device.deviceId,
      userId: me.userId,
      username: me.username,
      accountIdentityKey: me.accountIdentityKey,
      name: linked.device.name,
      linkedAt: linked.device.createdAt,
    };
    // Loaded only now: the engine is a large part of the app.
    const { publishKeys } = await import('@pingdost/message-engine');
    await publishKeys({
      account,
      deviceId: device.deviceId,
      keys: api.keys,
      saveAccount: () => saveAccount(account),
      needsFallbackKey: true,
    });
    await saveAccount(account);
    await savePairing(device, linked.tokens);
    enterApp(device);
  } finally {
    account.dispose();
  }
}
