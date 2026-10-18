import { Redirect } from 'expo-router';

import type * as DevCryptoModule from '@/screens/dev-crypto';

// Dev-only: in release builds `__DEV__` is false, Metro drops the branch, and neither the
// screen nor its test vectors are bundled.
const DevCrypto = __DEV__
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('@/screens/dev-crypto') as typeof DevCryptoModule).DevCrypto
  : null;

export default function DevCryptoRoute() {
  return DevCrypto ? <DevCrypto /> : <Redirect href="/" />;
}
