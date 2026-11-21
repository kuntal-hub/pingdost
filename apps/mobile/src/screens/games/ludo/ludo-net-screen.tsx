// Ludo with friends on the phone (Phase 42, ADR 0049): the lobby (join, start), then the board
// with each person's name, a 30 s ring around the player on the clock, quick emotes and a way
// back to the chat. Moves are E2EE game events in the chat; this phone folds them.
import { router, Stack } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
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
  PlayIcon,
  TriangleAlertIcon,
  TrophyIcon,
  UserPlusIcon,
  Volume2Icon,
} from '@/components/icon';
import { IconButton } from '@/components/icon-button';
import { Tap } from '@/components/tap';
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
import { quickReactions } from '@pingdost/ui-tokens';

import { LudoBoard } from './board';
import { useEventHaptics, useGameSounds, useLastDice } from './ludo-screen';
import { PlayerPanel } from './panels';
import { LudoPieces, YardGlow } from './pieces';

/** Emotes stay on screen this long. */
const EMOTE_MS = 30_000;

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
              <IconButton icon={MessageCircleIcon} label="Open the chat" onPress={openChat} />
              <IconButton
                icon={EllipsisVerticalIcon}
                label="Game menu"
                onPress={() => setMenu(true)}
              />
            </View>
          ),
        }}
      />
      {game.desync && (
        <View className="mx-3 mt-2 flex-row items-center gap-2 rounded-xl bg-surface px-3 py-2">
          <Icon icon={TriangleAlertIcon} size={18} color="danger" />
          <Text className="flex-1 text-sm text-foreground">
            This game is out of sync between the players.
            {view.isHost ? ' You can end it from the menu.' : ''}
          </Text>
        </View>
      )}
      {game.phase === 'lobby' || game.phase === 'missing' || game.phase === 'invalid' || !board ? (
        <Lobby
          view={view}
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
      <Emotes view={view} now={now} nameOf={nameOf} onEmote={(e) => controller.emote(e)} />

      {over && !resultSeen && board && (
        <ResultCard
          view={view}
          nameOf={nameOf}
          status={status}
          onChat={openChat}
          onClose={() => setResultSeen(true)}
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

function Lobby({
  view,
  selfUserId,
  nameOf,
  status,
  onJoin,
  onStart,
}: {
  view: LudoNetView;
  selfUserId: string;
  nameOf: (userId: string) => string;
  status: string;
  onJoin: () => void;
  onStart: () => void;
}) {
  const { card } = useTheme();
  const { game } = view;
  if (game.phase === 'invalid') {
    return (
      <EmptyState
        icon={TriangleAlertIcon}
        title="This game can't be played"
        message="Start a new one from the chat."
      />
    );
  }
  const joined = game.lobby.some((e) => e.userId === selfUserId);
  const full = game.lobby.length >= game.maxPlayers;
  return (
    <View className="flex-1 justify-center px-4">
      <View className="gap-4 rounded-2xl bg-surface p-5" style={card}>
        <Text
          accessibilityLiveRegion="polite"
          className="text-center text-base font-bold text-foreground"
        >
          {status}
        </Text>
        <View className="gap-2">
          {Array.from({ length: game.maxPlayers }, (_, i) => {
            const entry = game.lobby[i];
            return (
              <View key={entry?.userId ?? `seat-${i}`} className="flex-row items-center gap-3">
                <View className="h-9 w-9 items-center justify-center rounded-full bg-raised">
                  <Icon icon={entry ? DicesIcon : UserPlusIcon} size={18} color="accent" />
                </View>
                <Text className={`text-base ${entry ? 'font-bold text-foreground' : 'text-muted'}`}>
                  {entry ? nameOf(entry.userId) : 'Open seat'}
                  {entry && i === 0 ? ' (host)' : ''}
                </Text>
              </View>
            );
          })}
        </View>
        {view.canJoin && (
          <Button label="Join" icon={UserPlusIcon} feedback="medium" onPress={onJoin} />
        )}
        {view.canStart && (
          <Button
            label={`Start with ${game.lobby.length} players`}
            icon={PlayIcon}
            variant={full ? 'primary' : 'secondary'}
            onPress={onStart}
          />
        )}
        {joined && !view.isHost && (
          <Text className="text-center text-sm text-muted">
            The game starts when the host starts it or the table is full.
          </Text>
        )}
      </View>
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

function Emotes({
  view,
  now,
  nameOf,
  onEmote,
}: {
  view: LudoNetView;
  now: number;
  nameOf: (userId: string) => string;
  onEmote: (emoji: string) => void;
}) {
  const recent = view.game.emotes.filter((e) => now - e.receivedAt < EMOTE_MS).slice(-3);
  const canSend = view.game.phase === 'lobby' || view.game.phase === 'playing';
  return (
    <View className="items-center gap-2 px-3 pb-4">
      {recent.length > 0 && (
        <View accessibilityLiveRegion="polite" className="flex-row flex-wrap justify-center gap-2">
          {recent.map((e) => (
            <View key={e.eventId} className="rounded-full bg-surface px-3 py-1">
              <Text className="text-sm text-foreground">
                <Text className="font-bold">{nameOf(e.userId)}</Text> {e.emoji}
              </Text>
            </View>
          ))}
        </View>
      )}
      {canSend && (
        <View accessibilityLabel="Send a reaction" className="flex-row gap-1">
          {quickReactions.map((emoji) => (
            <Tap
              key={emoji}
              accessibilityRole="button"
              accessibilityLabel={`Send ${emoji}`}
              feedback="light"
              onPress={() => onEmote(emoji)}
              className="h-11 w-11 items-center justify-center rounded-full"
            >
              <Text className="text-xl">{emoji}</Text>
            </Tap>
          ))}
        </View>
      )}
    </View>
  );
}

function ResultCard({
  view,
  nameOf,
  status,
  onChat,
  onClose,
}: {
  view: LudoNetView;
  nameOf: (userId: string) => string;
  status: string;
  onChat: () => void;
  onClose: () => void;
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
        <Button label="Back to the chat" icon={MessageCircleIcon} onPress={onChat} />
        <Button label="See the board" variant="ghost" onPress={onClose} />
      </View>
    </View>
  );
}
