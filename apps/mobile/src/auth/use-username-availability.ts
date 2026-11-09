import { useEffect, useRef, useState } from 'react';

import { api } from '@/api';

import {
  createAvailabilityChecker,
  type Availability,
  type AvailabilityChecker,
} from './username-availability';

/** Checks `username` as the user types it (Phase 34). */
export function useUsernameAvailability(username: string): Availability {
  const [availability, setAvailability] = useState<Availability>({ state: 'idle' });
  const checker = useRef<AvailabilityChecker | null>(null);

  useEffect(() => {
    const created = createAvailabilityChecker({
      check: (name, signal) => api.auth.usernameAvailability(name, signal),
      onChange: setAvailability,
    });
    checker.current = created;
    return () => {
      created.dispose();
      checker.current = null;
    };
  }, []);

  useEffect(() => {
    checker.current?.update(username);
  }, [username]);

  return availability;
}
