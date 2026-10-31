import { Redirect } from 'expo-router';

import type * as DevNearbyModule from '@/screens/dev-nearby';

// Dev-only: in release builds `__DEV__` is false, Metro drops the branch, and the screen is not
// bundled. The native module itself ships in every build (Phase 22 uses it).
const DevNearby = __DEV__
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('@/screens/dev-nearby') as typeof DevNearbyModule).DevNearby
  : null;

export default function DevNearbyRoute() {
  return DevNearby ? <DevNearby /> : <Redirect href="/" />;
}
