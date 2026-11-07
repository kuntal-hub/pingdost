// One message in the web chat (REQ §8.1–8.3), like the phone's: the quoted message, the text
// or attachment, reactions, edited/deleted marks and the delivery state. Hovering shows a small
// toolbar (reply, react, more); double-clicking gives a heart. Messages this user sent from the
// phone are copies here: they show who sent them, not a delivery state this browser cannot see.
import {
  Ban,
  Check,
  CheckCheck,
  CircleAlert,
  Clock,
  Copy,
  FileText,
  Heart,
  Hourglass,
  Image,
  Info,
  Mic,
  MoreHorizontal,
  Pencil,
  Reply,
  ShieldCheck,
  SmilePlus,
  Trash2,
  Video,
  type LucideIcon,
} from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useState, type ComponentProps, type ReactNode } from 'react';

import { Menu, type MenuItem } from '@/components/ui/menu';
import { cn } from '@/lib/cn';
import { useSession } from '@/session/session';
import { useAppearance } from '@/theme';
import { formatSize } from '@pingdost/attachments';
import {
  attachmentType,
  isBigEmoji,
  previewText,
  shownState,
  stateLabel,
  systemText,
  timeLabel,
  type AttachmentKind,
  type Names,
  type StateIcon,
} from '@pingdost/chat-core';
import {
  canReact,
  parseGroupNotice,
  summarizeReactions,
  type MessageRecord,
} from '@pingdost/message-engine';
import { bubbleCorners, quickReactions, senderColor } from '@pingdost/ui-tokens';

const STATE_ICONS: Record<StateIcon, LucideIcon> = {
  pending: Clock,
  sent: Check,
  delivered: CheckCheck,
  read: CheckCheck,
  expired: Hourglass,
  failed: CircleAlert,
};

const ATTACHMENT_ICONS: Record<AttachmentKind, LucideIcon> = {
  image: Image,
  video: Video,
  audio: Mic,
  file: FileText,
};

const HEART = '❤️';

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

function ToolbarButton({
  label,
  children,
  ...props
}: { label: string; children: ReactNode } & ComponentProps<'button'>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="pd-press flex size-8 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-raised hover:text-foreground"
      {...props}
    >
      {children}
    </button>
  );
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
  first,
  last,
  fresh,
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
  /** First and last of a run of messages from one sender. */
  first: boolean;
  last: boolean;
  /** Just arrived or just sent: it animates in. */
  fresh: boolean;
}) {
  const deviceId = useSession((state) => state.device?.deviceId);
  const bubbleShape = useAppearance((state) => state.prefs.bubble);
  const dark = useAppearance((state) => state.dark);
  const compact = useAppearance((state) => state.prefs.density === 'compact');
  const [burst, setBurst] = useState(0);

  if (message.kind === 'system') {
    const safety = parseGroupNotice(message.body) === undefined;
    return (
      <div className="mx-auto my-2 flex w-fit max-w-md items-center gap-2 rounded-lg bg-surface/90 px-3 py-2 text-center text-sm font-medium text-muted">
        {safety && <ShieldCheck aria-hidden size={16} className="shrink-0 text-accent" />}
        <span>
          {safety && !isGroup
            ? 'Your safety number with this contact changed. Check it again in their contact info.'
            : systemText(message, names)}
        </span>
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
  const reactable = canReact(message) && !readOnly;
  const bigEmoji = message.kind === 'text' && !message.replyTo && isBigEmoji(message.body);
  const onBrand = outgoing && !deleted && !bigEmoji;
  const stateWords =
    status && !['sent', 'delivered', 'read'].includes(status.icon) ? status.short : undefined;
  const showMeta =
    last || status?.tone === 'danger' || edited || fromOtherDevice || stateWords !== undefined;

  const items: MenuItem[] = [];
  if (actions.canEdit(message) && !readOnly) {
    items.push({
      label: 'Edit',
      icon: Pencil,
      onSelect: () => actions.edit(message),
      shortcut: '↑',
    });
  }
  if (message.kind === 'text') {
    items.push({
      label: 'Copy text',
      icon: Copy,
      onSelect: () => void navigator.clipboard.writeText(message.body),
    });
  }
  if (outgoing && !deleted)
    items.push({ label: 'Message info', icon: Info, onSelect: () => actions.info(message) });
  items.push({
    label: 'Delete…',
    icon: Trash2,
    destructive: true,
    onSelect: () => actions.remove(message),
  });

  const body =
    message.kind === 'unsupported'
      ? 'This message needs a newer version of PingDost.'
      : deleted
        ? outgoing
          ? 'You deleted this message'
          : 'This message was deleted'
        : message.body;
  const { kind, name } = attachmentType(message);
  const AttachmentIcon = ATTACHMENT_ICONS[kind];
  const corners = bubbleCorners(bubbleShape, { outgoing, first, last });
  const StatusIcon = status ? STATE_ICONS[status.icon] : undefined;

  return (
    <div
      className={cn(
        'group relative flex w-fit max-w-[78%] flex-col gap-1 px-4',
        outgoing ? 'ml-auto items-end' : 'items-start',
        first ? 'mt-3' : compact ? 'mt-px' : 'mt-0.5',
        fresh && (outgoing ? 'pd-bubble-new-out' : 'pd-bubble-new-in'),
      )}
    >
      <div
        onDoubleClick={() => {
          if (!reactable) return;
          if (mine !== HEART) setBurst((count) => count + 1);
          actions.react(message, mine === HEART ? null : HEART);
        }}
        className={cn(
          'relative break-words whitespace-pre-wrap',
          !bigEmoji && 'px-3 py-2',
          deleted && 'border border-dashed border-border text-muted italic',
          !deleted &&
            !bigEmoji &&
            (outgoing
              ? 'bg-brand text-on-primary'
              : 'bg-bubble-in text-on-bubble-in shadow-(--pd-card-shadow)'),
          highlighted && 'pd-highlight',
        )}
        style={
          bigEmoji
            ? undefined
            : {
                borderTopLeftRadius: corners.topLeft,
                borderTopRightRadius: corners.topRight,
                borderBottomLeftRadius: corners.bottomLeft,
                borderBottomRightRadius: corners.bottomRight,
              }
        }
      >
        {isGroup && !outgoing && first && (
          <div
            className="text-sm font-bold"
            style={{ color: senderColor(message.senderUserId, dark) }}
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
              'mb-1 block w-full cursor-pointer rounded-md border-l-4 px-2 py-1 text-left text-sm',
              outgoing ? 'border-on-primary/60 bg-on-primary/10' : 'border-accent bg-accent/10',
            )}
          >
            {quoted ? (
              <>
                <span className="block font-bold">
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
              <span className="flex items-center gap-2">
                <AttachmentIcon aria-hidden size={18} />
                {name}
                {message.attachment ? ` · ${formatSize(message.attachment.plaintextSize)}` : ''}
              </span>
            )}
          </div>
        )}
        {(message.kind !== 'attachment' || deleted || message.body !== '') &&
          (bigEmoji ? (
            <span className="text-5xl leading-tight">{message.body.trim()}</span>
          ) : deleted ? (
            <span className="flex items-center gap-2">
              <Ban aria-hidden size={14} className="shrink-0" />
              {body}
            </span>
          ) : (
            <span>{body}</span>
          ))}
        {showMeta && (
          <div
            className={cn(
              'mt-0.5 flex flex-wrap items-center justify-end gap-1 text-xs',
              onBrand ? 'text-on-primary/80' : 'text-muted',
            )}
          >
            <span>{timeLabel(message.sortAt)}</span>
            {edited && <span>· edited</span>}
            {fromOtherDevice && <span>· sent from your other device</span>}
            {status &&
              StatusIcon &&
              (message.state === 'failed' ? (
                <button
                  type="button"
                  className="flex cursor-pointer items-center gap-1 font-bold text-danger underline"
                  onClick={() => actions.retry(message)}
                >
                  <StatusIcon aria-hidden size={14} /> {status.short}
                </button>
              ) : (
                <span
                  title={status.long}
                  aria-label={status.short}
                  className={cn(
                    'flex items-center gap-1',
                    status.tone === 'danger' && 'font-bold text-danger',
                  )}
                >
                  {stateWords && <span>· {stateWords}</span>}
                  <StatusIcon aria-hidden size={14} strokeWidth={2.75} />
                </span>
              ))}
          </div>
        )}
        {burst > 0 && (
          <Heart
            key={burst}
            aria-hidden
            size={36}
            fill="#FF3B6B"
            color="#FF3B6B"
            className={cn(
              'pd-heart pointer-events-none absolute top-0',
              outgoing ? '-left-3' : '-right-3',
            )}
          />
        )}
        {!deleted && (
          <div
            className={cn(
              'pd-floating absolute top-1/2 flex -translate-y-1/2 items-center rounded-full p-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100',
              outgoing ? 'right-full mr-2' : 'left-full ml-2',
            )}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            {reactable && (
              <ToolbarButton label="Reply" onClick={() => actions.reply(message)}>
                <Reply size={16} />
              </ToolbarButton>
            )}
            {reactable && (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild aria-label="React">
                  <ToolbarButton label="React">
                    <SmilePlus size={16} />
                  </ToolbarButton>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    sideOffset={6}
                    className="pd-menu pd-floating z-50 flex gap-0.5 rounded-full p-1"
                  >
                    {quickReactions.map((emoji, index) => (
                      <DropdownMenu.Item
                        key={emoji}
                        onSelect={() => {
                          if (emoji === HEART && mine !== HEART) setBurst((count) => count + 1);
                          actions.react(message, mine === emoji ? null : emoji);
                        }}
                        aria-label={mine === emoji ? `Remove ${emoji}` : `React ${emoji}`}
                        className={cn(
                          'pd-pop flex size-10 cursor-pointer items-center justify-center rounded-full text-2xl transition-transform outline-none hover:scale-125 data-[highlighted]:bg-raised',
                          mine === emoji && 'bg-accent/20',
                        )}
                        style={{ animationDelay: `${index * 25}ms` }}
                      >
                        {emoji}
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            )}
            <Menu
              label="Message actions"
              trigger={
                <ToolbarButton label="More">
                  <MoreHorizontal size={16} />
                </ToolbarButton>
              }
              items={items}
            />
          </div>
        )}
      </div>
      {reactions.length > 0 && (
        <div className="-mt-2 flex flex-wrap gap-1 px-1">
          {reactions.map((r) => (
            <button
              key={r.emoji}
              type="button"
              disabled={readOnly}
              onClick={() => actions.react(message, r.mine ? null : r.emoji)}
              aria-label={`${r.emoji} ${r.count}${r.mine ? ', yours: remove' : ''}`}
              className={cn(
                'pd-pop pd-press flex cursor-pointer items-center gap-1 rounded-full border-2 bg-surface px-2 text-sm',
                r.mine ? 'border-accent' : 'border-transparent',
              )}
            >
              {r.emoji}
              {r.count > 1 && <span className="text-xs font-bold text-muted">{r.count}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
