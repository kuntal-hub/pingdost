// Ludo with friends on the phone (Phase 42, ADR 0049): the lobby (join, start), then the board
// with each person's name, a 30 s ring around the player on the clock, quick emotes and a way
// back to the chat. Moves are E2EE game events in the chat; this phone folds them.
import { router, Stack } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useWindowDimensions, View } from 'react-native';

import { ActionSheet, type SheetAction } from '@/components/action-sheet';
import { Button } from '@/components/button';
import { EmptyState } from '@/components/feedback';
import {
  DicesIcon,
  DoorOpenIcon,
  EllipsisVerticalIcon,
  Icon,
  InfoIcon,
  MedalIcon,
  MessageCircleIcon,
  OctagonXIcon,
  TrophyIcon,
  Volume2Icon,
} from '@/components/icon';
import { IconButton } from '@/components/icon-button';
import { Text } from '@/components/text';
import { useNames } from '@/engine/groups';
import { useLudoNetGame, useNow } from '@/games/network';
import { releaseGameSounds } from '@/games/sounds';
import { useGames } from '@/games/store';
import { dismissTurnNotification } from '@/games/turn-notifier';
import { useMotion } from '@/theme/motion';
import { useTheme } from '@/theme/theme-root';
import {
  cornerOf,
  FAST_PACE,
  LUDO_COLOR_NAMES,
  LUDO_TURN_MS,
  ludoNetStatus,
  ludoRollNote,
  ludoRules,
  NORMAL_PACE,
  ordinal,
  rotationFor,
  standings,
  type LudoNetView,
} from '@pingdost/games';

import { LudoBoard } from './board';
import { useEventHaptics, useGameSounds, useLastDice } from './ludo-screen';
import { PlayerPanel } from './panels';
import { LudoPieces, YardGlow } from './pieces';
import {
  ChatButton,
  DesyncNotice,
  MessageToasts,
  NetEmotes,
  NetLobby,
  RematchButton,
  useMarkActiveGame,
} from '../net-parts';

export function LudoNetScreen({ gameId, join }: { gameId: string; join: boolean }) {
  const { dark } = useTheme();
  const { moves, level: motion } = useMotion();
  const names = useNames();
  const autoMove = useGames((state) => state.autoMove);
  const sounds = useGames((state) => state.sounds);
  const pace = motion === 'full' ? NORMAL_PACE : FAST_PACE;
  const { controller, view, record } = useLudoNetGame(gameId, pace, autoMove);
  const [menu, setMenu] = useState(false);
  const [rules, setRules] = useState(false);
  const [resultSeen, setResultSeen] = useState(false);
  const board = view?.board ?? null;
  useEventHaptics(board);
  useGameSounds(board, pace, moves);
  const lastDice = useLastDice(board);
  useEffect(() => () => releaseGameSounds(), []);
  // On screen, the game itself says whose turn it is.
  useEffect(() => dismissTurnNotification(gameId), [gameId, view?.game.turn]);
  const playing = view?.game.phase === 'playing';
  const now = useNow(playing || (view?.game.emotes.length ?? 0) > 0);
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
  const state = board?.state;
  useMarkActiveGame(
    record && view && (view.game.phase === 'lobby' || view.game.phase === 'playing')
      ? {
          gameId,
          conversationId: record.conversationId,
          name: 'Ludo',
          yourTurn: !!state && view.you >= 0 && state.current === view.you && playing,
        }
      : null,
  );

  if (!view || !controller) {
    return (
      <View className="flex-1 bg-background">
        <EmptyState
          icon={DicesIcon}
          title="Opening the game…"
          message="Games with friends live in their chat."
        />
      </View>
    );
  }
  const { game } = view;
  const status = ludoNetStatus(view, nameOf);
  const over = game.phase === 'over' || game.phase === 'ended';
  const inGame = view.you >= 0 || game.lobby.some((e) => e.userId === names.selfUserId);
  const left = view.you >= 0 && board?.state.players[view.you]?.left === true;
  const live = game.phase === 'lobby' || game.phase === 'playing';

  const actions: SheetAction[] = [
    { label: 'Open the chat', icon: MessageCircleIcon, onPress: openChat },
    { label: 'Rules', icon: InfoIcon, onPress: () => setRules(true) },
    {
      label: sounds ? 'Turn game sounds off' : 'Turn game sounds on',
      icon: Volume2Icon,
      onPress: () => useGames.getState().setSounds(!sounds),
    },
  ];
  if (live && inGame && !left) {
    actions.push({
      label: 'Leave the game',
      detail: 'Takes effect at your next turn',
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

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen
        options={{
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
      {game.phase === 'lobby' || game.phase === 'missing' || game.phase === 'invalid' || !board ? (
        <NetLobby
          view={view}
          game="ludo"
          selfUserId={names.selfUserId}
          nameOf={nameOf}
          status={status}
          onJoin={() => controller.join()}
          onStart={() => controller.start()}
        />
      ) : (
        <Table
          view={view}
          nameOf={nameOf}
          dark={dark}
          moves={moves}
          pace={pace}
          lastDice={lastDice}
          now={now}
          status={status}
          onRoll={() => controller.roll()}
          onMove={(token) => controller.move(token)}
        />
      )}
      <NetEmotes view={view} now={now} nameOf={nameOf} onEmote={(e) => controller.emote(e)} />
      <MessageToasts conversationId={record?.conversationId} onOpen={openChat} />

      {over && !resultSeen && board && (
        <ResultCard
          view={view}
          nameOf={nameOf}
          status={status}
          onChat={openChat}
          onClose={() => setResultSeen(true)}
          rematch={
            view.you >= 0 ? (
              <RematchButton
                conversationId={record?.conversationId}
                type="ludo"
                settings={game.settings}
                maxPlayers={game.maxPlayers}
              />
            ) : null
          }
        />
      )}
      <ActionSheet visible={menu} onClose={() => setMenu(false)} actions={actions} />
      <ActionSheet
        visible={rules}
        onClose={() => setRules(false)}
        title="Ludo rules"
        header={
          <View className="gap-2 px-5 pb-2">
            {[
              ...ludoRules(game.settings),
              'Each step of a turn has 30 seconds. Three skipped turns in a row and you are out.',
            ].map((line) => (
              <Text key={line} className="text-sm text-foreground">
                • {line}
              </Text>
            ))}
          </View>
        }
        actions={[{ label: 'Close', onPress: () => setRules(false) }]}
      />
    </View>
  );
}

function Table({
  view,
  nameOf,
  dark,
  moves,
  pace,
  lastDice,
  now,
  status,
  onRoll,
  onMove,
}: {
  view: LudoNetView;
  nameOf: (userId: string) => string;
  dark: boolean;
  moves: boolean;
  pace: typeof NORMAL_PACE;
  lastDice: Record<number, number>;
  now: number;
  status: string;
  onRoll: () => void;
  onMove: (token: number) => void;
}) {
  const board = view.board!;
  const { game } = view;
  const { width, height } = useWindowDimensions();
  const size = Math.floor(Math.max(240, Math.min(width - 24, height - 380)));
  const panelWidth = Math.floor((size - 8) / 2);
  // Your corner is bottom left; a watcher sees the first seat there.
  const rotation = rotationFor(game.seats[Math.max(0, view.you)]!.color);
  const over = board.waiting === 'over';
  const active = over ? null : board.state.players[board.state.current]!;
  const timeLeft =
    view.deadline !== null ? Math.min(1, Math.max(0, (view.deadline - now) / LUDO_TURN_MS)) : null;
  const note = ludoRollNote(board);
  const corner = (top: boolean, left: boolean) => {
    const seat = board.state.players.findIndex((player) => {
      const at = cornerOf(player.color, rotation);
      return at.top === top && at.left === left;
    });
    if (seat < 0) return <View style={{ width: panelWidth }} />;
    return (
      <PlayerPanel
        view={board}
        seat={seat}
        level="medium"
        left={left}
        dark={dark}
        moves={moves}
        rollMs={pace.roll}
        lastDie={lastDice[seat] ?? null}
        width={panelWidth}
        onRoll={onRoll}
        name={nameOf(game.seats[seat]!.userId)}
        timeLeft={seat === board.state.current && !over ? timeLeft : null}
      />
    );
  };
  return (
    <View className="flex-1 items-center justify-center gap-2 px-3">
      <View className="flex-row justify-between" style={{ width: size }}>
        {corner(true, true)}
        {corner(true, false)}
      </View>
      <View style={{ width: size, height: size }}>
        <LudoBoard size={size} rotation={rotation} dark={dark} />
        {active && (
          <YardGlow
            key={active.color}
            color={active.color}
            size={size}
            rotation={rotation}
            dark={dark}
            moves={moves}
          />
        )}
        <LudoPieces
          view={board}
          size={size}
          rotation={rotation}
          dark={dark}
          moves={moves}
          hopMs={pace.hop}
          captureMs={pace.capture}
          onMove={onMove}
        />
      </View>
      <View className="flex-row justify-between" style={{ width: size }}>
        {corner(false, true)}
        {corner(false, false)}
      </View>
      <View className="min-h-[48px] items-center gap-1 pt-1">
        <Text
          accessibilityLiveRegion="polite"
          className="text-center text-base font-bold text-foreground"
        >
          {status}
        </Text>
        {note ? <Text className="text-center text-sm text-muted">{note}</Text> : null}
        {view.you < 0 && <Text className="text-center text-xs text-muted">You are watching.</Text>}
      </View>
    </View>
  );
}

function ResultCard({
  view,
  nameOf,
  status,
  onChat,
  onClose,
  rematch,
}: {
  view: LudoNetView;
  nameOf: (userId: string) => string;
  status: string;
  onChat: () => void;
  onClose: () => void;
  rematch: ReactNode;
}) {
  const { card } = useTheme();
  const board = view.board!;
  const { game } = view;
  const won = view.you >= 0 && board.state.players[view.you]?.rank === 1;
  return (
    // Above the pieces (Fabric flattens the board's wrappers; see the solo screen).
    <View
      className="absolute inset-0 items-center justify-center px-6"
      style={{ backgroundColor: 'rgba(5, 5, 15, 0.55)', zIndex: 100 }}
    >
      <View
        accessibilityViewIsModal
        className="w-full max-w-[360px] gap-4 rounded-2xl bg-surface p-6"
        style={card}
      >
        <View className="items-center gap-2">
          {game.phase === 'over' && (
            <Icon icon={won ? TrophyIcon : MedalIcon} size={44} color="accent" />
          )}
          <Text className="text-center font-display text-2xl text-foreground">{status}</Text>
        </View>
        <View className="gap-1">
          {standings(board.state).map((entry) => {
            const seat = game.seats[entry.seat]!;
            return (
              <Text key={entry.color} className="text-base text-foreground">
                {entry.rank ? ordinal(entry.rank) : entry.left ? 'Left' : '–'} ·{' '}
                {nameOf(seat.userId)} ({LUDO_COLOR_NAMES[seat.color]})
              </Text>
            );
          })}
        </View>
        {rematch}
        <Button
          label="Back to the chat"
          icon={MessageCircleIcon}
          variant={rematch ? 'secondary' : 'primary'}
          onPress={onChat}
        />
        <Button label="See the board" variant="ghost" onPress={onClose} />
      </View>
    </View>
  );
}
