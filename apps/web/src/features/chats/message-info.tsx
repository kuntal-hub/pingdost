// "Message info" (REQ §8.3): the state at each recipient device. This user's own other devices
// are listed apart and never count toward "delivered".
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';

import { useNames } from '@/chat/hooks';
import { useChat, useChatClient } from '@/chat/store';
import { Card, CardTitle } from '@/components/ui/card';
import { previewText, shownState, stateLabel } from '@pingdost/chat-core';
import type { DeliveryRecord, MessageRecord } from '@pingdost/message-engine';

export function MessageInfoPage() {
  const { messageId = '' } = useParams();
  const client = useChatClient();
  const names = useNames();
  const online = useChat((state) => state.status === 'online');
  const readReceipts = useChat((state) => state.privacy?.readReceipts ?? false);
  const [info, setInfo] = useState<{
    message: MessageRecord;
    deliveries: DeliveryRecord[];
  } | null>();

  useEffect(() => {
    if (!client) return;
    void client.messageInfo(messageId).then(
      (next) => setInfo(next ?? null),
      () => setInfo(null),
    );
  }, [client, messageId]);

  if (info === undefined) return <div className="p-6 text-muted">Loading…</div>;
  if (info === null)
    return <div className="p-6 text-muted">This message is not in this browser.</div>;
  const { message, deliveries } = info;
  const label = (state: DeliveryRecord['state']) =>
    stateLabel(shownState(state, readReceipts), online);
  const theirs = deliveries.filter((d) => !d.own);
  const own = deliveries.filter((d) => d.own);

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 p-6">
      <Card className="flex flex-col gap-2">
        <CardTitle>Message info</CardTitle>
        <p className="line-clamp-3">{previewText(message, names)}</p>
        <p className="text-sm text-muted">Sent {new Date(message.sentAt).toLocaleString()}</p>
        {message.state && <p>{label(message.state).long}</p>}
      </Card>
      <Card className="flex flex-col gap-2">
        <CardTitle>Recipients&apos; devices</CardTitle>
        {theirs.length === 0 ? (
          <p className="text-muted">Not handed to any device yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {theirs.map((d) => (
              <li key={d.deviceId} className="flex justify-between gap-4">
                <span>{names.name(d.userId)}</span>
                <span className="text-muted">{label(d.state).short}</span>
              </li>
            ))}
          </ul>
        )}
        {own.length > 0 && (
          <p className="text-sm text-muted">
            Also copied to {own.length} of your other device{own.length === 1 ? '' : 's'} (they do
            not count as delivered).
          </p>
        )}
      </Card>
    </div>
  );
}
