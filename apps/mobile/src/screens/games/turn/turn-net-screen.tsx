// A turn game with friends on the phone (Phase 43, ADR 0049): the lobby, then the board with
// each person's name and, in games with a timer, a bar for the player on the clock. Moves are
// E2EE game events in the chat; this phone folds them. Shared pieces (chat button with unread
// count, message toasts, emotes, Rematch) come from `net-parts.tsx`.
import { router, Stack } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useWindowDimensions, View } from 'react-native';

import { ActionSheet, type SheetAction } from '@/components/action-sheet';
import { Button } from '@/components/button';
import { EmptyState } from '@/components/feedback';
import {
  DoorOpenIcon,
  EllipsisVerticalIcon,
  GAME_ICONS,
  InfoIcon,
  MessageCircleIcon,
  OctagonXIcon,
  Volume2Icon,
} from '@/components/icon';
import { IconButton } from '@/components/icon-button';
import { Text } from '@/components/text';
import { useNames } from '@/engine/groups';
import { useNow, useTurnNetGame } from '@/games/network';
import { releaseGameSounds } from '@/games/sounds';
import { useGames } from '@/games/store';
import { dismissTurnNotification } from '@/games/turn-notifier';
import { useMotion } from '@/theme/motion';
import { useTheme } from '@/theme/theme-root';
import {
  catalogEntry,
  FAST_TURN_PACE,
  NORMAL_TURN_PACE,
  turnNetStatus,
  type AnyTurnRules,
} from '@pingdost/games';

import { PlayersStrip, TurnBoard, turnBoardWidth, TurnDie, useTurnFeedback } from './turn-parts';
import { ResultPanel, RulesSheet } from './turn-solo-screen';
import {
  ChatButton,
  DesyncNotice,
  MessageToasts,
  NetEmotes,
  NetLobby,
  RematchButton,
  useMarkActiveGame,
} from '../net-parts';

export function TurnNetScreen({
  gameId,
  join,
  rules,
}: {
  gameId: string;
  join: boolean;
  rules: AnyTurnRules;
}) {
  const { dark } = useTheme();
  const { moves, level: motion } = useMotion();
  const names = useNames();
  const sounds = useGames((state) => state.sounds);
  const pace = motion === 'full' ? NORMAL_TURN_PACE : FAST_TURN_PACE;
  const { controller, view, record } = useTurnNetGame(gameId, rules, pace);
  const { width, height } = useWindowDimensions();
  const size = turnBoardWidth(rules, width, height - 60);
  const [menu, setMenu] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [resultSeen, setResultSeen] = useState(false);
  const entry = catalogEntry(rules.id);
  const state = view?.state ?? null;
  useTurnFeedback(
    rules,
    view && state ? { state, you: view.you, waiting: view.waiting, last: view.last } : null,
    pace,
    moves,
  );
  useEffect(() => () => releaseGameSounds(), []);
  useEffect(() => dismissTurnNotification(gameId), [gameId, view?.game.turn]);
  const playing = view?.game.phase === 'playing';
  const now = useNow((playing && rules.turnMs !== null) || (view?.game.emotes.length ?? 0) > 0);
  const nameOf = (userId: string) => (userId === names.selfUserId ? 'You' : names.name(userId));

  // "Join" on the chat card opens the game and joins it, once.
  const joined = useRef(false);
  useEffect(() => {
    if (!join || joined.current || !controller || !view) return;
    joined.current = true;
    if (view.canJoin) controller.join();
  }, [join, controller, view]);

  const openChat = () => {
    if (!record) return;
    router.push({
      pathname: '/chat/[conversationId]',
      params: { conversationId: record.conversationId },
    });
  };
  useMarkActiveGame(
    record && view && (view.game.phase === 'lobby' || playing)
      ? {
          gameId,
          conversationId: record.conversationId,
          name: entry.name,
          yourTurn: !!state && playing && view.you >= 0 && state.current === view.you,
        }
      : null,
  );

  if (!view || !controller) {
    return (
      <View className="flex-1 bg-background">
        <Stack.Screen options={{ title: entry.name }} />
        <EmptyState
          icon={GAME_ICONS[entry.icon]}
          title="Opening the game…"
          message="Games with friends live in their chat."
        />
      </View>
    );
  }
  const { game } = view;
  const status = turnNetStatus(rules, view, nameOf);
  const over = game.phase === 'over' || game.phase === 'ended';
  const inGame = view.you >= 0 || game.lobby.some((e) => e.userId === names.selfUserId);
  const left = view.you >= 0 && state?.left[view.you] === true;
  const live = game.phase === 'lobby' || playing;
  const seatName = (seat: number) => {
    if (seat === view.you) return 'You';
    const info = game.seats[seat];
    return info ? names.name(info.userId) : rules.sideName(state!, seat);
  };
  const timeLeft =
    view.deadline !== null && rules.turnMs !== null
      ? Math.min(1, Math.max(0, (view.deadline - now) / rules.turnMs))
      : null;

  const actions: SheetAction[] = [
    { label: 'Open the chat', icon: MessageCircleIcon, onPress: openChat },
    { label: 'Rules', icon: InfoIcon, onPress: () => setRulesOpen(true) },
    {
      label: sounds ? 'Turn game sounds off' : 'Turn game sounds on',
      icon: Volume2Icon,
      onPress: () => useGames.getState().setSounds(!sounds),
    },
  ];
  if (live && inGame && !left) {
    actions.push({
      label: 'Leave the game',
      detail:
        game.phase === 'lobby'
          ? 'You leave the lobby'
          : game.seats.length === 2
            ? 'The other player wins'
            : 'The others play on',
      icon: DoorOpenIcon,
      destructive: true,
      onPress: () => controller.leave(),
    });
  }
  if (live && view.isHost) {
    actions.push({
      label: 'End for everyone',
      icon: OctagonXIcon,
      destructive: true,
      onPress: () => controller.end(),
    });
  }
  const timerLine =
    rules.turnMs !== null
      ? [
          'Each turn has 30 seconds. If you are away, your app plays for you while the game is open; otherwise the others play for you, and three missed turns in a row take you out.',
        ]
      : [];

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen
        options={{
          title: entry.name,
          headerRight: () => (
            <View className="flex-row">
              <ChatButton conversationId={record?.conversationId} onPress={openChat} />
              <IconButton
                icon={EllipsisVerticalIcon}
                label="Game menu"
                onPress={() => setMenu(true)}
              />
            </View>
          ),
        }}
      />
      <DesyncNotice view={view} />
      {game.phase === 'lobby' || game.phase === 'missing' || game.phase === 'invalid' || !state ? (
        <NetLobby
          view={view}
          game={rules.id}
          selfUserId={names.selfUserId}
          nameOf={nameOf}
          status={status}
          onJoin={() => controller.join()}
          onStart={() => controller.start()}
        />
      ) : (
        <View className="flex-1 items-center justify-center gap-3 px-3">
          <PlayersStrip
            rules={rules}
            state={state}
            names={seatName}
            over={over || !!state.ranks}
            timeLeft={timeLeft}
          />
          <TurnBoard
            rules={rules}
            state={state}
            you={view.you}
            legal={view.legal}
            last={view.last}
            onMove={(move) => controller.move(move)}
            size={size}
            dark={dark}
            moves={moves}
            pace={pace}
          />
          <TurnDie
            rules={rules}
            state={state}
            waiting={view.waiting}
            last={view.last}
            you={view.you}
            moves={moves}
            pace={pace}
            onRoll={() => controller.roll()}
          />
          <View className="min-h-[40px] items-center gap-1">
            <Text
              accessibilityLiveRegion="polite"
              className="text-center text-base font-bold text-foreground"
            >
              {status}
            </Text>
            {view.you < 0 && (
              <Text className="text-center text-xs text-muted">You are watching.</Text>
            )}
            {view.locked && (
              <Text className="text-center text-xs text-muted">
                You joined on another device: play there.
              </Text>
            )}
          </View>
        </View>
      )}
      <NetEmotes view={view} now={now} nameOf={nameOf} onEmote={(e) => controller.emote(e)} />
      <MessageToasts conversationId={record?.conversationId} onOpen={openChat} />

      {over &&
        !resultSeen &&
        state &&
        (game.phase === 'ended' ? (
          <View
            className="absolute inset-0 items-center justify-center px-6"
            style={{ backgroundColor: 'rgba(5, 5, 15, 0.55)', zIndex: 100 }}
          >
            <View className="w-full max-w-[360px] gap-4 rounded-2xl bg-surface p-6">
              <Text className="text-center font-display text-2xl text-foreground">{status}</Text>
              <Button label="Back to the chat" icon={MessageCircleIcon} onPress={openChat} />
              <Button label="See the board" variant="ghost" onPress={() => setResultSeen(true)} />
            </View>
          </View>
        ) : (
          <ResultPanel rules={rules} state={state} you={view.you} names={seatName}>
            {view.you >= 0 && (
              <RematchButton
                conversationId={record?.conversationId}
                type={rules.id}
                settings={game.settings}
                maxPlayers={game.maxPlayers}
              />
            )}
            <Button
              label="Back to the chat"
              icon={MessageCircleIcon}
              variant={view.you >= 0 ? 'secondary' : 'primary'}
              onPress={openChat}
            />
            <Button label="See the board" variant="ghost" onPress={() => setResultSeen(true)} />
          </ResultPanel>
        ))}
      <ActionSheet visible={menu} onClose={() => setMenu(false)} actions={actions} />
      <RulesSheet
        rules={rules}
        settings={game.settings}
        visible={rulesOpen}
        onClose={() => setRulesOpen(false)}
        extra={timerLine}
      />
    </View>
  );
}
