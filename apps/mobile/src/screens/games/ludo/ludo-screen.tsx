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
  BotIcon,
  DicesIcon,
  EllipsisVerticalIcon,
  Icon,
  InfoIcon,
  MedalIcon,
  RotateCcwIcon,
  Trash2Icon,
  TrophyIcon,
} from '@/components/icon';
import { IconButton } from '@/components/icon-button';
import { Text } from '@/components/text';
import { useGames } from '@/games/store';
import { haptic, useMotion } from '@/theme/motion';
import { useTheme } from '@/theme/theme-root';
import {
  BOT_LEVEL_NAMES,
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
  type LudoSoloGame,
  type LudoView,
} from '@pingdost/games';
import { gameBoardColors } from '@pingdost/ui-tokens';

import { ShapeGlyph } from '../shape';
import { LudoBoard } from './board';
import { Dice } from './dice';
import { LudoPieces } from './pieces';

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

  if (!view || !controller) return <View className="flex-1 bg-background" />;
  const current = view.state.players[view.state.current]!;
  const look = gameBoardColors(dark).players[current.color];
  const note = ludoRollNote(view);

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
      <View className="flex-1 items-center justify-center gap-4 px-3 pb-4">
        <PlayersStrip view={view} dark={dark} level={game.options.level} />
        <View style={{ width: size, height: size }}>
          <LudoBoard size={size} rotation={rotation} dark={dark} />
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
        <View className="min-h-[132px] items-center gap-2">
          <Dice
            value={view.state.die}
            rolling={view.waiting === 'rolling'}
            rollId={view.lastRoll?.id ?? 0}
            look={look}
            ready={view.waiting === 'you-roll'}
            onRoll={controller.roll.bind(controller)}
            size={64}
            moves={moves}
          />
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

function PlayersStrip({
  view,
  dark,
  level,
}: {
  view: LudoView;
  dark: boolean;
  level: LudoSoloGame['options']['level'];
}) {
  const colors = gameBoardColors(dark);
  return (
    <View className="flex-row flex-wrap justify-center gap-2">
      {view.state.players.map((player, seat) => {
        const look = colors.players[player.color];
        const turn = seat === view.state.current && view.waiting !== 'over';
        const home = player.tokens.filter((p) => p === HOME).length;
        const kind = view.seats[seat]!;
        return (
          <View
            key={player.color}
            accessibilityLabel={`${seatName(kind, player.color)}${kind === 'computer' ? `, computer, ${BOT_LEVEL_NAMES[level]}` : ''}, ${home} of ${player.tokens.length} pieces home${turn ? ', playing now' : ''}${player.rank ? `, finished ${ordinal(player.rank)}` : ''}`}
            className="flex-row items-center gap-2 rounded-full bg-surface py-1.5 pl-1.5 pr-3"
            style={{ borderWidth: 2, borderColor: turn ? look.ring : 'transparent' }}
          >
            <View
              className="items-center justify-center rounded-full"
              style={{
                width: 28,
                height: 28,
                backgroundColor: look.fill,
                borderWidth: 2,
                borderColor: look.ring,
              }}
            >
              <ShapeGlyph color={player.color} size={13} fill={look.on} />
            </View>
            <View>
              <View className="flex-row items-center gap-1">
                <Text className="text-sm font-bold text-foreground">
                  {seatName(kind, player.color)}
                </Text>
                {kind === 'computer' && <Icon icon={BotIcon} size={13} color="muted" />}
              </View>
              <Text className="text-xs text-muted">
                {player.rank ? ordinal(player.rank) : `${home}/${player.tokens.length} home`}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
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
