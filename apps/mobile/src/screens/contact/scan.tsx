import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Linking, Text, View } from 'react-native';

import { Button } from '@/components/button';
import { Notice } from '@/components/notice';
import { Screen } from '@/components/screen';
import { contactName } from '@/engine/contacts';
import { useChatRuntime, useContact } from '@/engine/hooks';
import { useSafetyNumber } from '@/engine/safety';
import { verifySafetyQr } from '@pingdost/protocol/safety-number';

type Outcome = 'verified' | 'mismatch' | 'invalid' | 'unsupported_version';

const MESSAGES: Record<Exclude<Outcome, 'verified'>, string> = {
  mismatch:
    "This code does not match. Make sure it is this contact's code for you. If it still differs, someone may be in between: do not mark them verified.",
  invalid: 'That is not a PingDost safety code.',
  unsupported_version: 'That code comes from a newer PingDost. Update the app and try again.',
};

/** Scans the contact's safety QR code; a match marks them verified (REQ §7.3). */
export function ScanScreen({ userId }: { userId: string }) {
  const router = useRouter();
  const runtime = useChatRuntime();
  const contact = useContact(userId);
  const safety = useSafetyNumber(userId);
  const [permission, requestPermission] = useCameraPermissions();
  const [outcome, setOutcome] = useState<Outcome>();
  const handling = useRef(false);
  const name = contactName(contact);

  async function scanned(result: BarcodeScanningResult) {
    if (handling.current || outcome || !safety.number || !safety.identityKey || !runtime) return;
    handling.current = true;
    try {
      const check = verifySafetyQr(result.data, safety.number);
      if (check === 'match') {
        const marked = await runtime.engine.markVerified(userId, safety.identityKey);
        setOutcome(marked ? 'verified' : 'mismatch');
      } else {
        setOutcome(check);
      }
    } finally {
      handling.current = false;
    }
  }

  if (!permission)
    return (
      <Screen>
        <Text className="text-muted">Checking camera access…</Text>
      </Screen>
    );
  if (!permission.granted) {
    return (
      <Screen
        title="Camera access"
        subtitle="PingDost uses the camera only to scan safety codes. Nothing is recorded or uploaded."
      >
        {permission.canAskAgain ? (
          <Button label="Allow camera" onPress={() => void requestPermission()} />
        ) : (
          <Button label="Open settings" onPress={() => void Linking.openSettings()} />
        )}
      </Screen>
    );
  }

  if (outcome === 'verified') {
    return (
      <Screen>
        <Notice tone="success" message={`✓ ${name} is verified. Your safety numbers match.`} />
        <Button label="Done" onPress={() => router.back()} />
      </Screen>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={outcome || !safety.number ? undefined : (result) => void scanned(result)}
      />
      <View className="gap-3 p-5">
        {outcome ? (
          <>
            <Notice tone="error" message={MESSAGES[outcome]} />
            <Button label="Scan again" variant="secondary" onPress={() => setOutcome(undefined)} />
          </>
        ) : (
          <Text className="text-center text-muted">
            {safety.number
              ? `Point the camera at the code on ${name}'s phone (Contact info → their code).`
              : 'Preparing the safety number…'}
          </Text>
        )}
      </View>
    </View>
  );
}
