// Settings → Calls (ADR 0028): the "Force relay (TURN)" debug toggle, and in dev builds the
// generated test media.
import { useState } from 'react';

import { Card, CardTitle } from '@/components/ui/card';
import { Toggle } from '@/components/ui/input';

import { callPrefs } from './prefs';

export function CallsCard() {
  const [relay, setRelay] = useState(callPrefs.forceRelay);
  const [test, setTest] = useState(callPrefs.testMedia);
  return (
    <Card className="flex flex-col">
      <CardTitle className="mb-2">Calls</CardTitle>
      <p className="mb-2 text-sm text-muted">
        Calls are end-to-end encrypted and go straight between the two devices when they can. When
        they cannot, PingDost&apos;s relay server forwards the encrypted media; it cannot hear or
        see it. No call is recorded or logged.
      </p>
      <Toggle
        label="Force relay (TURN)"
        description="Debug: send every call through the relay server, as on a network that blocks direct calls."
        checked={relay}
        onChange={(value) => {
          callPrefs.setForceRelay(value);
          setRelay(value);
        }}
      />
      {import.meta.env.DEV && (
        <Toggle
          label="Test media (dev)"
          description="Use a generated tone and picture instead of the microphone and camera."
          checked={test}
          onChange={(value) => {
            callPrefs.setTestMedia(value);
            setTest(value);
          }}
        />
      )}
    </Card>
  );
}
