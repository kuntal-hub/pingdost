import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import {
  AccessibilityInfo,
  Alert,
  BackHandler,
  Text as NativeText,
  type TextInput as NativeTextInput,
  Pressable,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  KeyboardController,
  KeyboardEvents,
  useKeyboardHandler,
} from 'react-native-keyboard-controller';
import Animated, {
  FadeInDown,
  FadeOutDown,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { pick, PickError, usePendingSend, type PickSource } from '@/attachments/pick';
import { makeDraft, SendError, sendDraft } from '@/attachments/send';
import { callActionsFor } from '@/calls/logic';
import { dial, useCalls } from '@/calls/runtime';
import { ActionSheet, type SheetAction } from '@/components/action-sheet';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/button';
import { EmptyState, TypingDots } from '@/components/feedback';
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  BadgeCheckIcon,
  BanIcon,
  CameraIcon,
  FileTextIcon,
  HeartIcon,
  Icon,
  ImageIcon,
  InfoIcon,
  KeyboardIcon,
  LockIcon,
  MicIcon,
  PencilIcon,
  PhoneIcon,
  PlusIcon,
  ReplyIcon,
  SearchIcon,
  SendIcon,
  ShieldCheckIcon,
  SmileIcon,
  Trash2Icon,
  VideoIcon,
  XIcon,
  type LucideIcon,
} from '@/components/icon';
import { IconButton } from '@/components/icon-button';
import { OfflineBanner } from '@/components/offline-banner';
import { StatusBarBand } from '@/components/screen';
import { StateTick } from '@/components/state-tick';
import { SwipeAction } from '@/components/swipe-action';
import { Tap } from '@/components/tap';
import { Text, TextInput } from '@/components/text';
import { Wallpaper } from '@/components/wallpaper';
import { useBlocks, useIsBlocked } from '@/engine/blocks';
import { contactName } from '@/engine/contacts';
import { groupPictureUri, useGroup, useNames } from '@/engine/groups';
import {
  useChatRuntime,
  useConnectionStatus,
  useContact,
  useConversation,
  usePresence,
  useQuoted,
  useReadReceipts,
  takeJump,
} from '@/engine/hooks';
import {
  attachmentType,
  isBigEmoji,
  isSafetyNumberChange,
  previewText,
  shownState,
  startsRightToLeft,
  stateLabel,
  systemText,
  type Names,
} from '@/engine/labels';
import { watchPresence } from '@/engine/runtime';
import { timeLabel, type TimelineItem } from '@/engine/timeline';
import { useNearbyPeer } from '@/nearby/service';
import { dismissChatNotification } from '@/push/notifications';
import { useAppearance } from '@/theme/appearance';
import { CSS_EASE_OUT, CSS_POP, haptic, useMotion } from '@/theme/motion';
import { useTheme } from '@/theme/theme-root';
import { formatSize } from '@pingdost/attachments';
import { isAtEnd, newestMark, unseenCount, unseenLabel, type SeenMark } from '@pingdost/chat-core';
import { deleteBefore, insertAt } from '@pingdost/chat-core/emoji';
import {
  canReact,
  MessageActionError,
  summarizeReactions,
  type ConversationRecord,
  type MessageRecord,
} from '@pingdost/message-engine';
import {
  brandGradient,
  bubbleCorners,
  quickReactions,
  senderColor,
  textScales,
  typeScale,
} from '@pingdost/ui-tokens';

import { AttachmentContent } from './attachment-bubble';
import { EmojiPanel } from './emoji-panel';
import { VoiceRecorder, type VoiceNote } from './voice-recorder';

/** Longest message; far inside one envelope even in 4-byte UTF-8. */
const MAX_TEXT = 4_000;
/** A second tap this soon after the first is a double tap. */
const DOUBLE_TAP_MS = 280;
/** Messages this far apart start a new run, even from the same sender. */
const RUN_GAP_MS = 5 * 60_000;

/** What an attachment bubble reads as: what it is and how big, then its caption. */
function attachmentBody(message: MessageRecord): string {
  const { name } = attachmentType(message);
  const size = message.attachment ? ` · ${formatSize(message.attachment.plaintextSize)}` : '';
  return `${name}${size}${message.body ? `\n${message.body}` : ''}`;
}

const PICK_ACTIONS: { source: PickSource; label: string; detail: string; icon: LucideIcon }[] = [
  { source: 'library', label: 'Gallery', detail: 'Photo or video', icon: ImageIcon },
  { source: 'photo', label: 'Photo', detail: 'Take one now', icon: CameraIcon },
  { source: 'video', label: 'Video', detail: 'Record one now', icon: VideoIcon },
  { source: 'document', label: 'Document', detail: 'Any file up to 100 MB', icon: FileTextIcon },
];

function failed(action: string, error: unknown): void {
  haptic('error');
  const reason =
    error instanceof MessageActionError && error.code === 'not_allowed'
      ? 'It can no longer be changed (only your own messages, within 24 hours of sending).'
      : 'Please try again.';
  Alert.alert(`Could not ${action}`, reason);
}

/** The identity part of the header: tap for contact info. */
function PeerIdentity({ peerUserId }: { peerUserId: string | undefined }) {
  const router = useRouter();
  const contact = useContact(peerUserId);
  const online = usePresence(peerUserId);
  const nearby = useNearbyPeer(peerUserId);
  const runtime = useChatRuntime();
  const [verified, setVerified] = useState(false);
  const name = contactName(contact);

  useFocusEffect(
    useCallback(() => {
      if (!runtime || !peerUserId) return;
      void runtime.engine.contact(peerUserId).then((info) => setVerified(info.verified));
    }, [runtime, peerUserId]),
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}${verified ? ', verified' : ''}${online ? ', online' : ''}${nearby ? ', nearby over Bluetooth' : ''}. Contact info`}
      disabled={!peerUserId}
      onPress={() =>
        peerUserId && router.push({ pathname: '/contact/[userId]', params: { userId: peerUserId } })
      }
      className="min-h-[44px] flex-1 flex-row items-center gap-2 active:opacity-70"
    >
      <Avatar url={contact?.avatarUrl} name={name} size={38} online={online} />
      <View className="flex-1">
        <View className="flex-row items-center gap-1">
          <Text numberOfLines={1} className="shrink font-bold text-foreground">
            {name}
          </Text>
          {verified && <Icon icon={BadgeCheckIcon} size={15} color="accent" />}
        </View>
        {(online || nearby) && (
          <Text numberOfLines={1} className="text-xs font-semibold text-success">
            {[online ? 'online' : null, nearby ? 'nearby · Bluetooth' : null]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

function GroupIdentity({ groupId }: { groupId: string }) {
  const router = useRouter();
  const group = useGroup(groupId);
  const name = group?.name || 'Group';
  const subtitle = !group
    ? ''
    : group.left
      ? "You're not a member"
      : `${group.members.length} member${group.members.length === 1 ? '' : 's'}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${subtitle}. Group info`}
      onPress={() => router.push({ pathname: '/group/[groupId]', params: { groupId } })}
      className="min-h-[44px] flex-1 flex-row items-center gap-2 active:opacity-70"
    >
      <Avatar url={groupPictureUri(group?.avatar)} name={name} size={38} />
      <View className="flex-1">
        <Text numberOfLines={1} className="font-bold text-foreground">
          {name}
        </Text>
        {subtitle !== '' && (
          <Text numberOfLines={1} className="text-xs text-muted">
            {subtitle}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

/** The message a reply quotes, or why it cannot be shown. */
function Quote({
  replyTo,
  conversationId,
  loaded,
  names,
  outgoing,
  onPress,
}: {
  replyTo: string;
  conversationId: string;
  loaded: ReadonlyMap<string, MessageRecord>;
  names: (message: MessageRecord) => string;
  outgoing: boolean;
  onPress: (messageId: string) => void;
}) {
  const quoted = useQuoted(replyTo, conversationId, loaded);
  const text = quoted ? previewText(quoted) : 'Original message not available';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={quoted ? `Reply to ${names(quoted)}: ${text}` : text}
      disabled={!quoted}
      onPress={() => quoted && onPress(quoted.messageId)}
      className={`mb-1 rounded-md border-l-4 px-2 py-1 ${
        outgoing ? 'border-on-primary/60 bg-on-primary/10' : 'border-accent bg-accent/10'
      }`}
    >
      {quoted && (
        <Text
          numberOfLines={1}
          className={`font-bold ${outgoing ? 'text-on-primary' : 'text-accent'}`}
        >
          {names(quoted)}
        </Text>
      )}
      <Text
        numberOfLines={2}
        className={`${outgoing ? 'text-on-primary' : 'text-on-bubble-in'} ${quoted ? '' : 'italic'}`}
      >
        {text}
      </Text>
    </Pressable>
  );
}

const REACTION_POP = {
  from: { transform: [{ scale: 0.5 }], opacity: 0 },
  to: { transform: [{ scale: 1 }], opacity: 1 },
};

function Reactions({
  message,
  selfUserId,
  onToggle,
}: {
  message: MessageRecord;
  selfUserId: string;
  onToggle: (emoji: string, mine: boolean) => void;
}) {
  const { palette, card, prefs } = useTheme();
  const { moves } = useMotion();
  const summary = summarizeReactions(message.reactions, selfUserId);
  if (summary.length === 0) return null;
  return (
    <View
      className={`-mt-2 flex-row flex-wrap gap-1 px-2 ${message.direction === 'out' ? 'justify-end' : ''}`}
    >
      {summary.map((reaction) => (
        <Animated.View
          key={`${reaction.emoji}${reaction.count}`}
          style={
            moves
              ? {
                  animationName: REACTION_POP,
                  animationDuration: 240,
                  animationTimingFunction: CSS_POP,
                }
              : undefined
          }
        >
          <Tap
            accessibilityLabel={`${reaction.emoji} ${reaction.count}${reaction.mine ? ', yours. Double tap to remove' : ''}`}
            feedback="selection"
            scaleTo={0.85}
            onPress={() => onToggle(reaction.emoji, reaction.mine)}
            className="min-h-[30px] flex-row items-center gap-1 rounded-full px-2"
            style={
              reaction.mine
                ? {
                    backgroundColor: palette.raised,
                    borderWidth: prefs.look === 'sticker' ? 2 : 1.5,
                    borderColor: palette.accent,
                  }
                : { backgroundColor: palette.surface, ...card, boxShadow: 'none' }
            }
          >
            <Text className="text-base">{reaction.emoji}</Text>
            {reaction.count > 1 && (
              <Text className="text-xs font-bold text-muted">{reaction.count}</Text>
            )}
          </Tap>
        </Animated.View>
      ))}
    </View>
  );
}

const BUBBLE_IN = {
  from: { transform: [{ translateY: 14 }, { scale: 0.92 }], opacity: 0 },
  to: { transform: [{ translateY: 0 }, { scale: 1 }], opacity: 1 },
};

const HEART_BURST = {
  '0%': { transform: [{ scale: 0.4 }, { translateY: 0 }], opacity: 0 },
  '25%': { transform: [{ scale: 1.25 }, { translateY: -6 }], opacity: 1 },
  '60%': { transform: [{ scale: 1 }, { translateY: -14 }], opacity: 1 },
  '100%': { transform: [{ scale: 1.1 }, { translateY: -34 }], opacity: 0 },
};

/** A heart that jumps out of a double-tapped bubble. */
function HeartBurst({ outgoing }: { outgoing: boolean }) {
  return (
    <Animated.View
      pointerEvents="none"
      importantForAccessibility="no"
      className={`absolute top-0 ${outgoing ? 'left-0' : 'right-0'}`}
      style={{
        animationName: HEART_BURST,
        animationDuration: 650,
        animationFillMode: 'both',
        animationTimingFunction: CSS_EASE_OUT,
      }}
    >
      <Icon icon={HeartIcon} size={36} color="#FF3B6B" filled />
    </Animated.View>
  );
}

/** Room for the state tick (14 + the 4 gap) in no-break spaces at the time's size. */
const TICK_ROOM = '\u{00A0}'.repeat(6);
const INVISIBLE = '#FFFFFF01';

/**
 * Invisible text at the end of a message, as wide as its time and tick (Phase 35). If it fits on
 * the last line, the time drawn over it sits beside the text; if not, it wraps to a line of its
 * own and the time sits under the text. No measuring needed. The leading normal space is the
 * only place it may break.
 */
function MetaSpacer({ text, tick }: { text: string; tick: boolean }) {
  const scale = useAppearance((state) => textScales[state.prefs.textSize]);
  return (
    <NativeText
      accessible={false}
      // Not 'transparent': on Android (Fabric) a nested span's colour 0 counts as unset and the
      // text shows in the default colour. Alpha 1/255 is invisible and non-zero.
      style={{ fontSize: Math.round(typeScale.xs[0] * scale), color: INVISIBLE }}
    >
      {` \u{00A0}\u{00A0}${text.replace(/ /g, '\u{00A0}')}${tick ? TICK_ROOM : ''}`}
    </NativeText>
  );
}

/** A message's time, "edited", unusual states in words, and its state tick. */
function MessageMeta({
  text,
  status,
  onBrand,
  overlay,
  className = '',
}: {
  text: string;
  status: ReturnType<typeof stateLabel> | undefined;
  onBrand: boolean;
  /** Drawn over the spacer at the end of the last line. */
  overlay: boolean;
  className?: string;
}) {
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      className={`flex-row items-center justify-end gap-1 ${
        overlay ? 'absolute bottom-0 right-0' : ''
      } ${className}`}
    >
      <Text className={`text-xs ${onBrand ? 'text-on-primary/80' : 'text-muted'}`}>{text}</Text>
      {status && <StateTick icon={status.icon} size={14} onBrand={onBrand} />}
    </View>
  );
}

interface BubbleProps {
  message: MessageRecord;
  online: boolean;
  readReceipts: boolean;
  /** Group chats show who wrote each incoming message. */
  isGroup: boolean;
  people: Names;
  selfUserId: string;
  loaded: ReadonlyMap<string, MessageRecord>;
  names: (message: MessageRecord) => string;
  highlighted: boolean;
  /** First and last of a run of messages from one sender. */
  first: boolean;
  last: boolean;
  /** Just arrived or just sent: it animates in. */
  fresh: boolean;
  /** Replies are off for a blocked contact or a group this user left. */
  readOnly: boolean;
  onLongPress: (message: MessageRecord) => void;
  onQuotePress: (messageId: string) => void;
  onReact: (message: MessageRecord, emoji: string | null) => void;
  onReply: (message: MessageRecord) => void;
}

function SystemNotice({
  message,
  isGroup,
  people,
}: Pick<BubbleProps, 'message' | 'isGroup' | 'people'>) {
  const router = useRouter();
  // Group events and "moved to a new phone" are just told; a changed safety number links to
  // that person.
  const safety = isSafetyNumberChange(message);
  const userId = message.senderUserId;
  return (
    <Pressable
      accessibilityRole={safety ? 'button' : 'text'}
      disabled={!safety}
      onPress={() => router.push({ pathname: '/contact/[userId]', params: { userId } })}
      className="mx-6 my-2 flex-row items-center justify-center gap-2 self-center rounded-lg bg-surface/90 px-3 py-2"
    >
      {safety && <Icon icon={ShieldCheckIcon} size={16} color="accent" />}
      <Text className="shrink text-center text-xs font-semibold text-muted">
        {safety && !isGroup
          ? 'Your safety number with this contact changed. Tap to verify it again.'
          : systemText(message, people)}
        {safety && isGroup ? '. Tap to verify it.' : ''}
      </Text>
    </Pressable>
  );
}

function Bubble(props: BubbleProps) {
  const { message, online, readReceipts, isGroup, people, highlighted, first, last } = props;
  const runtime = useChatRuntime();
  const { palette, dark, prefs, card } = useTheme();
  const { moves } = useMotion();
  const lastTap = useRef(0);
  const [burst, setBurst] = useState(0);

  if (message.kind === 'system') {
    return <SystemNotice message={message} isGroup={isGroup} people={people} />;
  }

  const outgoing = message.direction === 'out';
  const deleted = message.kind === 'deleted';
  const status =
    outgoing && message.state && !deleted
      ? stateLabel(shownState(message.state, readReceipts), online)
      : undefined;
  const body =
    message.kind === 'unsupported'
      ? 'This message needs a newer version of PingDost. Update the app to read it.'
      : deleted
        ? outgoing
          ? 'You deleted this message'
          : 'This message was deleted'
        : message.kind === 'attachment'
          ? attachmentBody(message)
          : message.body;
  const retry =
    message.state === 'failed' && runtime && !deleted
      ? () => void runtime.engine.retry(message.messageId)
      : undefined;
  const edited = message.editedAt !== null && !deleted;
  const sender = outgoing ? 'You' : isGroup ? people.name(message.senderUserId) : 'They';
  const reactable = canReact(message) && !props.readOnly;
  const bigEmoji = message.kind === 'text' && !message.replyTo && isBigEmoji(message.body);
  const attachment = message.kind === 'attachment';
  const onBrand = outgoing && !deleted && !bigEmoji;
  // The state in words only when it is unusual; the usual ones are the ticks.
  const stateWords =
    status && !['sent', 'delivered', 'read'].includes(status.icon) ? status.short : undefined;
  // Every message shows its time and state (Phase 35).
  const metaText = `${timeLabel(message.sortAt)}${edited ? ' · edited' : ''}${
    stateWords ? ` · ${stateWords}` : ''
  }`;
  const textShown = attachment ? message.body : body;
  // Beside the last line of text when it fits; under media, a big emoji or right-to-left text.
  const inlineMeta = !bigEmoji && textShown !== '' && !startsRightToLeft(textShown);
  const meta = (overlay: boolean, className?: string) => (
    <MessageMeta
      text={metaText}
      status={status}
      onBrand={onBrand}
      overlay={overlay}
      {...(className ? { className } : {})}
    />
  );
  const spacer = inlineMeta ? <MetaSpacer text={metaText} tick={status !== undefined} /> : null;

  const corners = bubbleCorners(prefs.bubble, { outgoing, first, last });

  function onPress() {
    if (retry) {
      retry();
      return;
    }
    if (!reactable) return;
    const now = Date.now();
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      const mine = message.reactions.find((r) => r.userId === props.selfUserId)?.emoji;
      haptic('light');
      if (mine !== '❤️') setBurst((count) => count + 1);
      props.onReact(message, mine === '❤️' ? null : '❤️');
    } else {
      lastTap.current = now;
    }
  }

  return (
    <SwipeAction
      enabled={reactable}
      {...(reactable ? { left: { icon: ReplyIcon, onCommit: () => props.onReply(message) } } : {})}
    >
      <Animated.View
        // At most 80% of the screen wide (Phase 35); the margin is outside that.
        className={`${prefs.density === 'compact' ? 'gap-[2px]' : 'gap-1'} mx-3 max-w-[80%] ${
          outgoing ? 'self-end' : 'self-start'
        } ${first ? 'mt-2' : 'mt-[2px]'}`}
        style={
          props.fresh && moves
            ? {
                animationName: BUBBLE_IN,
                animationDuration: 260,
                animationTimingFunction: CSS_POP,
              }
            : undefined
        }
      >
        <Pressable
          accessibilityRole="text"
          accessibilityLabel={`${sender}: ${body}. ${timeLabel(message.sortAt)}${edited ? ', edited' : ''}${status ? `. ${status.long}` : ''}`}
          accessibilityHint={
            retry ? 'Double tap to send it again' : 'Swipe right to reply. Long press for actions'
          }
          delayLongPress={320}
          onLongPress={() => {
            haptic('medium');
            props.onLongPress(message);
          }}
          onPress={onPress}
          className={bigEmoji ? '' : attachment ? 'p-1' : 'px-3 py-2'}
          style={
            bigEmoji
              ? undefined
              : {
                  borderTopLeftRadius: corners.topLeft,
                  borderTopRightRadius: corners.topRight,
                  borderBottomLeftRadius: corners.bottomLeft,
                  borderBottomRightRadius: corners.bottomRight,
                  ...(deleted
                    ? { borderWidth: 1, borderStyle: 'dashed', borderColor: palette.border }
                    : outgoing
                      ? {
                          backgroundImage: brandGradient(palette),
                          ...(prefs.look === 'sticker' ? card : {}),
                        }
                      : {
                          backgroundColor: palette['bubble-in'],
                          ...(prefs.look === 'soft' ? { boxShadow: card.boxShadow } : card),
                        }),
                  ...(highlighted ? { borderWidth: 2, borderColor: palette.accent } : {}),
                }
          }
        >
          {isGroup && !outgoing && first && (
            <Text
              numberOfLines={1}
              importantForAccessibility="no"
              className={`font-bold ${attachment ? 'px-2 pb-1' : ''}`}
              style={{ color: senderColor(message.senderUserId, dark) }}
            >
              {sender}
            </Text>
          )}
          {message.replyTo && !deleted && (
            <Quote
              replyTo={message.replyTo}
              conversationId={message.conversationId}
              loaded={props.loaded}
              names={props.names}
              outgoing={outgoing}
              onPress={props.onQuotePress}
            />
          )}
          {attachment && (
            <AttachmentContent
              message={message}
              outgoing={outgoing}
              onLongPress={() => props.onLongPress(message)}
            />
          )}
          {bigEmoji ? (
            <>
              <Text selectable={false} className="text-5xl">
                {message.body.trim()}
              </Text>
              {meta(false)}
            </>
          ) : deleted ? (
            <View className="flex-row items-center gap-2">
              <Icon icon={BanIcon} size={14} color="muted" />
              <View className="shrink">
                <Text className="text-base italic text-muted">
                  {body}
                  {spacer}
                </Text>
                {meta(true)}
              </View>
            </View>
          ) : textShown === '' ? (
            // Media without a caption: the time goes under it.
            meta(false, 'px-2 pb-1 pt-[2px]')
          ) : (
            <View className={attachment ? 'px-2 pb-1 pt-1' : ''}>
              <Text
                selectable={false}
                className={`text-base ${onBrand ? 'text-on-primary' : 'text-on-bubble-in'} ${
                  message.kind === 'unsupported' ? 'italic' : ''
                }`}
              >
                {textShown}
                {spacer}
              </Text>
              {inlineMeta ? meta(true) : meta(false, 'mt-[2px]')}
            </View>
          )}
        </Pressable>
        {!deleted && (
          <Reactions
            message={message}
            selfUserId={props.selfUserId}
            onToggle={(emoji, mine) => props.onReact(message, mine ? null : emoji)}
          />
        )}
        {burst > 0 && moves && <HeartBurst key={burst} outgoing={outgoing} />}
      </Animated.View>
    </SwipeAction>
  );
}

const CONTEXT_IN = FadeInDown.duration(180);
const CONTEXT_OUT = FadeOutDown.duration(140);

/** The round button at the end of the composer: microphone, or send once there is text. */
function SendButton({
  mode,
  disabled,
  onPress,
}: {
  mode: 'voice' | 'send' | 'save';
  disabled: boolean;
  onPress: () => void;
}) {
  const { palette, floating, prefs } = useTheme();
  const { moves } = useMotion();
  const voice = mode === 'voice';
  const transition = moves
    ? {
        transitionProperty: 'all' as const,
        transitionDuration: 200,
        transitionTimingFunction: CSS_POP,
      }
    : {};
  return (
    <Tap
      accessibilityLabel={voice ? 'Record a voice message' : mode === 'save' ? 'Save' : 'Send'}
      accessibilityState={{ disabled }}
      disabled={disabled}
      feedback={voice ? 'selection' : 'light'}
      scaleTo={0.88}
      onPress={onPress}
      className={`h-[52px] w-[52px] items-center justify-center rounded-full ${disabled ? 'opacity-50' : ''}`}
      style={{
        backgroundImage: brandGradient(palette),
        ...(prefs.look === 'sticker' ? floating : {}),
      }}
    >
      <Animated.View
        className="absolute"
        style={{
          opacity: voice ? 1 : 0,
          transform: [{ scale: voice ? 1 : 0.4 }, { rotate: voice ? '0deg' : '-60deg' }],
          ...transition,
        }}
      >
        <Icon icon={MicIcon} size={24} color="on-primary" strokeWidth={2.4} />
      </Animated.View>
      <Animated.View
        className="absolute"
        style={{
          opacity: voice ? 0 : 1,
          transform: [{ scale: voice ? 0.4 : 1 }, { rotate: voice ? '60deg' : '0deg' }],
          ...transition,
        }}
      >
        <Icon
          icon={mode === 'save' ? BadgeCheckIcon : SendIcon}
          size={24}
          color="on-primary"
          strokeWidth={2.4}
        />
      </Animated.View>
    </Tap>
  );
}

/** The keyboard's height frame by frame (from the screen's bottom edge: it includes the
 * navigation bar, since the app draws edge to edge). */
function useKeyboardHeight(): SharedValue<number> {
  const height = useSharedValue(0);
  useKeyboardHandler(
    {
      onMove: (event) => {
        'worklet';
        height.value = event.height;
      },
      onInteractive: (event) => {
        'worklet';
        height.value = event.height;
      },
      onEnd: (event) => {
        'worklet';
        height.value = event.height;
      },
    },
    [],
  );
  return height;
}

/**
 * The space under the composer (Phase 36): the keyboard's height while it is up, the emoji
 * panel's while that is open (`reserve`), else the navigation bar's. One measure, so the
 * composer sits right on the keyboard, with no second inset added on top of it.
 */
function BottomSpace({
  reserve,
  children,
}: {
  reserve?: SharedValue<number>;
  children?: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const rest = Math.max(insets.bottom, 4);
  const style = useAnimatedStyle(() => ({
    height: Math.max(rest, keyboard.value, reserve?.value ?? 0),
  }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

/** The last keyboard height seen this session: the emoji panel takes its place at that size. */
let lastKeyboardHeight = 0;

function panelHeight(windowHeight: number, bottomInset: number): number {
  if (lastKeyboardHeight > 120) return lastKeyboardHeight;
  return Math.round(Math.min(Math.max(windowHeight * 0.36, 260), 380)) + bottomInset;
}

type Panel = 'none' | 'emoji' | 'search';

function Composer({
  conversationId,
  replyTo,
  editing,
  names,
  onDone,
  onSent,
  onKeyboardShown,
}: {
  conversationId: string;
  replyTo: MessageRecord | undefined;
  editing: MessageRecord | undefined;
  names: (message: MessageRecord) => string;
  onDone: () => void;
  /** A message went out: the chat jumps to the newest message. */
  onSent: () => void;
  /** The keyboard or the emoji panel came up. */
  onKeyboardShown: () => void;
}) {
  const runtime = useChatRuntime();
  const router = useRouter();
  const { palette, floating } = useTheme();
  const { fades, moves } = useMotion();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [text, setText] = useState('');
  const [attaching, setAttaching] = useState(false);
  const [recording, setRecording] = useState(false);
  const [panel, setPanelState] = useState<Panel>('none');
  const panelRef = useRef<Panel>('none');
  const reserve = useSharedValue(0);
  const input = useRef<ComponentRef<typeof NativeTextInput>>(null);
  const selection = useRef({ start: 0, end: 0 });
  const trimmed = text.trim();

  function setPanel(next: Panel) {
    panelRef.current = next;
    setPanelState(next);
  }

  useEffect(() => {
    if (editing) setText(editing.body);
  }, [editing]);

  // Once the keyboard is up, the space kept for the panel is no longer needed.
  useEffect(() => {
    const shown = KeyboardEvents.addListener('keyboardDidShow', (event) => {
      if (event.height > 120) lastKeyboardHeight = event.height;
      if (panelRef.current !== 'emoji') reserve.value = 0;
      onKeyboardShown();
    });
    return () => shown.remove();
  }, [reserve, onKeyboardShown]);

  // Back closes the search, then the panel.
  useEffect(() => {
    if (panel === 'none') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (panelRef.current === 'search') openEmoji();
      else closePanel();
      return true;
    });
    return () => subscription.remove();
  });

  function openEmoji() {
    const height = panelHeight(windowHeight, insets.bottom);
    // With the keyboard up the panel takes its place at once; from nothing it slides up.
    reserve.value =
      KeyboardController.isVisible() || !moves ? height : withTiming(height, { duration: 220 });
    setPanel('emoji');
    void KeyboardController.dismiss({ keepFocus: true });
    setTimeout(onKeyboardShown, 260);
  }

  function openKeyboard() {
    // The panel's space stays until the keyboard is up, so nothing jumps.
    setPanel('none');
    // The field kept its focus while the panel was open, and focusing a focused field does not
    // bring the keyboard back (seen on Android 15): let go of it first.
    const field = input.current;
    field?.blur();
    requestAnimationFrame(() => field?.focus());
    setTimeout(() => {
      if (panelRef.current === 'none' && !KeyboardController.isVisible()) {
        reserve.value = moves ? withTiming(0, { duration: 200 }) : 0;
      }
    }, 700);
  }

  function closePanel() {
    setPanel('none');
    reserve.value = moves ? withTiming(0, { duration: 200 }) : 0;
  }

  function insertEmoji(emoji: string) {
    const next = insertAt(text, selection.current, emoji);
    if (next.text.length > MAX_TEXT) return;
    changeText(next.text);
    moveCaret(next.caret);
  }

  function backspace() {
    const next = deleteBefore(text, selection.current);
    changeText(next.text);
    moveCaret(next.caret);
  }

  function moveCaret(caret: number) {
    selection.current = { start: caret, end: caret };
    // After the new text reached the native field.
    requestAnimationFrame(() => input.current?.setSelection(caret, caret));
  }

  function changeText(next: string) {
    setText(next);
    if (runtime && !editing) void runtime.engine.setTyping(conversationId, next.trim() !== '');
  }

  async function attach(source: PickSource) {
    try {
      const draft = await pick(source);
      if (!draft) return;
      usePendingSend.setState({ conversationId, draft, replyTo: replyTo?.messageId });
      onDone();
      router.push('/send-attachment');
    } catch (error) {
      Alert.alert(
        'Could not attach that',
        error instanceof PickError || error instanceof SendError
          ? error.message
          : 'Try another file.',
      );
    }
  }

  function sendVoice(note: VoiceNote) {
    const reply = replyTo?.messageId;
    onDone();
    onSent();
    void (async () => {
      try {
        const draft = await makeDraft({
          uri: note.uri,
          voice: { waveform: note.waveform, durationMs: note.durationMs },
          temporary: true,
        });
        await sendDraft(
          conversationId,
          draft,
          {
            compress: false,
            imageQuality: 'standard',
            caption: '',
            ...(reply ? { replyTo: reply } : {}),
          },
          () => undefined,
        ).result;
      } catch (error) {
        Alert.alert(
          'Could not send the voice message',
          error instanceof SendError ? error.message : 'Please try again.',
        );
      }
    })();
  }

  function send() {
    if (!runtime || trimmed === '') return;
    setText('');
    selection.current = { start: 0, end: 0 };
    onDone();
    void runtime.engine.setTyping(conversationId, false);
    if (editing) {
      if (trimmed !== editing.body.trim()) {
        runtime.engine.editMessage(editing.messageId, trimmed).catch((error: unknown) => {
          failed('edit the message', error);
        });
      }
      return;
    }
    // Shown at once, even when reading older messages (Phase 36).
    onSent();
    void runtime.engine.sendText(conversationId, trimmed, {
      ...(replyTo ? { replyTo: replyTo.messageId } : {}),
    });
  }

  const context = editing ?? replyTo;
  return (
    <View>
      <View className="px-3 pb-[6px] pt-1">
        {context && (
          <Animated.View
            {...(fades ? { entering: CONTEXT_IN, exiting: CONTEXT_OUT } : {})}
            className="mb-2 flex-row items-center gap-3 rounded-xl border-l-4 border-accent bg-surface py-2 pl-3 pr-1"
          >
            <Icon icon={editing ? PencilIcon : ReplyIcon} size={18} color="accent" />
            <View className="flex-1">
              <Text className="font-bold text-accent">
                {editing ? 'Editing message' : `Replying to ${names(context)}`}
              </Text>
              <Text numberOfLines={editing ? 2 : 1} className="text-muted">
                {editing
                  ? 'Shown as “edited” on every device. The earlier text is not kept.'
                  : previewText(context)}
              </Text>
            </View>
            <IconButton
              icon={XIcon}
              label={editing ? 'Cancel editing' : 'Cancel reply'}
              size={40}
              onPress={() => {
                if (editing) setText('');
                onDone();
              }}
            />
          </Animated.View>
        )}
        {recording ? (
          <VoiceRecorder onSend={sendVoice} onClose={() => setRecording(false)} />
        ) : (
          <View className="flex-row items-end gap-2">
            <View
              className="min-h-[52px] flex-1 flex-row items-end rounded-2xl bg-surface pl-1 pr-1"
              style={{ ...floating, backgroundColor: palette.surface }}
            >
              {!editing && (
                <View className="h-[48px] justify-center">
                  <IconButton
                    icon={PlusIcon}
                    label="Attach a photo, video or file"
                    variant="soft"
                    size={40}
                    feedback="selection"
                    disabled={!runtime}
                    onPress={() => setAttaching(true)}
                  />
                </View>
              )}
              <TextInput
                ref={input}
                accessibilityLabel={editing ? 'Edited message' : 'Message'}
                placeholder="Message"
                value={text}
                maxLength={MAX_TEXT}
                multiline
                autoFocus={editing !== undefined}
                onChangeText={changeText}
                onSelectionChange={({ nativeEvent }) => {
                  selection.current = nativeEvent.selection;
                }}
                // A tap on the field while the emoji panel is open brings the keyboard back.
                onPressIn={() => panelRef.current !== 'none' && openKeyboard()}
                onBlur={() => runtime && void runtime.engine.setTyping(conversationId, false)}
                className={`max-h-[140px] min-h-[48px] flex-1 py-3 text-base text-foreground ${editing ? 'pl-4' : 'pl-2'}`}
              />
              <View className="h-[48px] justify-center">
                <IconButton
                  icon={panel === 'none' ? SmileIcon : KeyboardIcon}
                  label={panel === 'none' ? 'Emoji' : 'Keyboard'}
                  size={40}
                  feedback="selection"
                  onPress={() => (panel === 'none' ? openEmoji() : openKeyboard())}
                />
              </View>
            </View>
            <SendButton
              mode={editing ? 'save' : trimmed === '' ? 'voice' : 'send'}
              disabled={!runtime || (editing !== undefined && trimmed === '')}
              onPress={() => {
                if (trimmed === '' && !editing) {
                  if (panelRef.current !== 'none') closePanel();
                  setRecording(true);
                } else send();
              }}
            />
          </View>
        )}
        <ActionSheet
          visible={attaching}
          onClose={() => setAttaching(false)}
          title="Send a file"
          layout="tiles"
          actions={PICK_ACTIONS.map(({ source, label, detail, icon }) => ({
            label,
            detail,
            icon,
            onPress: () => void attach(source),
          }))}
        />
      </View>
      {panel === 'search' && (
        <EmojiPanel
          height={0}
          bottomInset={0}
          searching
          onSearchingChange={(searching) => (searching ? setPanel('search') : openEmoji())}
          onPick={insertEmoji}
          onBackspace={backspace}
        />
      )}
      <BottomSpace reserve={reserve}>
        {panel === 'emoji' && (
          <View className="absolute left-0 right-0 top-0">
            <EmojiPanel
              height={panelHeight(windowHeight, insets.bottom)}
              bottomInset={insets.bottom}
              searching={false}
              onSearchingChange={(searching) => {
                if (!searching) return;
                // The search words need the keyboard; the strip sits on it.
                setPanel('search');
              }}
              onPick={insertEmoji}
              onBackspace={backspace}
            />
          </View>
        )}
      </BottomSpace>
    </View>
  );
}

/** In place of the composer once this user left (or was removed from) a group. */
function LeftGroupNotice() {
  return (
    <View className="px-3 pb-2 pt-1">
      <View className="rounded-xl bg-surface px-4 py-3">
        <Text className="text-center text-muted">
          You&apos;re no longer a member of this group. You can read what is here, but you
          can&apos;t send or receive new messages.
        </Text>
      </View>
    </View>
  );
}

function BlockedNotice({ peerUserId, name }: { peerUserId: string; name: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <View className="px-3 pb-2 pt-1">
      <View className="gap-2 rounded-xl bg-surface p-4">
        <Text className="text-center text-muted">
          You blocked {name}. You can&apos;t message each other until you unblock them.
        </Text>
        <Button
          label="Unblock"
          variant="secondary"
          loading={busy}
          onPress={() => {
            setBusy(true);
            useBlocks
              .getState()
              .unblock(peerUserId)
              .catch(() => Alert.alert('Could not unblock', 'Check your connection and try again.'))
              .finally(() => setBusy(false));
          }}
        />
      </View>
    </View>
  );
}

/** Whether a neighbor continues the same sender's run of messages. */
function continuesRun(me: MessageRecord, other: TimelineItem | undefined): boolean {
  if (other?.type !== 'message' || other.message.kind === 'system') return false;
  return (
    other.message.senderUserId === me.senderUserId &&
    other.message.direction === me.direction &&
    Math.abs(other.message.sortAt - me.sortAt) < RUN_GAP_MS
  );
}

const DOWN_IN = {
  from: { transform: [{ scale: 0.6 }], opacity: 0 },
  to: { transform: [{ scale: 1 }], opacity: 1 },
};

export function ChatScreen({
  conversationId,
  focusMessageId,
}: {
  conversationId: string;
  /** A search result to scroll to. */
  focusMessageId?: string | undefined;
}) {
  const router = useRouter();
  const runtime = useChatRuntime();
  const status = useConnectionStatus();
  const readReceipts = useReadReceipts();
  const { floating, palette } = useTheme();
  const { moves } = useMotion();
  const insets = useSafeAreaInsets();
  const [conversation, setConversation] = useState<ConversationRecord>();
  const { items, loaded, loadOlder, loadUntil, typing } = useConversation(conversationId);
  const focused = useRef(false);
  const list = useRef<FlashListRef<TimelineItem>>(null);
  const isGroup = conversation?.kind === 'group';
  const peerUserId = isGroup ? undefined : conversation?.peerUserId;
  const contact = useContact(peerUserId);
  const group = useGroup(isGroup ? conversationId : undefined);
  const blocked = useIsBlocked(peerUserId);
  const people = useNames();
  const name = isGroup ? group?.name || 'this group' : contactName(contact);
  const [selected, setSelected] = useState<MessageRecord>();
  const [deleting, setDeleting] = useState<MessageRecord>();
  const [replyTo, setReplyTo] = useState<MessageRecord>();
  const [editing, setEditing] = useState<MessageRecord>();
  const [highlight, setHighlight] = useState<string>();
  const [headerHeight, setHeaderHeight] = useState(insets.top + 72);
  const [awayFromEnd, setAwayFromEnd] = useState(false);
  // Reading the newest message, and what was newest when the reader scrolled away (Phase 36).
  const [atEnd, setAtEnd] = useState(true);
  const [seen, setSeen] = useState<SeenMark>();
  const selfUserId = runtime?.userId ?? '';

  const names = useCallback(
    (message: MessageRecord) =>
      message.senderUserId === selfUserId
        ? 'You'
        : isGroup
          ? people.name(message.senderUserId)
          : name,
    [selfUserId, name, isGroup, people],
  );

  useEffect(() => {
    if (!runtime) return;
    void runtime.engine.getConversation(conversationId).then(setConversation);
  }, [runtime, conversationId]);

  // Whether a message could start offline (cached keys), for the offline banner (ADR 0024).
  const [offlineReachable, setOfflineReachable] = useState<boolean | null>(null);
  useEffect(() => {
    if (!runtime || !peerUserId || status === 'online') return;
    let live = true;
    void runtime.engine
      .canReachOffline(peerUserId)
      .then((reachable) => live && setOfflineReachable(reachable))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [runtime, peerUserId, status]);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      if (peerUserId) watchPresence([peerUserId]);
      return () => {
        focused.current = false;
        watchPresence([]);
        if (runtime) void runtime.engine.setTyping(conversationId, false);
      };
    }, [runtime, conversationId, peerUserId]),
  );

  // Reading the conversation clears its unread count (and sends read receipts if on) and its
  // notification.
  useEffect(() => {
    if (!focused.current || !runtime) return;
    void runtime.engine.markRead(conversationId);
    dismissChatNotification(conversationId);
  }, [runtime, conversationId, items.length]);

  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    if (atEnd) setSeen(undefined);
    else setSeen((current) => current ?? newestMark(itemsRef.current));
  }, [atEnd]);
  const unseen = atEnd ? 0 : unseenCount(items, seen);
  const announced = useRef(0);
  useEffect(() => {
    if (unseen > announced.current) AccessibilityInfo.announceForAccessibility(unseenLabel(unseen));
    announced.current = unseen;
  }, [unseen]);

  // Sending jumps to the newest message: now, and again once the sent one is in the list.
  const pendingJump = useRef(false);
  const jumpToEnd = useCallback(() => {
    pendingJump.current = true;
    setSeen(newestMark(itemsRef.current));
    void list.current?.scrollToEnd({ animated: true });
  }, []);
  useEffect(() => {
    if (!pendingJump.current) return;
    pendingJump.current = false;
    requestAnimationFrame(() => void list.current?.scrollToEnd({ animated: true }));
  }, [items.length]);
  // The keyboard or the emoji panel took space: keep the newest message in view.
  const atEndRef = useRef(atEnd);
  atEndRef.current = atEnd;
  const keepEndInView = useCallback(() => {
    if (atEndRef.current) void list.current?.scrollToEnd({ animated: true });
  }, []);
  const jumpTo = useCallback(
    async (messageId: string) => {
      if (!(await loadUntil(messageId))) return;
      // Wait a frame so the list has the loaded page.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const index = itemsRef.current.findIndex((item) => item.key === messageId);
      if (index < 0) return;
      void list.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
      setHighlight(messageId);
      setTimeout(
        () => setHighlight((current) => (current === messageId ? undefined : current)),
        1_500,
      );
    },
    [loadUntil],
  );

  // A search result: jump once, after the first page arrived.
  const jumped = useRef<string>(undefined);
  useEffect(() => {
    if (!focusMessageId || items.length === 0 || jumped.current === focusMessageId) return;
    jumped.current = focusMessageId;
    void jumpTo(focusMessageId);
  }, [focusMessageId, items.length, jumpTo]);
  // A result picked in this chat's own search, on coming back.
  useFocusEffect(
    useCallback(() => {
      const target = takeJump(conversationId);
      if (target) void jumpTo(target);
    }, [conversationId, jumpTo]),
  );

  const react = useCallback(
    (message: MessageRecord, emoji: string | null) => {
      runtime?.engine.react(message.messageId, emoji).catch((error: unknown) => {
        failed('react', error);
      });
    },
    [runtime],
  );

  const left = isGroup && group?.left === true;
  const readOnly = blocked || left;

  const renderItem = useCallback(
    ({ item, index }: { item: TimelineItem; index: number }) =>
      item.type === 'day' ? (
        <View className="my-3 self-center rounded-full bg-surface/90 px-3 py-1">
          <Text className="text-xs font-bold text-muted">{item.label}</Text>
        </View>
      ) : (
        <Bubble
          message={item.message}
          online={status === 'online'}
          readReceipts={readReceipts}
          isGroup={isGroup}
          people={people}
          selfUserId={selfUserId}
          loaded={loaded}
          names={names}
          highlighted={highlight === item.message.messageId}
          first={!continuesRun(item.message, items[index - 1])}
          last={!continuesRun(item.message, items[index + 1])}
          // Scrolling back to it later must not replay the entrance.
          fresh={Date.now() - item.message.sortAt < 1_200}
          readOnly={readOnly}
          onLongPress={setSelected}
          onQuotePress={(messageId) => void jumpTo(messageId)}
          onReact={react}
          onReply={(message) => {
            setEditing(undefined);
            setReplyTo(message);
          }}
        />
      ),
    [
      items,
      status,
      readReceipts,
      isGroup,
      people,
      selfUserId,
      loaded,
      names,
      highlight,
      readOnly,
      jumpTo,
      react,
    ],
  );

  const actions: SheetAction[] = [];
  if (selected && runtime) {
    const message = selected;
    if (canReact(message) && !blocked && !left) {
      actions.push({ label: 'Reply', icon: ReplyIcon, onPress: () => setReplyTo(message) });
    }
    if (runtime.engine.canEdit(message) && !left) {
      actions.push({
        label: 'Edit',
        icon: PencilIcon,
        onPress: () => {
          setReplyTo(undefined);
          setEditing(message);
        },
      });
    }
    if (message.direction === 'out' && message.kind !== 'deleted') {
      actions.push({
        label: 'Message info',
        icon: InfoIcon,
        onPress: () =>
          router.push({
            pathname: '/message-info/[messageId]',
            params: { messageId: message.messageId },
          }),
      });
    }
    actions.push({
      label: 'Delete…',
      icon: Trash2Icon,
      destructive: true,
      onPress: () => setDeleting(message),
    });
  }
  const mine = selected?.reactions.find((r) => r.userId === selfUserId)?.emoji ?? null;

  const deleteActions: SheetAction[] = [];
  if (deleting && runtime) {
    const message = deleting;
    deleteActions.push({
      label: 'Delete for me',
      detail: isGroup
        ? 'Removes it from this phone only. The other members keep their copies.'
        : `Removes it from this phone only. ${message.direction === 'out' ? name : 'The sender'} keeps their copy.`,
      destructive: true,
      onPress: () => void runtime.engine.deleteForMe([message.messageId]),
    });
    if (runtime.engine.canDeleteForEveryone(message) && !left) {
      deleteActions.push({
        label: 'Delete for everyone',
        detail:
          "Asks every copy to be removed. It can't erase screenshots, exports, notifications or copies already saved elsewhere.",
        destructive: true,
        onPress: () => {
          runtime.engine.deleteForEveryone(message.messageId).catch((error: unknown) => {
            failed('delete the message for everyone', error);
          });
        },
      });
    }
  }

  return (
    <View className="flex-1 bg-background">
      <Wallpaper />
      <View className="flex-1">
        <View className="flex-1">
          <FlashList
            ref={list}
            data={items}
            keyExtractor={(item) => item.key}
            getItemType={(item) => item.type}
            renderItem={renderItem}
            maintainVisibleContentPosition={{
              startRenderingFromBottom: true,
              autoscrollToBottomThreshold: 0.2,
            }}
            onStartReached={() => void loadOlder()}
            onStartReachedThreshold={0.3}
            onScroll={({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) => {
              const fromEnd = contentSize.height - contentOffset.y - layoutMeasurement.height;
              // Set only when they flip, so scrolling does not re-render the screen. "At the
              // end" is where the list itself scrolls new messages into view (20%).
              setAwayFromEnd(fromEnd > 480);
              setAtEnd(
                isAtEnd(
                  contentOffset.y,
                  layoutMeasurement.height,
                  contentSize.height,
                  layoutMeasurement.height * 0.2,
                ),
              );
            }}
            contentContainerStyle={{ paddingTop: headerHeight + 8, paddingBottom: 8 }}
            ListEmptyComponent={
              <EmptyState
                icon={LockIcon}
                title="Just you two"
                message={
                  isGroup
                    ? `Messages in ${name} are end-to-end encrypted for its members. No one else, not even PingDost, can read them.`
                    : `Messages with ${name} are end-to-end encrypted. No one else, not even PingDost, can read them.`
                }
              />
            }
          />
          {unseen > 0 ? (
            <Animated.View
              className="absolute bottom-3 self-center"
              accessibilityLiveRegion="polite"
              style={
                moves
                  ? {
                      animationName: DOWN_IN,
                      animationDuration: 200,
                      animationTimingFunction: CSS_POP,
                    }
                  : undefined
              }
            >
              <Tap
                accessibilityLabel={`${unseenLabel(unseen)}. Show them`}
                feedback="selection"
                onPress={jumpToEnd}
                className="h-[40px] flex-row items-center gap-2 rounded-full px-4"
                style={{ backgroundImage: brandGradient(palette), ...floating }}
              >
                <Icon icon={ArrowDownIcon} size={18} color="on-primary" strokeWidth={2.6} />
                <Text className="font-bold text-on-primary">{unseenLabel(unseen)}</Text>
              </Tap>
            </Animated.View>
          ) : (
            awayFromEnd && (
              <Animated.View
                className="absolute bottom-3 right-3"
                style={
                  moves
                    ? {
                        animationName: DOWN_IN,
                        animationDuration: 200,
                        animationTimingFunction: CSS_POP,
                      }
                    : undefined
                }
              >
                <IconButton
                  icon={ArrowDownIcon}
                  label="Jump to the latest message"
                  variant="surface"
                  feedback="selection"
                  onPress={jumpToEnd}
                />
              </Animated.View>
            )
          )}
        </View>
        {typing && !blocked && (
          <View
            accessibilityLiveRegion="polite"
            accessibilityLabel={`${name} is typing`}
            className="ml-3 mt-1 self-start rounded-xl px-4 py-3"
            style={{ backgroundColor: palette['bubble-in'] }}
          >
            <TypingDots />
          </View>
        )}
        {left ? (
          <>
            <LeftGroupNotice />
            <BottomSpace />
          </>
        ) : blocked && peerUserId ? (
          <>
            <BlockedNotice peerUserId={peerUserId} name={name} />
            <BottomSpace />
          </>
        ) : (
          <Composer
            conversationId={conversationId}
            replyTo={replyTo}
            editing={editing}
            names={names}
            onDone={() => {
              setReplyTo(undefined);
              setEditing(undefined);
            }}
            onSent={jumpToEnd}
            onKeyboardShown={keepEndInView}
          />
        )}
      </View>

      <StatusBarBand />

      {/* Floats over the messages, which scroll under it. */}
      <View
        className="absolute left-3 right-3 top-0 gap-2"
        pointerEvents="box-none"
        style={{ paddingTop: insets.top + 6 }}
        onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}
      >
        <View
          className="min-h-[58px] flex-row items-center gap-1 rounded-2xl bg-surface px-1 py-1"
          style={floating}
        >
          <IconButton icon={ArrowLeftIcon} label="Back" size={40} onPress={() => router.back()} />
          {isGroup ? (
            <GroupIdentity groupId={conversationId} />
          ) : (
            <PeerIdentity peerUserId={peerUserId} />
          )}
          {/* Direct chats only: groups have no call actions (REQ §19.5). */}
          {callActionsFor(conversation, { blocked }).map((kind) => (
            <IconButton
              key={kind}
              icon={kind === 'video' ? VideoIcon : PhoneIcon}
              label={kind === 'video' ? 'Video call' : 'Voice call'}
              size={40}
              disabled={!peerUserId}
              feedback="selection"
              onPress={() => {
                if (!peerUserId) return;
                void dial(peerUserId, kind === 'video').then((started) => {
                  if (started) router.push('/call');
                  else if (useCalls.getState().notice) {
                    Alert.alert('Call', useCalls.getState().notice ?? '');
                  }
                });
              }}
            />
          ))}
          <IconButton
            icon={SearchIcon}
            label="Search this chat"
            size={40}
            onPress={() => router.push({ pathname: '/search', params: { conversationId } })}
          />
        </View>
        <OfflineBanner
          peer={peerUserId ? { userId: peerUserId, name, reachable: offlineReachable } : undefined}
        />
      </View>

      <ActionSheet
        visible={selected !== undefined}
        onClose={() => setSelected(undefined)}
        {...(selected ? { title: previewText(selected, people) } : {})}
        header={
          selected && canReact(selected) && !blocked && !left ? (
            <View className="flex-row justify-around px-1 pb-2">
              {quickReactions.map((emoji, index) => (
                <Animated.View
                  key={emoji}
                  style={
                    moves
                      ? {
                          animationName: REACTION_POP,
                          animationDuration: 260,
                          animationDelay: index * 30,
                          animationFillMode: 'both',
                          animationTimingFunction: CSS_POP,
                        }
                      : undefined
                  }
                >
                  <Tap
                    accessibilityLabel={mine === emoji ? `Remove ${emoji}` : `React ${emoji}`}
                    feedback="selection"
                    scaleTo={0.8}
                    onPress={() => {
                      const message = selected;
                      setSelected(undefined);
                      react(message, mine === emoji ? null : emoji);
                    }}
                    className={`h-12 w-12 items-center justify-center rounded-full ${
                      mine === emoji ? 'bg-accent/20' : ''
                    }`}
                  >
                    <Text className="text-2xl">{emoji}</Text>
                  </Tap>
                </Animated.View>
              ))}
            </View>
          ) : undefined
        }
        actions={actions}
      />
      <ActionSheet
        visible={deleting !== undefined}
        onClose={() => setDeleting(undefined)}
        title="Delete this message?"
        actions={deleteActions}
      />
    </View>
  );
}
