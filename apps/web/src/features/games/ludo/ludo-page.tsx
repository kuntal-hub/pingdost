// Ludo against the computer in the browser (Phase 41, ADR 0049). Everything runs in this tab;
// every roll and move is saved, so a reload continues the game. Keys: Space or R rolls,
// 1–4 move a piece.
import { Bot, Dices, EllipsisVertical, Info, Medal, RotateCcw, Trash2, Trophy } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router';

import { Button, IconButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/controls';
import { Dialog, Menu } from '@/components/ui/menu';
import { useAppearance } from '@/theme';
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

import { ShapeIcon } from '../shape';
import { useGames } from '../store';
import { LudoBoard } from './board';
import { Dice } from './dice';

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
  const current = view.state.players[view.state.current]!;
  const look = gameBoardColors(dark).players[current.color];
  const note = ludoRollNote(view);
  const over = view.waiting === 'over';

  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center gap-4 p-4 md:p-6">
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
      <PlayersStrip view={view} dark={dark} level={game.options.level} />
      <div className="w-[min(100%,calc(100dvh-300px))] min-w-[280px]">
        <LudoBoard
          view={view}
          rotation={rotationFor(game.options.you)}
          dark={dark}
          animate={motion === 'full'}
          hopMs={pace.hop}
          captureMs={pace.capture}
          onMove={(token) => controller.move(token)}
        />
      </div>
      <div className="flex min-h-28 flex-col items-center gap-2">
        <Dice
          value={view.state.die}
          rolling={view.waiting === 'rolling'}
          rollId={view.lastRoll?.id ?? 0}
          look={look}
          ready={view.waiting === 'you-roll'}
          animate={motion === 'full'}
          onRoll={() => controller.roll()}
        />
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
    <ul className="flex flex-wrap justify-center gap-2" aria-label="Players">
      {view.state.players.map((player, seat) => {
        const look = colors.players[player.color];
        const turn = seat === view.state.current && view.waiting !== 'over';
        const home = player.tokens.filter((p) => p === HOME).length;
        const kind = view.seats[seat]!;
        return (
          <li
            key={player.color}
            aria-current={turn ? 'true' : undefined}
            className="pd-card flex items-center gap-2 rounded-full border-2 py-1.5 pr-3 pl-1.5"
            style={{ borderColor: turn ? look.ring : 'transparent' }}
          >
            <span
              className="flex size-7 items-center justify-center rounded-full border-2"
              style={{ backgroundColor: look.fill, borderColor: look.ring }}
            >
              <ShapeIcon color={player.color} size={13} fill={look.on} />
            </span>
            <span className="leading-tight">
              <span className="flex items-center gap-1 text-sm font-bold">
                {seatName(kind, player.color)}
                {kind === 'computer' && (
                  <>
                    <Bot aria-hidden size={13} className="text-muted" />
                    <span className="sr-only">computer, {BOT_LEVEL_NAMES[level]}</span>
                  </>
                )}
              </span>
              <span className="block text-xs text-muted">
                {player.rank ? ordinal(player.rank) : `${home}/${player.tokens.length} home`}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
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
