import { Redirect, type Href } from 'expo-router';

import type { AppStage } from '@/auth/auth-store';
import { useAppStage } from '@/auth/use-auth';

const destinations: Record<Exclude<AppStage, 'loading'>, Href> = {
  signedOut: '/welcome',
  needsUsername: '/google-username',
  deviceSetup: '/setup',
  ready: '/chats',
};

/**
 * `/` is never protected: it sends each stage to its first screen. Protected routes also
 * fall back here when their guard turns off.
 */
export default function IndexRoute() {
  const stage = useAppStage();
  return stage === 'loading' ? null : <Redirect href={destinations[stage]} />;
}
