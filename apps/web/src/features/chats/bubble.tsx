// One message in the web chat (REQ §8.1–8.3), like the phone's: the quoted message, the text
// or attachment, reactions, edited/deleted marks and the delivery state. The actions menu has
// quick reactions, reply, edit, copy, message info and delete. Messages this user sent from the
// phone are copies here: they show who sent them, not a delivery state this browser cannot see.
import { MoreHorizontal } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import type { ReactNode } from 'react';

import { Menu, type MenuItem } from '@/components/ui/menu';
import { cn } from '@/lib/cn';
import { useSession } from '@/session/session';
import { formatSize } from '@pingdost/attachments';
import {
  attachmentType,
  previewText,
  shownState,
  stateLabel,
  systemText,
  timeLabel,
  type Names,
} from '@pingdost/chat-core';
import {
  canReact,
  parseGroupNotice,
  summarizeReactions,
  type MessageRecord,
} from '@pingdost/message-engine';

import { senderColor } from './format';

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

export interface BubbleActions {
  reply(message: MessageRecord): void;
  edit(message: MessageRecord): void;
  react(message: MessageRecord, emoji: string | null): void;
  info(message: MessageRecord): void;
  remove(message: MessageRecord): void;
  retry(message: MessageRecord): void;
  jumpTo(messageId: string): void;
  canEdit(message: MessageRecord): boolean;
}

export function Bubble({
  message,
  quoted,
  names,
  isGroup,
  online,
  readReceipts,
  highlighted,
  readOnly,
  actions,
  attachment,
}: {
  message: MessageRecord;
  quoted: MessageRecord | undefined;
  names: Names;
  isGroup: boolean;
  online: boolean;
  readReceipts: boolean;
  highlighted: boolean;
  /** Blocked contact or a group this user left: no replies or reactions. */
  readOnly: boolean;
  actions: BubbleActions;
  /** The attachment's own view (Phase 18); a description otherwise. */
  attachment?: ReactNode;
}) {
  const deviceId = useSession((state) => state.device?.deviceId);

  if (message.kind === 'system') {
    const safety = parseGroupNotice(message.body) === undefined;
    return (
      <div className="mx-auto my-2 max-w-md rounded-md border border-border px-3 py-2 text-center text-sm text-muted">
        {safety && !isGroup
          ? 'Your safety number with this contact changed. Check it again in their contact info.'
          : systemText(message, names)}
      </div>
    );
  }

  const outgoing = message.direction === 'out';
  const deleted = message.kind === 'deleted';
  const fromOtherDevice =
    outgoing && message.senderDeviceId !== '' && message.senderDeviceId !== deviceId;
  const status =
    outgoing && !fromOtherDevice && message.state && !deleted
      ? stateLabel(shownState(message.state, readReceipts), online)
      : undefined;
  const edited = message.editedAt !== null && !deleted;
  const reactions = deleted ? [] : summarizeReactions(message.reactions, names.selfUserId);
  const mine = message.reactions.find((r) => r.userId === names.selfUserId)?.emoji ?? null;
  const sender = outgoing ? 'You' : isGroup ? names.name(message.senderUserId) : undefined;

  const items: MenuItem[] = [];
  if (canReact(message) && !readOnly)
    items.push({ label: 'Reply', onSelect: () => actions.reply(message) });
  if (actions.canEdit(message) && !readOnly) {
    items.push({ label: 'Edit', onSelect: () => actions.edit(message), shortcut: '↑' });
  }
  if (message.kind === 'text') {
    items.push({
      label: 'Copy text',
      onSelect: () => void navigator.clipboard.writeText(message.body),
    });
  }
  if (outgoing && !deleted)
    items.push({ label: 'Message info', onSelect: () => actions.info(message) });
  items.push({ label: 'Delete…', destructive: true, onSelect: () => actions.remove(message) });

  const body =
    message.kind === 'unsupported'
      ? 'This message needs a newer version of PingDost.'
      : deleted
        ? outgoing
          ? 'You deleted this message'
          : 'This message was deleted'
        : message.body;
  const { icon, name } = attachmentType(message);

  return (
    <div
      className={cn(
        'group my-1 flex max-w-[78%] flex-col gap-1 px-4',
        outgoing ? 'ml-auto items-end' : 'items-start',
      )}
    >
      <div
        className={cn(
          'relative rounded-lg px-3 py-2 break-words whitespace-pre-wrap',
          deleted
            ? 'border border-dashed border-border text-muted italic'
            : outgoing
              ? 'bg-primary text-on-primary'
              : 'border border-border bg-surface',
          highlighted && 'ring-2 ring-primary',
        )}
      >
        {isGroup && !outgoing && (
          <div
            className="text-sm font-semibold"
            style={{ color: senderColor(message.senderUserId) }}
          >
            {sender}
          </div>
        )}
        {message.replyTo && !deleted && (
          <button
            type="button"
            onClick={() => quoted && actions.jumpTo(quoted.messageId)}
            disabled={!quoted}
            className={cn(
              'mb-1 block w-full rounded border-l-4 px-2 py-1 text-left text-sm',
              outgoing ? 'border-on-primary/60 bg-on-primary/10' : 'border-primary bg-primary/10',
            )}
          >
            {quoted ? (
              <>
                <span className="block font-semibold">
                  {quoted.senderUserId === names.selfUserId
                    ? 'You'
                    : names.name(quoted.senderUserId)}
                </span>
                <span className="line-clamp-2">{previewText(quoted, names)}</span>
              </>
            ) : (
              <span className="italic">Original message not available</span>
            )}
          </button>
        )}
        {message.kind === 'attachment' && !deleted && (
          <div className="mb-1">
            {attachment ?? (
              <span>
                {icon} {name}
                {message.attachment ? ` · ${formatSize(message.attachment.plaintextSize)}` : ''}
              </span>
            )}
          </div>
        )}
        {(message.kind !== 'attachment' || deleted || message.body !== '') && (
          <span>{deleted ? `🚫 ${body}` : body}</span>
        )}
        {!deleted && (
          <div
            className={cn(
              'absolute top-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100',
              outgoing ? '-left-9' : '-right-9',
            )}
          >
            <Menu
              label="Message actions"
              trigger={
                <button type="button" className="rounded p-1.5 text-muted hover:bg-surface">
                  <MoreHorizontal size={16} />
                </button>
              }
              header={
                canReact(message) && !readOnly ? (
                  <div
                    className="flex gap-1 border-b border-border p-1"
                    role="group"
                    aria-label="React"
                  >
                    {QUICK_REACTIONS.map((emoji) => (
                      <DropdownMenu.Item
                        key={emoji}
                        onSelect={() => actions.react(message, mine === emoji ? null : emoji)}
                        aria-label={mine === emoji ? `Remove ${emoji}` : `React ${emoji}`}
                        className={cn(
                          'cursor-pointer rounded p-1 text-xl outline-none data-[highlighted]:bg-primary/15',
                          mine === emoji && 'bg-primary/20',
                        )}
                      >
                        {emoji}
                      </DropdownMenu.Item>
                    ))}
                  </div>
                ) : undefined
              }
              items={items}
            />
          </div>
        )}
      </div>
      {reactions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {reactions.map((r) => (
            <button
              key={r.emoji}
              type="button"
              disabled={readOnly}
              onClick={() => actions.react(message, r.mine ? null : r.emoji)}
              aria-label={`${r.emoji} ${r.count}${r.mine ? ', yours: remove' : ''}`}
              className={cn(
                'flex items-center gap-1 rounded-full border px-2 text-sm',
                r.mine ? 'border-primary bg-primary/15' : 'border-border bg-surface',
              )}
            >
              {r.emoji}
              {r.count > 1 && <span className="text-muted">{r.count}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-1 text-xs text-muted">
        <span>{timeLabel(message.sortAt)}</span>
        {edited && <span>· edited</span>}
        {fromOtherDevice && <span>· sent from your other device</span>}
        {status &&
          (message.state === 'failed' ? (
            <button
              type="button"
              className="text-danger underline"
              onClick={() => actions.retry(message)}
            >
              · {status.glyph} {status.short}
            </button>
          ) : (
            <span
              title={status.long}
              className={status.tone === 'danger' ? 'text-danger' : undefined}
            >
              · {status.glyph} {status.short}
            </span>
          ))}
      </div>
    </div>
  );
}
