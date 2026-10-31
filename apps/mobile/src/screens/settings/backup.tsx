// Settings → Backup (REQ §6.3, ADR 0022): opt-in, explained in plain words. Setting up shows
// a new 24-word phrase once and checks three of its words; every backup after that reuses it.
// The file is made on the phone and saved where the user chooses; PingDost never gets it.
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Switch, Text, View } from 'react-native';

import {
  BackupUnavailableError,
  createBackup,
  discardCachedBackup,
  filesSize,
  saveToFolder,
  shareBackup,
  type CreatedBackup,
} from '@/backup/create';
import { hasPhrase, loadPhraseEntropy, savePhrase } from '@/backup/phrase';
import { REMINDER_DAYS, useBackupPrefs } from '@/backup/prefs';
import { Button } from '@/components/button';
import { ListRow, ListSection } from '@/components/list-row';
import { Notice } from '@/components/notice';
import { PhraseGrid, SECRET_INPUT } from '@/components/phrase';
import { Screen } from '@/components/screen';
import { TextField } from '@/components/text-field';
import { usePalette } from '@/theme/theme-root';
import { generatePhrase, quizPositions, type ExportCounts } from '@pingdost/backup';

type Step =
  | { name: 'overview' }
  | { name: 'phrase'; words: string[] }
  | { name: 'quiz'; words: string[]; positions: number[] }
  | { name: 'working'; counts: ExportCounts | null }
  | { name: 'done'; backup: CreatedBackup; saved: boolean };

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

const LOSS_COPY =
  'If you lose all devices and have no backup, your chat history cannot be recovered. ' +
  'PingDost cannot restore it.';

export function BackupScreen() {
  const palette = usePalette();
  const prefs = useBackupPrefs((state) => state.prefs);
  const [step, setStep] = useState<Step>({ name: 'overview' });
  const [phraseSet, setPhraseSet] = useState<boolean | null>(null);
  const [includeFiles, setIncludeFiles] = useState(false);
  const [mediaBytes, setMediaBytes] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<string[]>([]);

  useFocusEffect(
    useCallback(() => {
      void useBackupPrefs
        .getState()
        .load()
        .catch(() => undefined);
      void hasPhrase().then(setPhraseSet, () => setPhraseSet(false));
      void filesSize().then(setMediaBytes, () => setMediaBytes(null));
    }, []),
  );

  // The phrase lives only in this screen's state; leaving the screen forgets it.
  useEffect(() => () => discardCachedBackup(), []);

  async function run(): Promise<void> {
    setError(null);
    setStep({ name: 'working', counts: null });
    // Let the spinner draw before the key derivation holds the JS thread for a moment.
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      const entropy = await loadPhraseEntropy();
      if (!entropy) throw new Error('Set up a recovery phrase first.');
      const backup = await createBackup(entropy, {
        includeFiles,
        onProgress: (counts) => setStep({ name: 'working', counts: { ...counts } }),
      });
      entropy.fill(0);
      setStep({ name: 'done', backup, saved: false });
    } catch (caught) {
      setError(
        caught instanceof BackupUnavailableError
          ? caught.message
          : 'The backup could not be made. Check the free space and try again.',
      );
      setStep({ name: 'overview' });
    }
  }

  function startSetup(): void {
    setError(null);
    setStep({ name: 'phrase', words: generatePhrase() });
  }

  function confirmNewPhrase(): void {
    Alert.alert(
      'Make a new recovery phrase?',
      'New backups will use the new phrase. Older backup files still open only with the old one.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'New phrase', onPress: startSetup },
      ],
    );
  }

  async function checkQuiz(words: string[], positions: number[]): Promise<void> {
    const right = positions.every(
      (position, i) => (answers[i] ?? '').trim().toLowerCase() === words[position],
    );
    if (!right) {
      setError('Those words do not match. Check what you wrote down, or look at the words again.');
      return;
    }
    await savePhrase(words);
    setPhraseSet(true);
    setAnswers([]);
    await run();
  }

  if (step.name === 'phrase') {
    return (
      <Screen title="Your recovery phrase">
        <Text className="text-base text-foreground">
          Write these 24 words on paper, in order, and keep them somewhere safe. With the backup
          file, they open your chats on a new phone.
        </Text>
        <PhraseGrid words={step.words} />
        <Notice
          tone="error"
          message="Anyone with these words and a backup file can read your chats. Do not take a screenshot, copy them, or share them. PingDost never sees them and cannot show them again."
        />
        <Button
          label="I wrote them down"
          onPress={() => setStep({ name: 'quiz', words: step.words, positions: quizPositions(3) })}
        />
        <Button label="Cancel" variant="ghost" onPress={() => setStep({ name: 'overview' })} />
      </Screen>
    );
  }

  if (step.name === 'quiz') {
    return (
      <Screen title="Check your phrase">
        <Text className="text-base text-foreground">Type these words from your paper.</Text>
        {step.positions.map((position, i) => (
          <TextField
            key={position}
            label={`Word ${position + 1}`}
            value={answers[i] ?? ''}
            onChangeText={(text) =>
              setAnswers((current) => {
                const next = [...current];
                next[i] = text;
                return next;
              })
            }
            {...SECRET_INPUT}
          />
        ))}
        {error && <Notice tone="error" message={error} />}
        <Button
          label="Check and make the backup"
          onPress={() => void checkQuiz(step.words, step.positions)}
        />
        <Button
          label="Show the words again"
          variant="ghost"
          onPress={() => {
            setError(null);
            setStep({ name: 'phrase', words: step.words });
          }}
        />
      </Screen>
    );
  }

  if (step.name === 'working') {
    const counts = step.counts;
    return (
      <Screen title="Making your backup">
        <View className="flex-row items-center gap-3" accessibilityLiveRegion="polite">
          <ActivityIndicator color={palette.primary} />
          <Text className="flex-1 text-base text-foreground">
            {counts
              ? `${counts.messages} messages in ${counts.conversations} chats` +
                (counts.files ? `, ${counts.files} files` : '')
              : 'Encrypting on this phone…'}
          </Text>
        </View>
      </Screen>
    );
  }

  if (step.name === 'done') {
    const { backup, saved } = step;
    const save = async (how: 'folder' | 'share') => {
      setError(null);
      try {
        if (how === 'folder') {
          if (!(await saveToFolder(backup))) return;
          setStep({ name: 'done', backup, saved: true });
        } else {
          await shareBackup(backup);
          setStep({ name: 'done', backup, saved: true });
        }
      } catch {
        setError(
          how === 'folder'
            ? 'The file could not be saved there. Try another folder, or Share.'
            : 'Sharing did not work. Try Save to a folder.',
        );
      }
    };
    return (
      <Screen title="Backup ready">
        <Text className="text-base text-foreground">
          {backup.file.name} · {formatBytes(backup.bytes)} · {backup.counts.messages} messages
          {backup.counts.files ? ` · ${backup.counts.files} files` : ''}
        </Text>
        <Text className="text-muted">
          Keep the file off this phone, e.g. on a computer, a USB drive or your own cloud storage.
          It is encrypted with your recovery phrase.
        </Text>
        {saved && <Notice tone="success" message="Saved. Keep your recovery phrase separately." />}
        {error && <Notice tone="error" message={error} />}
        <Button label="Save to a folder" onPress={() => void save('folder')} />
        <Button label="Share…" variant="secondary" onPress={() => void save('share')} />
        <Button
          label="Done"
          variant="ghost"
          onPress={() => {
            discardCachedBackup();
            setStep({ name: 'overview' });
          }}
        />
      </Screen>
    );
  }

  const last = prefs?.lastBackupAt
    ? `Last backup ${new Date(prefs.lastBackupAt).toLocaleDateString()}` +
      (prefs.lastBackupBytes ? ` (${formatBytes(prefs.lastBackupBytes)})` : '')
    : 'No backup yet';

  return (
    <Screen>
      <Text className="text-base text-foreground">
        A backup is an encrypted file with your chats, your contacts&apos; verified keys and your
        account key. You keep it; PingDost never receives a copy. With the file and your 24-word
        recovery phrase you can move to a new phone.
      </Text>
      <Notice message={LOSS_COPY} />
      {error && <Notice tone="error" message={error} />}

      <ListSection title="Status">
        <ListRow title={last} />
        <ListRow
          title="Include photos and files"
          subtitle={
            mediaBytes === null
              ? 'Makes the backup larger'
              : `Adds about ${formatBytes(mediaBytes)} to the backup`
          }
          accessory={
            <Switch
              accessibilityLabel="Include photos and files"
              value={includeFiles}
              onValueChange={setIncludeFiles}
            />
          }
        />
        <ListRow
          title="Monthly reminder"
          subtitle={`A notification ${REMINDER_DAYS} days after the last backup`}
          accessory={
            <Switch
              accessibilityLabel="Monthly reminder"
              value={prefs?.reminder ?? false}
              onValueChange={(reminder) =>
                void useBackupPrefs
                  .getState()
                  .update({ reminder })
                  .catch(() => undefined)
              }
            />
          }
        />
      </ListSection>

      {phraseSet === null ? null : phraseSet ? (
        <>
          <Button label="Back up now" onPress={() => void run()} />
          <Button label="Make a new recovery phrase" variant="ghost" onPress={confirmNewPhrase} />
        </>
      ) : (
        <Button label="Set up backups" onPress={startSetup} />
      )}
    </Screen>
  );
}
