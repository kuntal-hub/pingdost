// A turn game against the computer (Phase 43, ADR 0049): Tic-Tac-Toe, Connect Four, Dots and
// Boxes or Snakes and Ladders. The game runs on this phone only; `TurnController` paces the
// computer players and every step is saved, so the game survives leaving the screen. Play again
// lets the other side start.
import { router, Stack } from 'expo-router';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useWindowDimensions, View } from 'react-native';

import { ActionSheet } from '@/components/action-sheet';
import { Button } from '@/components/button';
import { EmptyState } from '@/components/feedback';
import {
  EllipsisVerticalIcon,
  GAME_ICONS,
  Icon,
  InfoIcon,
  MedalIcon,
  RotateCcwIcon,
  Trash2Icon,
  FlagIcon,
  TrophyIcon,
  UsersRoundIcon,
  Volume2Icon,
} from '@/components/icon';
import { IconButton } from '@/components/icon-button';
import { Text } from '@/components/text';
import { releaseGameSounds } from '@/games/sounds';
import { useGames } from '@/games/store';
import { useMotion } from '@/theme/motion';
import { useTheme } from '@/theme/theme-root';
import {
  catalogEntry,
  cryptoRandom,
  FAST_TURN_PACE,
  isDraw,
  NORMAL_TURN_PACE,
  ordinal,
  TurnController,
  turnResultLine,
  turnRules,
  turnSoloStatus,
  turnStandings,
  chessInCheck,
  type ChessState,
  type AnyTurnRules,
  type TurnCore,
  type TurnGameId,
  type TurnSoloGame,
  type TurnView,
} from '@pingdost/games';

import {
  ChessMoves,
  PlayersStrip,
  TurnBoard,
  turnBoardWidth,
  TurnDie,
  useTurnFeedback,
} from './turn-parts';

export function TurnSoloScreen({ game: id }: { game: TurnGameId }) {
  const loaded = useGames((state) => state.loaded);
  const [game, setGame] = useState<TurnSoloGame | null>(
    () => useGames.getState().turnSolo[id] ?? null,
  );
  useEffect(() => {
    if (loaded) return;
    void useGames
      .getState()
      .load()
      .then(() => setGame(useGames.getState().turnSolo[id] ?? null));
  }, [loaded, id]);
  const entry = catalogEntry(id);

  if (!game) {
    return (
      <View className="flex-1 bg-background">
        <Stack.Screen options={{ title: entry.name }} />
        {loaded && (
          <EmptyState
            icon={GAME_ICONS[entry.icon]}
            title="No game in progress"
            message="Choose how the computer plays and start a game."
          >
            <Button
              label="Set up a game"
              onPress={() => router.replace({ pathname: '/game/setup', params: { game: id } })}
            />
          </EmptyState>
        )}
      </View>
    );
  }
  return (
    <TurnSoloGameView
      key={game.startedAt}
      rules={turnRules(id)}
      game={game}
      onPlayAgain={() =>
        setGame(
          useGames.getState().startTurnSolo(id, game.options, (game.first + 1) % game.seats.length),
        )
      }
    />
  );
}

/** The saved state of this game if it is the one in storage, else the state it started with. */
function newestState(game: TurnSoloGame): TurnCore {
  const saved = useGames.getState().turnSolo[game.game];
  return saved && saved.startedAt === game.startedAt ? saved.state : game.state;
}

function useTurnView(controller: TurnController<TurnCore, unknown, unknown> | null) {
  const subscribe = useCallback(
    (listener: () => void) => controller?.subscribe(listener) ?? (() => undefined),
    [controller],
  );
  return useSyncExternalStore(subscribe, () => controller?.getView() ?? null);
}

function TurnSoloGameView({
  rules,
  game,
  onPlayAgain,
}: {
  rules: AnyTurnRules;
  game: TurnSoloGame;
  onPlayAgain: () => void;
}) {
  const { dark } = useTheme();
  const { moves, level: motion } = useMotion();
  const pace = motion === 'full' ? NORMAL_TURN_PACE : FAST_TURN_PACE;
  const { width, height } = useWindowDimensions();
  const size = turnBoardWidth(rules, width, height);
  const [controller, setController] = useState<TurnController<TurnCore, unknown, unknown> | null>(
    null,
  );
  const [menu, setMenu] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [resultSeen, setResultSeen] = useState(false);
  const sounds = useGames((state) => state.sounds);
  const latest = useRef(newestState(game));
  const name = catalogEntry(rules.id).name;

  // Created in an effect so a discarded render never starts computer turns or saves; it starts
  // from the newest saved state (Fast Refresh runs this again).
  useEffect(() => {
    const created = new TurnController<TurnCore, unknown, unknown>({
      rules,
      state: latest.current,
      seats: game.seats,
      level: game.options.level,
      random: cryptoRandom(),
      pace: motion === 'full' ? NORMAL_TURN_PACE : FAST_TURN_PACE,
      onState: (state) => {
        latest.current = state;
        useGames.getState().saveTurnState(rules.id, game.startedAt, state);
      },
      onOver: (place, state) => {
        useGames
          .getState()
          .record(rules.id, { solo: game.options.level }, place === 1 && !isDraw(state));
      },
    });
    setController(created);
    return () => created.dispose();
    // The controller lives as long as this game; the pace is updated below.
  }, [game, rules]);
  useEffect(() => controller?.setPace(pace), [controller, pace]);
  useEffect(() => () => releaseGameSounds(), []);

  const view = useTurnView(controller);
  useTurnFeedback(rules, view, pace, moves);
  if (!view || !controller) return <View className="flex-1 bg-background" />;
  const seatName = (seat: number) =>
    seat === view.you ? 'You' : game.seats.length === 2 ? 'Computer' : `Computer ${seat}`;
  const over = view.waiting === 'over';
  const playWithFriends = () =>
    router.push({ pathname: '/game/pick-chat', params: { game: rules.id } });

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen
        options={{
          title: name,
          headerRight: () => (
            <IconButton
              icon={EllipsisVerticalIcon}
              label="Game menu"
              onPress={() => setMenu(true)}
            />
          ),
        }}
      />
      <View className="flex-1 items-center justify-center gap-3 px-3 pb-4">
        <PlayersStrip
          rules={rules}
          state={view.state}
          names={seatName}
          over={over}
          timeLeft={null}
        />
        <TurnBoard
          rules={rules}
          state={view.state}
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
          state={view.state}
          waiting={view.waiting}
          last={view.last}
          you={view.you}
          moves={moves}
          pace={pace}
          onRoll={() => controller.roll()}
        />
        <Text
          accessibilityLiveRegion="polite"
          className="min-h-[24px] text-center text-base font-bold text-foreground"
        >
          {turnSoloStatus(rules, view)}
          {rules.id === 'chess' && chessInCheck(view.state as ChessState) ? ' · Check' : ''}
        </Text>
        {rules.id === 'chess' && <ChessMoves state={view.state as ChessState} />}
      </View>

      {over && !resultSeen && (
        <SoloResult
          rules={rules}
          view={view}
          names={seatName}
          onPlayAgain={onPlayAgain}
          onFriends={playWithFriends}
          onClose={() => setResultSeen(true)}
        />
      )}

      <ActionSheet
        visible={menu}
        onClose={() => setMenu(false)}
        actions={[
          {
            label: 'New game',
            detail: 'Change the computer players or options',
            icon: RotateCcwIcon,
            onPress: () => router.replace({ pathname: '/game/setup', params: { game: rules.id } }),
          },
          {
            label: 'Play with friends',
            detail: 'Invite someone in a chat',
            icon: UsersRoundIcon,
            onPress: playWithFriends,
          },
          { label: 'Rules', icon: InfoIcon, onPress: () => setRulesOpen(true) },
          {
            label: sounds ? 'Turn game sounds off' : 'Turn game sounds on',
            icon: Volume2Icon,
            onPress: () => useGames.getState().setSounds(!sounds),
          },
          ...(rules.id === 'chess' && !over
            ? [
                {
                  label: 'Resign',
                  detail: 'The computer wins this game',
                  icon: FlagIcon,
                  destructive: true,
                  onPress: () => controller.resign(),
                },
              ]
            : []),
          {
            label: 'End this game',
            icon: Trash2Icon,
            destructive: true,
            onPress: () => {
              useGames.getState().clearTurnSolo(rules.id);
              router.back();
            },
          },
        ]}
      />
      <RulesSheet
        rules={rules}
        settings={game.options.settings}
        visible={rulesOpen}
        onClose={() => setRulesOpen(false)}
      />
    </View>
  );
}

export function RulesSheet({
  rules,
  settings,
  visible,
  onClose,
  extra = [],
}: {
  rules: AnyTurnRules;
  settings: unknown;
  visible: boolean;
  onClose: () => void;
  extra?: string[];
}) {
  return (
    <ActionSheet
      visible={visible}
      onClose={onClose}
      title={`${catalogEntry(rules.id).name} rules`}
      header={
        <View className="gap-2 px-5 pb-2">
          {[...rules.rulesText(settings), ...extra].map((line) => (
            <Text key={line} className="text-sm text-foreground">
              • {line}
            </Text>
          ))}
        </View>
      }
      actions={[{ label: 'Close', onPress: onClose }]}
    />
  );
}

/** The result over the board: who won, the score, places with more than two players. */
export function ResultPanel({
  rules,
  state,
  you,
  names,
  children,
}: {
  rules: AnyTurnRules;
  state: TurnCore;
  you: number;
  names: (seat: number) => string;
  children: ReactNode;
}) {
  const { card } = useTheme();
  const won = you >= 0 && state.ranks?.[you] === 1 && !isDraw(state) && !state.left[you];
  const detail = rules.resultDetail?.(state) ?? null;
  return (
    // Above the board's pieces (Fabric flattens wrappers; see the Ludo screens).
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
          <Icon icon={won ? TrophyIcon : MedalIcon} size={44} color="accent" />
          <Text className="text-center font-display text-2xl text-foreground">
            {turnResultLine(state, you, names)}
          </Text>
          {detail && <Text className="text-center text-sm text-muted">{detail}</Text>}
        </View>
        {state.seats > 2 && (
          <View className="gap-1">
            {turnStandings(state).map((entry) => (
              <Text key={entry.seat} className="text-base text-foreground">
                {entry.left ? 'Left' : ordinal(entry.rank)} · {names(entry.seat)} (
                {rules.sideName(state, entry.seat)})
              </Text>
            ))}
          </View>
        )}
        {children}
      </View>
    </View>
  );
}

function SoloResult({
  rules,
  view,
  names,
  onPlayAgain,
  onFriends,
  onClose,
}: {
  rules: AnyTurnRules;
  view: TurnView<TurnCore, unknown>;
  names: (seat: number) => string;
  onPlayAgain: () => void;
  onFriends: () => void;
  onClose: () => void;
}) {
  return (
    <ResultPanel rules={rules} state={view.state} you={view.you} names={names}>
      <Button label="Play again" icon={RotateCcwIcon} onPress={onPlayAgain} />
      <Button
        label="Play with friends"
        icon={UsersRoundIcon}
        variant="secondary"
        onPress={onFriends}
      />
      <Button label="See the board" variant="ghost" onPress={onClose} />
    </ResultPanel>
  );
}
