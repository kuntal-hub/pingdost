// Safety numbers for the contact screen and the QR scanner (ADR 0012). Computing one takes
// 2 × 5,200 SHA-512 rounds: they run on the platform's native SHA-512 (expo-crypto), which keeps
// the UI responsive, and results are cached per pair of identity keys.
import * as Crypto from 'expo-crypto';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import {
  safetyFingerprintAsync,
  safetyNumber,
  type SafetyNumber,
} from '@pingdost/protocol/safety-number';

import { useChatRuntime } from './hooks';

const cache = new Map<string, SafetyNumber>();

// A copy on its own ArrayBuffer, as `BufferSource` requires.
const nativeSha512 = async (data: Uint8Array) =>
  new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA512, new Uint8Array(data)));

async function compute(
  local: { userId: string; accountIdentityKey: string },
  remote: { userId: string; accountIdentityKey: string },
): Promise<SafetyNumber> {
  const started = performance.now();
  const [localPrint, remotePrint] = await Promise.all([
    safetyFingerprintAsync(local, nativeSha512),
    safetyFingerprintAsync(remote, nativeSha512),
  ]);
  if (__DEV__) console.log(`[safety] computed in ${Math.round(performance.now() - started)} ms`);
  return safetyNumber(localPrint, remotePrint);
}

export interface SafetyState {
  number: SafetyNumber | undefined;
  /** The contact's account identity key the number covers. */
  identityKey: string | undefined;
  verified: boolean;
  /** Why there is no number. */
  problem: 'loading' | 'no_own_key' | 'no_contact_key' | undefined;
  reload(): void;
}

/** The safety number with `userId`, recomputed whenever the screen gains focus. */
export function useSafetyNumber(userId: string): SafetyState {
  const runtime = useChatRuntime();
  const [state, setState] = useState<Omit<SafetyState, 'reload'>>({
    number: undefined,
    identityKey: undefined,
    verified: false,
    problem: 'loading',
  });
  const [generation, setGeneration] = useState(0);

  useFocusEffect(
    useCallback(() => {
      if (!runtime) return;
      let live = true;
      void (async () => {
        let info = await runtime.engine.contact(userId);
        // Not fetched yet, or fetched long ago: ask the directory (keeps the cache offline).
        const fresh = await runtime.engine.refreshDevices(userId);
        if (fresh) info = await runtime.engine.contact(userId);
        const theirKey = info.directory?.accountIdentityKey ?? undefined;
        const ownKey = runtime.accountIdentityKey;
        if (!ownKey || !theirKey) {
          if (live) {
            setState({
              number: undefined,
              identityKey: theirKey,
              verified: false,
              problem: ownKey ? 'no_contact_key' : 'no_own_key',
            });
          }
          return;
        }
        const key = `${runtime.userId}:${ownKey}:${userId}:${theirKey}`;
        let number = cache.get(key);
        if (!number) {
          number = await compute(
            { userId: runtime.userId, accountIdentityKey: ownKey },
            { userId, accountIdentityKey: theirKey },
          );
          cache.set(key, number);
        }
        if (live)
          setState({ number, identityKey: theirKey, verified: info.verified, problem: undefined });
      })();
      return () => {
        live = false;
      };
    }, [runtime, userId, generation]),
  );

  return { ...state, reload: () => setGeneration((g) => g + 1) };
}
