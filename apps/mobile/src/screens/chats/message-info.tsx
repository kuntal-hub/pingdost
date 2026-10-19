import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { ListRow, ListSection } from '@/components/list-row';
import { Notice } from '@/components/notice';
import { Screen } from '@/components/screen';
import { useChatRuntime, useConnectionStatus } from '@/engine/hooks';
import { stateLabel } from '@/engine/labels';
import { dayLabel, timeLabel } from '@/engine/timeline';
import type { DeliveryRecord, MessageRecord } from '@pingdost/message-engine';

function at(ms: number): string {
  return `${dayLabel(ms)}, ${timeLabel(ms)}`;
}

/** "Message info": the message state and what each device reported (REQ §8.3). */
export function MessageInfoScreen({ messageId }: { messageId: string }) {
  const runtime = useChatRuntime();
  const online = useConnectionStatus() === 'online';
  const [info, setInfo] = useState<{
    message: MessageRecord;
    deliveries: DeliveryRecord[];
  } | null>();

  useEffect(() => {
    if (!runtime) return;
    let live = true;
    const load = () =>
      void runtime.engine.messageInfo(messageId).then((next) => live && setInfo(next ?? null));
    load();
    // Receipts can arrive while this is open.
    const unsubscribe = runtime.engine.onConversationListChanged(load);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [runtime, messageId]);

  if (info === null)
    return (
      <Screen>
        <Notice message="This message is no longer on this device." />
      </Screen>
    );
  if (!info)
    return (
      <Screen>
        <Text className="text-muted">Loading…</Text>
      </Screen>
    );

  const { message, deliveries } = info;
  const label = message.state ? stateLabel(message.state, online) : undefined;
  const recipients = deliveries.filter((d) => !d.own);
  const own = deliveries.filter((d) => d.own);
  return (
    <Screen>
      <View className="rounded-lg border border-border bg-surface p-4">
        <Text className="text-base text-foreground">{message.body}</Text>
      </View>
      <ListSection title="Details">
        <ListRow
          title={message.direction === 'out' ? 'Sent' : 'Received'}
          subtitle={at(message.sortAt)}
        />
        {label && <ListRow title={label.short} subtitle={label.long} />}
        {message.direction === 'in' && (
          <ListRow title="Encrypted end to end" subtitle="Decrypted only on this device." />
        )}
      </ListSection>
      {recipients.length > 0 && (
        <ListSection title="Recipient's devices">
          {recipients.map((d, index) => (
            <ListRow
              key={d.deviceId}
              title={`Device ${index + 1}: ${stateLabel(d.state, online).short}`}
              subtitle={`${stateLabel(d.state, online).long} Updated ${at(d.updatedAt)}.`}
            />
          ))}
        </ListSection>
      )}
      {own.length > 0 && (
        <ListSection title="Your other devices">
          {own.map((d) => (
            <ListRow
              key={d.deviceId}
              title={stateLabel(d.state, online).short}
              subtitle="A copy for your linked device. It never counts as delivery."
            />
          ))}
        </ListSection>
      )}
      {message.direction === 'out' && recipients.length === 0 && (
        <Notice message="The recipient's devices are not known yet. The message stays queued on this phone until they are." />
      )}
    </Screen>
  );
}
