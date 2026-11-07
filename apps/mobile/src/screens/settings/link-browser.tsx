// Settings → Devices → Link a browser (REQ §13.1, ADR 0019): scan the code PingDost on the web
// shows, see which browser asked (and when the code expires), approve, then wait until the
// browser has proved its keys. Afterwards this phone encrypts new messages to it too.
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useRouter } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, View } from 'react-native';

import { api } from '@/api';
import { errorCode } from '@/api/errors';
import { Button } from '@/components/button';
import { ListRow, ListSection } from '@/components/list-row';
import { Notice } from '@/components/notice';
import { Screen } from '@/components/screen';
import { Text } from '@/components/text';
import { getCryptoContext } from '@/crypto/bootstrap';
import { SECRET_ITEMS, SECURE_STORE_OPTIONS } from '@/crypto/secrets';
import { useChatRuntime } from '@/engine/hooks';
import {
  approvePairing,
  inspectPairing,
  LinkError,
  readPairingCode,
  type LinkRequest,
} from '@/settings/link-browser';
import { usePalette } from '@/theme/theme-root';

type Step =
  | { step: 'scan' }
  | { step: 'checking' }
  | { step: 'confirm'; request: LinkRequest }
  | { step: 'approving'; request: LinkRequest }
  | { step: 'waiting'; name: string }
  | { step: 'done'; name: string }
  | { step: 'failed'; message: string };

function messageFor(error: unknown): string {
  if (error instanceof LinkError) return error.message;
  switch (errorCode(error)) {
    case 'PAIRING_EXPIRED':
      return 'This code expired. The browser shows a new one: scan that instead.';
    case 'PAIRING_ALREADY_USED':
      return 'This code was used already. Reload PingDost on the web for a new one.';
    case 'PAIRING_NOT_FOUND':
      return 'This code is not valid any more. Reload PingDost on the web for a new one.';
    case 'FORBIDDEN':
      return 'Only your main phone can link a browser.';
    default:
      return 'Could not link the browser. Check your connection and try again.';
  }
}

function useSecondsLeft(until: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return until === undefined ? 0 : Math.max(0, Math.round((until - now) / 1_000));
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Until the browser proves its keys and shows up as an active device (about a minute). */
async function waitForBrowser(deviceId: string): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    const devices = await api.devices.list().catch(() => []);
    if (devices.some((d) => d.deviceId === deviceId && d.status === 'active')) return true;
    await wait(1_500);
  }
  return false;
}

export function LinkBrowserScreen() {
  const router = useRouter();
  const palette = usePalette();
  const runtime = useChatRuntime();
  const [permission, requestPermission] = useCameraPermissions();
  const [state, setState] = useState<Step>({ step: 'scan' });
  const handling = useRef(false);
  const request =
    state.step === 'confirm' || state.step === 'approving' ? state.request : undefined;
  const secondsLeft = useSecondsLeft(request?.details.expiresAt);

  async function scanned(result: BarcodeScanningResult) {
    if (handling.current || state.step !== 'scan') return;
    handling.current = true;
    setState({ step: 'checking' });
    try {
      const qr = readPairingCode(result.data);
      setState({ step: 'confirm', request: await inspectPairing(api.pairing, qr) });
    } catch (error) {
      setState({ step: 'failed', message: messageFor(error) });
    } finally {
      handling.current = false;
    }
  }

  async function approve(link: LinkRequest) {
    setState({ step: 'approving', request: link });
    try {
      const { provider, store } = await getCryptoContext();
      const secret = await SecureStore.getItemAsync(
        SECRET_ITEMS.accountIdentityKey,
        SECURE_STORE_OPTIONS,
      );
      if (!secret) throw new LinkError('Only your main phone can link a browser.');
      const identity = provider.restoreSigningKey(secret);
      let deviceId: string;
      try {
        deviceId = await approvePairing(api.pairing, link.qr, store.account, identity);
      } finally {
        identity.dispose();
      }
      setState({ step: 'waiting', name: link.details.name });
      if (!(await waitForBrowser(deviceId))) {
        setState({
          step: 'failed',
          message:
            'You approved it, but the browser did not finish. Keep it open on the pairing page and try again.',
        });
        return;
      }
      // New messages from here on are encrypted to the browser too.
      if (runtime) await runtime.engine.refreshDevices(runtime.userId).catch(() => undefined);
      setState({ step: 'done', name: link.details.name });
    } catch (error) {
      setState({ step: 'failed', message: messageFor(error) });
    }
  }

  if (!permission) {
    return (
      <Screen>
        <Text className="text-muted">Checking camera access…</Text>
      </Screen>
    );
  }
  if (!permission.granted) {
    return (
      <Screen
        title="Camera access"
        subtitle="PingDost uses the camera only to scan codes. Nothing is recorded or uploaded."
      >
        {permission.canAskAgain ? (
          <Button label="Allow camera" onPress={() => void requestPermission()} />
        ) : (
          <Button label="Open settings" onPress={() => void Linking.openSettings()} />
        )}
      </Screen>
    );
  }

  if (state.step === 'scan' || state.step === 'checking') {
    return (
      <View className="flex-1 bg-background">
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={state.step === 'scan' ? (result) => void scanned(result) : undefined}
        />
        <View className="gap-3 p-5">
          {state.step === 'checking' ? (
            <ActivityIndicator color={palette.accent} />
          ) : (
            <Text className="text-center text-muted">
              On your computer, open PingDost on the web and point the camera at the code it shows.
            </Text>
          )}
        </View>
      </View>
    );
  }

  if (request) {
    const { details, qr } = request;
    const expired = secondsLeft === 0;
    return (
      <Screen title="Link this browser?">
        <ListSection>
          <ListRow title="Browser" subtitle={details.name} />
          <ListRow title="Website" subtitle={qr.origin} />
          {details.userAgent && <ListRow title="Reported as" subtitle={details.userAgent} />}
          <ListRow title="Asked at" subtitle={new Date(details.createdAt).toLocaleTimeString()} />
        </ListSection>
        <Notice
          message={`Approve only a browser you are using right now. It will be able to send and read new messages for your account, until you remove it here. ${
            expired ? 'This code expired.' : `The code works for ${secondsLeft} s more.`
          }`}
        />
        <Button
          label="Approve"
          loading={state.step === 'approving'}
          disabled={expired}
          onPress={() => void approve(request)}
        />
        <Button label="Cancel" variant="secondary" onPress={() => router.back()} />
      </Screen>
    );
  }

  if (state.step === 'waiting') {
    return (
      <Screen>
        <ActivityIndicator color={palette.accent} />
        <Text className="text-center text-muted">Waiting for {state.name} to finish linking…</Text>
      </Screen>
    );
  }

  if (state.step === 'done') {
    return (
      <Screen>
        <Notice
          tone="success"
          message={`${state.name} is linked. You can remove it any time under Devices.`}
        />
        <Button label="Done" onPress={() => router.back()} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Notice
        tone="error"
        message={state.step === 'failed' ? state.message : 'Something went wrong.'}
      />
      <Button label="Scan again" variant="secondary" onPress={() => setState({ step: 'scan' })} />
    </Screen>
  );
}
