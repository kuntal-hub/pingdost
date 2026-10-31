/**
 * This device's side of the nearby handshake (ADR 0024): it signs with the device's Ed25519
 * identity key (the Olm account's), and recognises a peer only by a key that a verified,
 * cached directory lists. The account identity key certified that device (ADR 0008), so a
 * known key means a known contact device; any other valid key is an unknown peer. Nothing is
 * looked up on the server: an unknown peer stays unknown.
 */
import type { CryptoProvider, OlmAccount } from '@pingdost/crypto/core';
import type { HelloCheck, NearbyIdentity } from '@pingdost/transport';

import type { EngineStore } from '../store';

export interface NearbyIdentityOptions {
  self: { userId: string; deviceId: string };
  crypto: CryptoProvider;
  /** Only read: signing does not change the account. */
  account: OlmAccount;
  store: Pick<EngineStore, 'listDirectories'>;
  /** Blocked users' devices count as unknown. */
  blocked?: (userId: string) => boolean;
}

export function createNearbyIdentity(options: NearbyIdentityOptions): NearbyIdentity {
  const { crypto, account, store, self } = options;
  const identityKey = account.identityKeys().ed25519;
  return {
    deviceId: self.deviceId,
    identityKey,
    sign: (message) => account.sign(message),
    async check(key, message, signature): Promise<HelloCheck> {
      let valid: boolean;
      try {
        valid = crypto.verifyEd25519(key, message, signature);
      } catch {
        valid = false; // a malformed key or signature
      }
      if (!valid) return { status: 'invalid' };
      if (key === identityKey) return { status: 'unknown' }; // our own key, from a reflection
      for (const directory of await store.listDirectories()) {
        const device = directory.devices.find((d) => d.ed25519 === key);
        if (!device) continue;
        if (directory.userId !== self.userId && options.blocked?.(directory.userId)) break;
        return { status: 'known', peer: { userId: directory.userId, deviceId: device.deviceId } };
      }
      return { status: 'unknown' };
    },
  };
}
