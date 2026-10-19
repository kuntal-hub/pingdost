import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { api } from '@/api';
import { describeError } from '@/api/errors';
import { Button } from '@/components/button';
import { ListSection } from '@/components/list-row';
import { Notice } from '@/components/notice';
import { Screen } from '@/components/screen';
import { useBlocks, useIsBlocked } from '@/engine/blocks';
import { contactName } from '@/engine/contacts';
import { useChatRuntime, useContact } from '@/engine/hooks';
import { timeLabel, dayLabel } from '@/engine/timeline';
import { usePalette } from '@/theme/theme-root';
import type { MessageRecord } from '@pingdost/message-engine';
import { directConversationIdFor } from '@pingdost/protocol';
import { MAX_REPORT_MESSAGES, type ReportReason } from '@pingdost/shared-types';

const REASONS: { value: ReportReason; label: string }[] = [
  { value: 'spam', label: 'Spam or scam' },
  { value: 'harassment', label: 'Harassment or threats' },
  { value: 'impersonation', label: 'Pretending to be someone else' },
  { value: 'illegal_content', label: 'Illegal content' },
  { value: 'other', label: 'Something else' },
];

/** Messages offered for attaching (the most recent ones). */
const OFFERED = 30;

function Choice({
  label,
  detail,
  checked,
  role,
  onPress,
}: {
  label: string;
  detail?: string;
  checked: boolean;
  role: 'radio' | 'checkbox';
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityState={{ checked }}
      accessibilityLabel={detail ? `${label}. ${detail}` : label}
      onPress={onPress}
      className="min-h-[52px] flex-row items-center gap-3 px-4 py-3 active:opacity-70"
    >
      <Text importantForAccessibility="no" className="text-xl text-primary">
        {role === 'radio' ? (checked ? '◉' : '○') : checked ? '☑' : '☐'}
      </Text>
      <View className="flex-1">
        <Text numberOfLines={3} className="text-base text-foreground">
          {label}
        </Text>
        {detail && <Text className="text-muted">{detail}</Text>}
      </View>
    </Pressable>
  );
}

/**
 * Reports a user (REQ §15). PingDost cannot read chats, so a report carries only what the
 * user puts in it here; attached messages are sent readable, by the user's choice.
 */
export function ReportScreen({ userId }: { userId: string }) {
  const router = useRouter();
  const palette = usePalette();
  const runtime = useChatRuntime();
  const contact = useContact(userId);
  const alreadyBlocked = useIsBlocked(userId);
  const name = contactName(contact);
  const [reason, setReason] = useState<ReportReason>();
  const [details, setDetails] = useState('');
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [alsoBlock, setAlsoBlock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!runtime) return;
    const conversationId = directConversationIdFor(runtime.userId, userId);
    void runtime.engine
      .listMessages(conversationId, { limit: OFFERED })
      .then((page) => setMessages(page.filter((m) => m.kind === 'text')));
  }, [runtime, userId]);

  function toggle(messageId: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(messageId)) next.delete(messageId);
      else if (next.size < MAX_REPORT_MESSAGES) next.add(messageId);
      return next;
    });
  }

  async function submit() {
    if (!reason) return;
    setBusy(true);
    setError(null);
    try {
      await api.security.report({
        reportedUserId: userId,
        reason,
        ...(details.trim() ? { details: details.trim() } : {}),
        messages: messages
          .filter((m) => picked.has(m.messageId))
          .map((m) => ({
            messageId: m.messageId,
            senderUserId: m.senderUserId,
            sentAt: m.sentAt,
            text: m.body,
          })),
      });
      if (alsoBlock && !alreadyBlocked) await useBlocks.getState().block(userId);
      setDone(true);
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Screen>
        <Notice
          tone="success"
          message={`Thank you. Your report about ${name} was sent${alsoBlock && !alreadyBlocked ? ` and ${name} is blocked` : ''}.`}
        />
        <Button label="Done" onPress={() => router.back()} />
      </Screen>
    );
  }

  return (
    <Screen
      title={`Report ${name}`}
      subtitle="PingDost cannot read your chats. A report holds only what you add here, and is deleted after 90 days. They are not told who reported them."
    >
      <ListSection title="What is wrong?">
        {REASONS.map((option) => (
          <Choice
            key={option.value}
            role="radio"
            label={option.label}
            checked={reason === option.value}
            onPress={() => setReason(option.value)}
          />
        ))}
      </ListSection>

      <View className="gap-2">
        <Text className="font-semibold text-muted">Anything else (optional)</Text>
        <TextInput
          accessibilityLabel="Details"
          value={details}
          onChangeText={setDetails}
          maxLength={1_000}
          multiline
          placeholder="What happened?"
          placeholderTextColor={palette.muted}
          className="min-h-[88px] rounded-lg border border-border bg-surface px-3 py-2 text-base text-foreground"
        />
      </View>

      <ListSection title={`Attach messages (optional, up to ${MAX_REPORT_MESSAGES})`}>
        <Text className="px-4 pt-3 text-muted">
          Messages you tick are sent to PingDost in readable form, so they can be reviewed. Nothing
          is attached unless you tick it.
        </Text>
        {messages.length === 0 ? (
          <Text className="px-4 py-3 text-muted">No messages on this phone to attach.</Text>
        ) : (
          messages.map((message) => (
            <Choice
              key={message.messageId}
              role="checkbox"
              label={`${message.senderUserId === runtime?.userId ? 'You' : name}: ${message.body}`}
              detail={`${dayLabel(message.sortAt)} ${timeLabel(message.sortAt)}`}
              checked={picked.has(message.messageId)}
              onPress={() => toggle(message.messageId)}
            />
          ))
        )}
      </ListSection>

      {!alreadyBlocked && (
        <ListSection>
          <Choice
            role="checkbox"
            label={`Also block ${name}`}
            detail="They can't message you or see when you're online. They aren't told."
            checked={alsoBlock}
            onPress={() => setAlsoBlock((value) => !value)}
          />
        </ListSection>
      )}

      {error && <Notice tone="error" message={error} />}
      <Button
        label="Send report"
        variant="danger"
        loading={busy}
        disabled={!reason}
        onPress={() => void submit()}
      />
    </Screen>
  );
}
