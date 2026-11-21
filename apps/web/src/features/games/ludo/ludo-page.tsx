// Ludo against the computer in the browser (Phase 41, ADR 0049). Everything runs in this tab;
// every roll and move is saved, so a reload continues the game. Keys: Space or R rolls,
// 1–4 move a piece.
import {
  Dices,
  EllipsisVertical,
  Info,
  Medal,
  RotateCcw,
  Trash2,
  Trophy,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router';

import { Button, IconButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/controls';
import { Dialog, Menu } from '@/components/ui/menu';
import { useAppearance } from '@/theme';
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

import { playGameSound } from '../sounds';
import { useGames } from '../store';
import { LudoBoard } from './board';
import { PlayerPanel } from './panels';

function useMotionLevel(): 'full' | 'calm' | 'off' {
  const setting = useAppearance((state) => state.prefs.motion);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return setting === 'full' && reduced ? 'calm' : setting;
}

export function LudoPage() {
  const navigate = useNavigate();
  const [game, setGame] = useState<LudoSoloGame | null>(() => useGames.getState().solo);
  if (!game) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <EmptyState icon={Dices} title="No game in progress">
          <p className="text-muted">
            Choose how many computer players you want and how hard they play.
          </p>
          <Button onClick={() => void navigate('/games/ludo/setup', { replace: true })}>
            Set up a game
          </Button>
        </EmptyState>
      </div>
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

/** The saved state of this game if it is the one in storage, else the state it came with. */
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
  const navigate = useNavigate();
  const dark = useAppearance((state) => state.dark);
  const motion = useMotionLevel();
  const autoMove = useGames((state) => state.autoMove);
  const pace = motion === 'full' ? NORMAL_PACE : FAST_PACE;
  const [controller, setController] = useState<LudoController | null>(null);
  const [rules, setRules] = useState(false);

  // The newest state: if the effect below runs again or the page remounts (HMR, StrictMode),
  // the game continues from the saved position, not from where it stood when the page opened.
  // A finished game stays saved (phase `over`) until a new one replaces it.
  const latest = useRef(newestState(game));

  // Created in an effect so a discarded render never starts timers or saves.
  useEffect(() => {
    const finishedAlready = latest.current.phase === 'over';
    const created = new LudoController({
      state: latest.current,
      seats: game.seats,
      level: game.options.level,
      random: cryptoRandom(),
      pace: NORMAL_PACE,
      autoMove: useGames.getState().autoMove,
      onState: (state) => {
        latest.current = state;
        useGames.getState().saveSoloState(state);
      },
      onOver: (place) => {
        if (finishedAlready) return;
        useGames.getState().record('ludo', { solo: game.options.level }, place === 1);
      },
    });
    setController(created);
    return () => created.dispose();
  }, [game]);
  useEffect(() => controller?.setPace(pace), [controller, pace]);
  useEffect(() => controller?.setAutoMove(autoMove), [controller, autoMove]);

  const view = useLudoView(controller);
  useGameSounds(view, pace, motion === 'full');
  const lastDice = useLastDice(view);
  const sounds = useGames((state) => state.sounds);

  // Space or R rolls; 1–4 move that piece.
  useEffect(() => {
    if (!controller) return;
    const keys = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, [role="dialog"], [role="menu"]')) return;
      if (event.key === ' ' || event.key.toLowerCase() === 'r') {
        if (target?.closest('button, [role="button"]') && event.key === ' ') return;
        event.preventDefault();
        controller.roll();
      } else if (/^[1-4]$/.test(event.key)) {
        controller.move(Number(event.key) - 1);
      }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [controller]);

  if (!view || !controller) return null;
  const note = ludoRollNote(view);
  const over = view.waiting === 'over';
  const rotation = rotationFor(game.options.you);
  const corner = (top: boolean, left: boolean) => {
    const seat = view.state.players.findIndex((player) => {
      const at = cornerOf(player.color, rotation);
      return at.top === top && at.left === left;
    });
    if (seat < 0) return <div className="min-w-0 flex-1" />;
    return (
      <PlayerPanel
        view={view}
        seat={seat}
        level={game.options.level}
        left={left}
        dark={dark}
        animate={motion === 'full'}
        rollMs={pace.roll}
        lastDie={lastDice[seat] ?? null}
        onRoll={() => controller.roll()}
      />
    );
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center gap-2 p-4 md:p-5">
      <div className="flex w-full items-center gap-2">
        <h1 className="flex-1 font-display text-2xl font-extrabold">Ludo</h1>
        <Menu
          label="Game menu"
          trigger={
            <IconButton aria-label="Game menu">
              <EllipsisVertical aria-hidden size={20} />
            </IconButton>
          }
          items={[
            {
              label: 'New game',
              icon: RotateCcw,
              onSelect: () => void navigate('/games/ludo/setup'),
            },
            { label: 'Rules', icon: Info, onSelect: () => setRules(true) },
            {
              label: sounds ? 'Turn game sounds off' : 'Turn game sounds on',
              icon: sounds ? VolumeX : Volume2,
              onSelect: () => useGames.getState().setSounds(!sounds),
            },
            {
              label: 'End this game',
              icon: Trash2,
              destructive: true,
              onSelect: () => {
                useGames.getState().clearSolo();
                void navigate('/games');
              },
            },
          ]}
        />
      </div>
      <div className="flex w-[min(100%,calc(100dvh-270px))] min-w-[340px] flex-col gap-2">
        <div className="flex gap-2">
          {corner(true, true)}
          {corner(true, false)}
        </div>
        <LudoBoard
          view={view}
          rotation={rotation}
          dark={dark}
          animate={motion === 'full'}
          hopMs={pace.hop}
          captureMs={pace.capture}
          onMove={(token) => controller.move(token)}
        />
        <div className="flex gap-2">
          {corner(false, true)}
          {corner(false, false)}
        </div>
      </div>
      <div className="flex min-h-14 flex-col items-center gap-1">
        <p aria-live="polite" className="text-center font-bold">
          {ludoStatus(view)}
        </p>
        {note && <p className="text-center text-sm text-muted">{note}</p>}
        {view.waiting === 'you-move' && (
          <p className="text-center text-xs text-muted">Click a highlighted piece, or press 1–4.</p>
        )}
      </div>

      <Dialog open={over} onOpenChange={() => undefined} title={over ? ludoStatus(view) : 'Ludo'}>
        <ResultBody view={view} onPlayAgain={onPlayAgain} onDone={() => void navigate('/games')} />
      </Dialog>
      <Dialog open={rules} onOpenChange={setRules} title="Ludo rules">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {ludoRules(view.state.settings).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <Button variant="secondary" onClick={() => setRules(false)}>
          Close
        </Button>
      </Dialog>
    </div>
  );
}

/**
 * Sounds for the game (ADR 0050): the rattle as a die starts tumbling, a tick per hop, a capture
 * or home chime as the piece lands, and a fanfare when the user wins.
 */
function useGameSounds(view: LudoView | null, pace: LudoPace, animate: boolean): void {
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
      const hops = animate ? (move.from === YARD ? 1 : move.to - move.from) : 1;
      const hopMs = animate ? pace.hop : 0;
      for (let i = 0; i < hops; i++) at((i + 0.85) * hopMs, 'hop');
      if (move.captures.length > 0) at(hops * hopMs, 'capture');
      else if (move.to === HOME) at(hops * hopMs, 'home');
    }
    if (view.waiting === 'over' && !seen.current.over) {
      seen.current.over = true;
      if (view.state.players[view.you]!.rank === 1) at(400, 'win');
    }
  }, [view, pace, animate]);
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

function ResultBody({
  view,
  onPlayAgain,
  onDone,
}: {
  view: LudoView;
  onPlayAgain: () => void;
  onDone: () => void;
}) {
  const won = view.state.players[view.you]!.rank === 1;
  const Glyph = won ? Trophy : Medal;
  return (
    <>
      <Glyph aria-hidden size={44} className="mx-auto text-accent" />
      <ol className="space-y-1">
        {standings(view.state).map((entry) => (
          <li key={entry.color}>
            {entry.rank ? ordinal(entry.rank) : '–'} ·{' '}
            {seatName(view.seats[entry.seat]!, entry.color)}
          </li>
        ))}
      </ol>
      <Button onClick={onPlayAgain}>
        <RotateCcw aria-hidden size={18} />
        Play again
      </Button>
      <Button variant="ghost" onClick={onDone}>
        Back to Games
      </Button>
    </>
  );
}
