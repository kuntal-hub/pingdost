// The account lives on another phone (or its phone is lost): how this phone takes over
// (REQ §6.3, ADR 0022). Approve on the old phone, restore a backup, or start fresh.
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';

import { describeError, errorCode } from '@/api/errors';
import { pickBackupFile, openBackup, type PickedBackup } from '@/backup/restore';
import { Button } from '@/components/button';
import { ListRow, ListSection } from '@/components/list-row';
import { Notice } from '@/components/notice';
import { PhraseInput, phraseProblem } from '@/components/phrase';
import { Screen } from '@/components/screen';
import { Text } from '@/components/text';
import { TextField } from '@/components/text-field';
import {
  BackupAccountMismatch,
  checkTransfer,
  planRestore,
  replacePhone,
  sendReplaceCode,
  startTransfer,
  type RestorePlan,
  type TransferRequest,
} from '@/recovery/new-phone';
import { usePalette } from '@/theme/theme-root';
import { BackupError } from '@pingdost/backup';

const LOSS_COPY =
  'If you lose all devices and have no backup, your chat history cannot be recovered. ' +
  'PingDost cannot restore it.';

type Way = 'choose' | 'transfer' | 'restore' | 'fresh';

function Working({ text }: { text: string }) {
  const palette = usePalette();
  return (
    <View className="flex-row items-center gap-3" accessibilityLiveRegion="polite">
      <ActivityIndicator color={palette.accent} />
      <Text className="flex-1 text-base text-foreground">{text}</Text>
    </View>
  );
}

function message(error: unknown): string {
  if (error instanceof BackupError || error instanceof BackupAccountMismatch) return error.message;
  switch (errorCode(error)) {
    case 'RECENT_LOGIN_REQUIRED':
      return 'For your safety this needs a fresh login. Log out, log in again, and retry.';
    case 'OTP_INVALID':
      return 'That code is not right. Check the email and try again.';
    case 'OTP_EXPIRED':
    case 'OTP_ATTEMPTS_EXCEEDED':
      return 'That code has expired. Send a new one.';
    case 'IDENTITY_KEY_MISMATCH':
      return "This backup's account key does not match your account.";
    default:
      return describeError(error).message;
  }
}

/** The email-code step shared by restore, start fresh and deleting the account. */
export function CodeStep({
  action,
  onConfirm,
  onBack,
  sendCode = sendReplaceCode,
  danger = false,
}: {
  action: string;
  onConfirm: (otp: string) => Promise<void>;
  onBack: () => void;
  /** Emails the code (default: the phone-replacement code). */
  sendCode?: () => Promise<void>;
  /** The final action cannot be undone (red button). */
  danger?: boolean;
}) {
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await sendCode();
      setSent(true);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(code);
    } catch (caught) {
      setError(message(caught));
      setBusy(false);
    }
  }

  return (
    <>
      <Text className="text-base text-foreground">
        To confirm it is you, PingDost emails a 6-digit code to your account&apos;s address.
      </Text>
      {sent && (
        <TextField
          label="Code from the email"
          value={code}
          onChangeText={(text) => setCode(text.replace(/\D/g, '').slice(0, 6))}
          keyboardType="number-pad"
          autoComplete="one-time-code"
          maxLength={6}
        />
      )}
      {error && <Notice tone="error" message={error} />}
      {sent ? (
        <Button
          label={action}
          {...(danger ? { variant: 'danger' as const } : {})}
          loading={busy}
          disabled={code.length !== 6}
          onPress={() => void confirm()}
        />
      ) : (
        <Button label="Email me a code" loading={busy} onPress={() => void send()} />
      )}
      {sent && !busy && (
        <Button label="Send a new code" variant="ghost" onPress={() => void send()} />
      )}
      {!busy && <Button label="Back" variant="ghost" onPress={onBack} />}
    </>
  );
}

function TransferFlow({ onBack }: { onBack: () => void }) {
  const [request, setRequest] = useState<TransferRequest | null>(null);
  const [state, setState] = useState<'starting' | 'waiting' | 'denied' | 'expired' | 'error'>(
    'starting',
  );
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState('starting');
    setError(null);
    startTransfer().then(
      (started) => {
        if (!active) return;
        setRequest(started);
        setState('waiting');
        const poll = () => {
          checkTransfer(started).then(
            (outcome) => {
              if (!active || outcome === 'done') return;
              if (outcome === 'pending') timer = setTimeout(poll, 2_000);
              else setState(outcome);
            },
            () => {
              // Offline for a moment: keep asking.
              if (active) timer = setTimeout(poll, 4_000);
            },
          );
        };
        timer = setTimeout(poll, 2_000);
      },
      (caught: unknown) => {
        if (!active) return;
        setError(
          errorCode(caught) === 'CONFLICT'
            ? 'No phone is active on your account to approve this. Restore from a backup or start fresh instead.'
            : message(caught),
        );
        setState('error');
      },
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [attempt]);

  if (state === 'starting') return <Working text="Asking your other phone…" />;
  if (state === 'error') {
    return (
      <>
        <Notice tone="error" message={error ?? 'Something went wrong.'} />
        <Button label="Back" variant="ghost" onPress={onBack} />
      </>
    );
  }
  if (state === 'denied' || state === 'expired') {
    return (
      <>
        <Notice
          tone="error"
          message={
            state === 'denied'
              ? 'Your other phone denied the request.'
              : 'The request expired before it was approved.'
          }
        />
        <Button label="Ask again" onPress={() => setAttempt((n) => n + 1)} />
        <Button label="Back" variant="ghost" onPress={onBack} />
      </>
    );
  }
  return (
    <>
      <Text className="text-base text-foreground">
        Open PingDost on your other phone. It shows a request from this phone. Approve it only if it
        shows this code:
      </Text>
      <Text
        accessibilityLabel={`Code ${request?.code.split('').join(' ')}`}
        className="text-center text-4xl font-bold tracking-widest text-foreground"
      >
        {request?.code}
      </Text>
      <Working text="Waiting for your other phone…" />
      <Notice message="Your chats stay on the other phone, which is signed out when this one takes over. To bring them along, make a backup there first and choose Restore from a backup instead." />
      <Button label="Back" variant="ghost" onPress={onBack} />
    </>
  );
}

function RestoreFlow({ onBack }: { onBack: () => void }) {
  const [picked, setPicked] = useState<PickedBackup | null>(null);
  const [phrase, setPhrase] = useState('');
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const planRef = useRef<RestorePlan | null>(null);

  useEffect(
    () => () => {
      // Leaving: close the file and forget the phrase.
      planRef.current?.opened.close();
    },
    [],
  );

  async function pick() {
    setError(null);
    try {
      const file = await pickBackupFile();
      if (file) setPicked(file);
    } catch (caught) {
      setError(message(caught));
    }
  }

  async function open() {
    if (!picked) return;
    setError(null);
    setBusy('Unlocking the backup… This takes a few seconds.');
    // Let the spinner draw before the key derivation holds the JS thread.
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      const opened = await openBackup(picked, phrase);
      setPhrase('');
      setBusy('Checking the whole file…');
      try {
        const checked = await planRestore(opened);
        planRef.current = checked;
        setPlan(checked);
      } catch (caught) {
        opened.close();
        throw caught;
      }
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(null);
    }
  }

  if (progress) return <Working text={progress} />;

  if (plan) {
    const made = new Date(plan.opened.manifest.createdAt).toLocaleString();
    return (
      <>
        <Notice
          tone="success"
          message={`Backup from ${made} checked: ${plan.verified.records} items.`}
        />
        <Text className="text-muted">
          Restoring signs your other phone out. Your contacts see that you moved to a new phone;
          your safety number stays the same.
        </Text>
        <CodeStep
          action="Restore my chats"
          onBack={() => {
            plan.opened.close();
            planRef.current = null;
            setPlan(null);
            onBack();
          }}
          onConfirm={async (otp) => {
            setProgress('Restoring your chats…');
            try {
              await replacePhone('restore', otp, plan, (done, total) =>
                setProgress(
                  `Restoring your chats… ${Math.round((done / Math.max(1, total)) * 100)}%`,
                ),
              );
              plan.opened.close();
              planRef.current = null;
            } catch (caught) {
              setProgress(null);
              throw caught;
            }
          }}
        />
      </>
    );
  }

  return (
    <>
      <Text className="text-base text-foreground">
        Choose your backup file (pingdost-backup-….pdbk), then type its 24-word recovery phrase.
      </Text>
      <ListSection>
        <ListRow
          title={picked ? picked.name : 'Choose backup file'}
          subtitle={picked ? 'Tap to choose another' : undefined}
          onPress={() => void pick()}
        />
      </ListSection>
      {picked && <PhraseInput value={phrase} onChange={setPhrase} />}
      {busy && <Working text={busy} />}
      {error && <Notice tone="error" message={error} />}
      {picked && !busy && (
        <Button
          label="Unlock backup"
          disabled={phraseProblem(phrase) !== null}
          onPress={() => void open()}
        />
      )}
      {!busy && <Button label="Back" variant="ghost" onPress={onBack} />}
    </>
  );
}

function FreshFlow({ onBack }: { onBack: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const [working, setWorking] = useState(false);
  if (working) return <Working text="Setting up new keys…" />;
  if (!confirmed) {
    return (
      <>
        <Notice
          tone="error"
          message="Starting fresh makes new encryption keys. No chat history comes back, every other device (your old phone and linked browsers) is signed out, and your contacts see that your safety number changed."
        />
        <Button
          label="I understand, start fresh"
          variant="danger"
          onPress={() =>
            Alert.alert('Start fresh?', 'Your old chats cannot be brought back afterwards.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Start fresh', style: 'destructive', onPress: () => setConfirmed(true) },
            ])
          }
        />
        <Button label="Back" variant="ghost" onPress={onBack} />
      </>
    );
  }
  return (
    <CodeStep
      action="Start fresh"
      onBack={onBack}
      onConfirm={async (otp) => {
        setWorking(true);
        try {
          await replacePhone('fresh', otp, null);
        } catch (caught) {
          setWorking(false);
          throw caught;
        }
      }}
    />
  );
}

/**
 * Shown by device setup when the account already has a phone (or its key is elsewhere). With no
 * active phone (after "Remove data", or a revoked lost phone), nobody could approve a transfer,
 * so that way is not offered.
 */
export function NewPhoneScreen({
  onLogout,
  otherPhone,
}: {
  onLogout: () => void;
  otherPhone: boolean;
}) {
  const [way, setWay] = useState<Way>('choose');
  const back = () => setWay('choose');
  const titles: Record<Way, string> = {
    choose: otherPhone ? 'Your account is on another phone' : 'Set up your account here',
    transfer: 'Approve on your other phone',
    restore: 'Restore from a backup',
    fresh: 'Start fresh',
  };
  return (
    <Screen title={titles[way]} headerless offlineBanner>
      {way === 'choose' && (
        <>
          <Text className="text-base text-foreground">
            {otherPhone
              ? 'PingDost runs on one phone per account. Choose how this phone takes over:'
              : 'This account has no phone right now. Choose how to set it up on this one:'}
          </Text>
          <ListSection>
            {otherPhone && (
              <ListRow
                title="Approve on my other phone"
                subtitle="You still have it. Chats stay on that phone."
                onPress={() => setWay('transfer')}
              />
            )}
            <ListRow
              title="Restore from a backup"
              subtitle="Your backup file and its 24-word phrase bring your chats back."
              onPress={() => setWay('restore')}
            />
            <ListRow
              title="Start fresh"
              subtitle="New keys, no history. Contacts see a new safety number."
              onPress={() => setWay('fresh')}
            />
          </ListSection>
          <Notice message={LOSS_COPY} />
          <Button label="Log out" variant="ghost" onPress={onLogout} />
        </>
      )}
      {way === 'transfer' && <TransferFlow onBack={back} />}
      {way === 'restore' && <RestoreFlow onBack={back} />}
      {way === 'fresh' && <FreshFlow onBack={back} />}
    </Screen>
  );
}
