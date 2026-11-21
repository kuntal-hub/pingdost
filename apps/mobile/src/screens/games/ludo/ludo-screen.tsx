// Ludo against the computer (Phase 41, ADR 0049). The game runs on this phone only; the
// controller from `@pingdost/games` paces the computer players and the animations, and every
// roll and move is saved, so the game survives leaving the screen or closing the app.
import { router, Stack } from 'expo-router';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useWindowDimensions, View } from 'react-native';

import { ActionSheet } from '@/components/action-sheet';
import { Button } from '@/components/button';
import { EmptyState } from '@/components/feedback';
import {
  DicesIcon,
  EllipsisVerticalIcon,
  Icon,
  InfoIcon,
  MedalIcon,
  RotateCcwIcon,
  Trash2Icon,
  TrophyIcon,
  Volume2Icon,
} from '@/components/icon';
import { IconButton } from '@/components/icon-button';
import { Text } from '@/components/text';
import { playGameSound, releaseGameSounds } from '@/games/sounds';
import { useGames } from '@/games/store';
import { haptic, useMotion } from '@/theme/motion';
import { useTheme } from '@/theme/theme-root';
import {
  cornerOf,
  cryptoRandom,
  FAST_PACE,
  HOME,
  LudoController,
  ludoRollNote,
  ludoRules,
  ludoStatus,
  NORMAL_PACE,
  ordinal,
  rotationFor,
  seatName,
  standings,
  YARD,
  type LudoPace,
  type LudoSoloGame,
  type LudoView,
} from '@pingdost/games';

import { LudoBoard } from './board';
import { PlayerPanel } from './panels';
import { LudoPieces, YardGlow } from './pieces';

export function LudoSoloScreen() {
  const loaded = useGames((state) => state.loaded);
  // The game this screen plays: read once, then replaced only by "Play again".
  const [game, setGame] = useState<LudoSoloGame | null>(() => useGames.getState().solo);
  useEffect(() => {
    if (loaded) return;
    void useGames
      .getState()
      .load()
      .then(() => setGame(useGames.getState().solo));
  }, [loaded]);

  if (!game) {
    return (
      <View className="flex-1 bg-background">
        {loaded && (
          <EmptyState
            icon={DicesIcon}
            title="No game in progress"
            message="Choose how many computer players you want and how hard they play."
          >
            <Button label="Set up a game" onPress={() => router.replace('/game/ludo-setup')} />
          </EmptyState>
        )}
      </View>
    );
  }
  return (
    <LudoGame
      key={game.startedAt}
      game={game}
      onPlayAgain={() => setGame(useGames.getState().startSolo(game.options))}
    />
  );
}

/** The saved state of this game if it is the one in storage, else the state it started with. */
function newestState(game: LudoSoloGame): LudoSoloGame['state'] {
  const saved = useGames.getState().solo;
  return saved && saved.startedAt === game.startedAt ? saved.state : game.state;
}

function useLudoView(controller: LudoController | null): LudoView | null {
  const subscribe = useCallback(
    (listener: () => void) => controller?.subscribe(listener) ?? (() => undefined),
    [controller],
  );
  return useSyncExternalStore(subscribe, () => controller?.getView() ?? null);
}

function LudoGame({ game, onPlayAgain }: { game: LudoSoloGame; onPlayAgain: () => void }) {
  const { dark } = useTheme();
  const { moves, level: motion } = useMotion();
  const autoMove = useGames((state) => state.autoMove);
  const pace = motion === 'full' ? NORMAL_PACE : FAST_PACE;
  const { width, height } = useWindowDimensions();
  const size = Math.floor(Math.max(240, Math.min(width - 24, height - 330)));
  const rotation = rotationFor(game.options.you);
  const [controller, setController] = useState<LudoController | null>(null);
  const [menu, setMenu] = useState(false);
  const [rules, setRules] = useState(false);
  // The newest state: if the effect below runs again or the screen remounts (Fast Refresh,
  // StrictMode), the game continues from the saved position, not from where it stood when the
  // screen opened. A finished game stays saved (phase `over`) until a new one replaces it.
  const latest = useRef(newestState(game));

  // Created in an effect so a discarded render never starts timers or saves.
  useEffect(() => {
    const finishedAlready = latest.current.phase === 'over';
    const created = new LudoController({
      state: latest.current,
      seats: game.seats,
      level: game.options.level,
      random: cryptoRandom(),
      pace: motion === 'full' ? NORMAL_PACE : FAST_PACE,
      autoMove: useGames.getState().autoMove,
      onState: (state) => {
        latest.current = state;
        useGames.getState().saveSoloState(state);
      },
      onOver: (place) => {
        if (finishedAlready) return;
        useGames.getState().record('ludo', { solo: game.options.level }, place === 1);
        haptic(place === 1 ? 'success' : 'warning');
      },
    });
    setController(created);
    return () => created.dispose();
    // The controller lives as long as this game; pace and auto-move are updated below.
  }, [game]);
  useEffect(() => controller?.setPace(pace), [controller, pace]);
  useEffect(() => controller?.setAutoMove(autoMove), [controller, autoMove]);

  const view = useLudoView(controller);
  useEventHaptics(view);
  useGameSounds(view, pace, moves);
  const lastDice = useLastDice(view);
  const sounds = useGames((state) => state.sounds);
  useEffect(() => () => releaseGameSounds(), []);

  if (!view || !controller) return <View className="flex-1 bg-background" />;
  const note = ludoRollNote(view);
  const active = view.waiting === 'over' ? null : view.state.players[view.state.current]!;
  const panelWidth = Math.floor((size - 8) / 2);
  const corner = (top: boolean, left: boolean) => {
    const seat = view.state.players.findIndex((player) => {
      const at = cornerOf(player.color, rotation);
      return at.top === top && at.left === left;
    });
    if (seat < 0) return <View style={{ width: panelWidth }} />;
    return (
      <PlayerPanel
        view={view}
        seat={seat}
        level={game.options.level}
        left={left}
        dark={dark}
        moves={moves}
        rollMs={pace.roll}
        lastDie={lastDice[seat] ?? null}
        width={panelWidth}
        onRoll={controller.roll.bind(controller)}
      />
    );
  };

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen
        options={{
          headerRight: () => (
            <IconButton
              icon={EllipsisVerticalIcon}
              label="Game menu"
              onPress={() => setMenu(true)}
            />
          ),
        }}
      />
      <View className="flex-1 items-center justify-center gap-2 px-3 pb-4">
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
            view={view}
            size={size}
            rotation={rotation}
            dark={dark}
            moves={moves}
            hopMs={pace.hop}
            captureMs={pace.capture}
            onMove={controller.move.bind(controller)}
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
            {ludoStatus(view)}
          </Text>
          {note ? <Text className="text-center text-sm text-muted">{note}</Text> : null}
        </View>
      </View>

      {view.waiting === 'over' && (
        <ResultCard view={view} onPlayAgain={onPlayAgain} onDone={() => router.back()} />
      )}

      <ActionSheet
        visible={menu}
        onClose={() => setMenu(false)}
        actions={[
          {
            label: 'New game',
            detail: 'Change the players, difficulty or rules',
            icon: RotateCcwIcon,
            onPress: () => router.replace('/game/ludo-setup'),
          },
          { label: 'Rules', icon: InfoIcon, onPress: () => setRules(true) },
          {
            label: sounds ? 'Turn game sounds off' : 'Turn game sounds on',
            icon: Volume2Icon,
            onPress: () => useGames.getState().setSounds(!sounds),
          },
          {
            label: 'End this game',
            icon: Trash2Icon,
            destructive: true,
            onPress: () => {
              useGames.getState().clearSolo();
              router.back();
            },
          },
        ]}
      />
      <ActionSheet
        visible={rules}
        onClose={() => setRules(false)}
        title="Ludo rules"
        header={
          <View className="gap-2 px-5 pb-2">
            {ludoRules(view.state.settings).map((line) => (
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

/** A haptic for captures, pieces reaching home, and the user's rolls. */
function useEventHaptics(view: LudoView | null): void {
  const seen = useRef({ move: 0, roll: 0 });
  useEffect(() => {
    if (!view) return;
    const move = view.lastMove;
    if (move && move.id !== seen.current.move) {
      seen.current.move = move.id;
      const involvesYou = move.seat === view.you || move.captures.some((c) => c.seat === view.you);
      if (move.captures.length > 0 && involvesYou) haptic('medium');
      else if (move.to === HOME && move.seat === view.you) haptic('success');
    }
  }, [view]);
}

/**
 * Sounds for the game (ADR 0050): the rattle as a die starts tumbling, a tick per hop, a capture
 * or home chime as the piece lands, and a fanfare when the user wins. Scheduled sounds keep
 * playing across re-renders and stop when the screen closes.
 */
function useGameSounds(view: LudoView | null, pace: LudoPace, moves: boolean): void {
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const seen = useRef<{ move: number; rolling: boolean; over: boolean } | null>(null);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    if (!view) return;
    // The first view only sets the baseline: a restored game makes no sound.
    if (!seen.current) {
      seen.current = {
        move: view.lastMove?.id ?? 0,
        rolling: view.waiting === 'rolling',
        over: view.waiting === 'over',
      };
      return;
    }
    const at = (ms: number, kind: Parameters<typeof playGameSound>[0]) =>
      timers.current.push(setTimeout(() => playGameSound(kind), ms));
    const rolling = view.waiting === 'rolling';
    if (rolling && !seen.current.rolling) playGameSound('roll');
    seen.current.rolling = rolling;
    const move = view.lastMove;
    if (move && move.id !== seen.current.move) {
      seen.current.move = move.id;
      const hops = moves ? (move.from === YARD ? 1 : move.to - move.from) : 1;
      const hopMs = moves ? pace.hop : 0;
      for (let i = 0; i < hops; i++) at((i + 0.85) * hopMs, 'hop');
      if (move.captures.length > 0) at(hops * hopMs, 'capture');
      else if (move.to === HOME) at(hops * hopMs, 'home');
    }
    if (view.waiting === 'over' && !seen.current.over) {
      seen.current.over = true;
      if (view.state.players[view.you]!.rank === 1) at(400, 'win');
    }
  }, [view, pace, moves]);
}

/** Each player's last roll, for the die in their panel. */
function useLastDice(view: LudoView | null): Record<number, number> {
  const [dice, setDice] = useState<Record<number, number>>({});
  const rollId = view?.lastRoll?.id;
  useEffect(() => {
    const roll = view?.lastRoll;
    if (roll) setDice((current) => ({ ...current, [roll.seat]: roll.die }));
    // Only a new roll changes the dice.
  }, [rollId]);
  return dice;
}

function ResultCard({
  view,
  onPlayAgain,
  onDone,
}: {
  view: LudoView;
  onPlayAgain: () => void;
  onDone: () => void;
}) {
  const { card } = useTheme();
  const won = view.state.players[view.you]!.rank === 1;
  return (
    // Above the pieces: Fabric flattens the board's wrappers, so the pieces' zIndex would
    // otherwise compete with this overlay (seen on Android 2026-11-21).
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
          <Text className="font-display text-2xl text-foreground">{ludoStatus(view)}</Text>
        </View>
        <View className="gap-1">
          {standings(view.state).map((entry) => (
            <View key={entry.color} className="flex-row justify-between">
              <Text className="text-base text-foreground">
                {entry.rank ? ordinal(entry.rank) : '–'}{' '}
                {seatName(view.seats[entry.seat]!, entry.color)}
              </Text>
            </View>
          ))}
        </View>
        <Button label="Play again" icon={RotateCcwIcon} onPress={onPlayAgain} />
        <Button label="Back to Games" variant="ghost" onPress={onDone} />
      </View>
    </View>
  );
}
