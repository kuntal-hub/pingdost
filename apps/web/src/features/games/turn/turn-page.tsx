// A turn game against the computer in the browser (Phase 43, ADR 0049). The game runs in this
// tab; `TurnController` paces the computer players and every step is saved to localStorage, so a
// reload continues it. Play again lets the other side start.
import {
  EllipsisVertical,
  Info,
  Medal,
  RotateCcw,
  Flag,
  Trophy,
  UsersRound,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';

import { Button, IconButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/controls';
import { Dialog, Menu } from '@/components/ui/menu';
import { useAppearance } from '@/theme';
import {
  catalogEntry,
  cryptoRandom,
  FAST_TURN_PACE,
  isDraw,
  isTurnGameId,
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
} from '@pingdost/games';

import { GAME_ICONS } from '../game-icons';
import { QuitDialog, type QuitAsk } from '../quit-dialog';
import { useGames } from '../store';
import { TurnBoard } from './boards';
import {
  ChessMoves,
  PlayersStrip,
  TurnDie,
  useMotionLevel,
  useTurnKeys,
  useTurnSounds,
} from './turn-parts';

export function TurnPage() {
  const { game = '' } = useParams();
  if (!isTurnGameId(game)) return <Navigate to="/games" replace />;
  return <TurnSolo key={game} id={game} />;
}

function TurnSolo({ id }: { id: TurnGameId }) {
  const [game, setGame] = useState<TurnSoloGame | null>(
    () => useGames.getState().turnSolo[id] ?? null,
  );
  const entry = catalogEntry(id);
  if (!game) {
    const Glyph = GAME_ICONS[entry.icon];
    return (
      <div className="mx-auto max-w-2xl p-6">
        <EmptyState icon={Glyph} title="No game in progress">
          <p className="text-muted">Choose how the computer plays and start a game.</p>
          <Button asChild>
            <Link to={`/games/${id}/setup`}>Set up a game</Link>
          </Button>
        </EmptyState>
      </div>
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

function newestState(game: TurnSoloGame): TurnCore {
  const saved = useGames.getState().turnSolo[game.game];
  return saved && saved.startedAt === game.startedAt ? saved.state : game.state;
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
  const navigate = useNavigate();
  const dark = useAppearance((state) => state.dark);
  const motion = useMotionLevel();
  const pace = motion === 'full' ? NORMAL_TURN_PACE : FAST_TURN_PACE;
  const sounds = useGames((state) => state.sounds);
  const [controller, setController] = useState<TurnController<TurnCore, unknown, unknown> | null>(
    null,
  );
  const [rulesOpen, setRulesOpen] = useState(false);
  const [resultSeen, setResultSeen] = useState(false);
  const [quit, setQuit] = useState<QuitAsk | null>(null);
  const latest = useRef(newestState(game));
  const name = catalogEntry(rules.id).name;

  // Created in an effect (a discarded render never starts computer turns), from the newest save.
  useEffect(() => {
    const created = new TurnController<TurnCore, unknown, unknown>({
      rules,
      state: latest.current,
      seats: game.seats,
      level: game.options.level,
      random: cryptoRandom(),
      pace,
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
    // The pace is applied below without a new controller.
  }, [game, rules]);
  useEffect(() => controller?.setPace(pace), [controller, pace]);

  const subscribe = useCallback(
    (listener: () => void) => controller?.subscribe(listener) ?? (() => undefined),
    [controller],
  );
  const view = useSyncExternalStore(subscribe, () => controller?.getView() ?? null);
  useTurnSounds(rules, view, pace, motion === 'full');
  useTurnKeys(rules, controller);
  if (!view || !controller) return null;
  const seatName = (seat: number) =>
    seat === view.you ? 'You' : game.seats.length === 2 ? 'Computer' : `Computer ${seat}`;
  const over = view.waiting === 'over';
  const chess = rules.id === 'chess';
  const friends = `/games/friends/${rules.id}`;

  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center gap-3 p-4 md:p-5">
      <div className="flex w-full items-center gap-2">
        <h1 className="flex-1 font-display text-2xl font-extrabold">{name}</h1>
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
              onSelect: () => void navigate(`/games/${rules.id}/setup`),
            },
            {
              label: 'Play with friends',
              icon: UsersRound,
              onSelect: over
                ? () => void navigate(friends)
                : () =>
                    setQuit({
                      title: 'Play with friends?',
                      confirm: 'End and invite',
                      run: () => {
                        controller.resign();
                        void navigate(friends);
                      },
                    }),
            },
            { label: 'Rules', icon: Info, onSelect: () => setRulesOpen(true) },
            {
              label: sounds ? 'Turn game sounds off' : 'Turn game sounds on',
              icon: sounds ? VolumeX : Volume2,
              onSelect: () => useGames.getState().setSounds(!sounds),
            },
            ...(over
              ? []
              : [
                  {
                    label: chess ? 'Resign' : 'End this game',
                    icon: Flag,
                    destructive: true,
                    onSelect: () =>
                      setQuit({
                        title: chess ? 'Resign?' : 'End this game?',
                        confirm: chess ? 'Resign' : 'End game',
                        run: () => controller.resign(),
                      }),
                  },
                ]),
          ]}
        />
      </div>
      <PlayersStrip rules={rules} state={view.state} names={seatName} over={over} timeLeft={null} />
      <div className="w-[min(100%,calc(100dvh-320px))] min-w-[300px]">
        <TurnBoard
          rules={rules}
          state={view.state}
          you={view.you}
          legal={view.legal}
          last={view.last}
          onMove={(move) => controller.move(move)}
          dark={dark}
          animate={motion === 'full'}
          pace={pace}
          names={seatName}
        />
      </div>
      <TurnDie
        rules={rules}
        state={view.state}
        waiting={view.waiting}
        last={view.last}
        you={view.you}
        animate={motion === 'full'}
        pace={pace}
        onRoll={() => controller.roll()}
      />
      <p aria-live="polite" className="min-h-6 text-center font-bold">
        {turnSoloStatus(rules, view)}
        {rules.id === 'chess' && chessInCheck(view.state as ChessState) ? ' · Check' : ''}
      </p>
      {rules.id === 'chess' && <ChessMoves state={view.state as ChessState} />}

      <ResultDialog
        open={over && !resultSeen}
        onClose={() => setResultSeen(true)}
        rules={rules}
        state={view.state}
        you={view.you}
        names={seatName}
      >
        <Button onClick={onPlayAgain}>
          <RotateCcw aria-hidden size={18} />
          Play again
        </Button>
        <Button variant="secondary" onClick={() => void navigate(friends)}>
          <UsersRound aria-hidden size={18} />
          Play with friends
        </Button>
        <Button variant="ghost" onClick={() => setResultSeen(true)}>
          See the board
        </Button>
      </ResultDialog>
      <QuitDialog ask={quit} onClose={() => setQuit(null)} />
      <RulesDialog
        rules={rules}
        settings={game.options.settings}
        open={rulesOpen}
        onOpenChange={setRulesOpen}
      />
    </div>
  );
}

export function RulesDialog({
  rules,
  settings,
  open,
  onOpenChange,
  extra = [],
}: {
  rules: AnyTurnRules;
  settings: unknown;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  extra?: string[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`${catalogEntry(rules.id).name} rules`}>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {[...rules.rulesText(settings), ...extra].map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <Button variant="secondary" onClick={() => onOpenChange(false)}>
        Close
      </Button>
    </Dialog>
  );
}

export function ResultDialog({
  open,
  onClose,
  rules,
  state,
  you,
  names,
  children,
}: {
  open: boolean;
  onClose: () => void;
  rules: AnyTurnRules;
  state: TurnCore;
  you: number;
  names: (seat: number) => string;
  children: ReactNode;
}) {
  const won = you >= 0 && state.ranks?.[you] === 1 && !isDraw(state) && !state.left[you];
  const detail = rules.resultDetail?.(state) ?? null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={turnResultLine(state, you, names)}
    >
      {won ? (
        <Trophy aria-hidden size={44} className="mx-auto text-accent" />
      ) : (
        <Medal aria-hidden size={44} className="mx-auto text-accent" />
      )}
      {detail && <p className="text-center text-sm text-muted">{detail}</p>}
      {state.seats > 2 && (
        <ol className="space-y-1">
          {turnStandings(state).map((entry) => (
            <li key={entry.seat}>
              {entry.left ? 'Left' : ordinal(entry.rank)} · {names(entry.seat)} (
              {rules.sideName(state, entry.seat)})
            </li>
          ))}
        </ol>
      )}
      {children}
    </Dialog>
  );
}
