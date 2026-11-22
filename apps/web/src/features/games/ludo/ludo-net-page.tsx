// Ludo with friends in the browser (Phase 42, ADR 0049): the lobby (join, start), then the
// board with each person's name, a 30 s ring around the player on the clock, quick emotes and
// a way back to the chat. Moves are E2EE game events in the chat; this tab folds them.
import {
  Dices,
  DoorOpen,
  EllipsisVertical,
  Info,
  Medal,
  MessageCircle,
  OctagonX,
  Trophy,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import { useNames } from '@/chat/hooks';
import { Button, IconButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/controls';
import { Dialog, Menu } from '@/components/ui/menu';
import { useAppearance } from '@/theme';
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

import {
  ChatButton,
  DesyncNotice,
  MessageToasts,
  NetEmotes,
  NetLobby,
  RematchButton,
  useMarkActiveGame,
} from '../net-parts';
import { useNow, useLudoNetGame } from '../network';
import { useGames } from '../store';
import { LudoBoard } from './board';
import { useGameSounds, useLastDice } from './ludo-page';
import { PlayerPanel } from './panels';

function useMotionLevel(): 'full' | 'calm' | 'off' {
  const setting = useAppearance((state) => state.prefs.motion);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return setting === 'full' && reduced ? 'calm' : setting;
}

export function LudoNetPage() {
  const { gameId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const names = useNames();
  const dark = useAppearance((state) => state.dark);
  const motion = useMotionLevel();
  const autoMove = useGames((state) => state.autoMove);
  const sounds = useGames((state) => state.sounds);
  const pace = motion === 'full' ? NORMAL_PACE : FAST_PACE;
  const { controller, view, record } = useLudoNetGame(gameId, pace, autoMove);
  const [rules, setRules] = useState(false);
  const [resultSeen, setResultSeen] = useState(false);
  const board = view?.board ?? null;
  useGameSounds(board, pace, motion === 'full');
  const lastDice = useLastDice(board);
  const playing = view?.game.phase === 'playing';
  const now = useNow(playing || (view?.game.emotes.length ?? 0) > 0);
  const nameOf = (userId: string) => (userId === names.selfUserId ? 'You' : names.name(userId));
  useMarkActiveGame(record ? { gameId, conversationId: record.conversationId } : null);

  // "Join" on the chat card opens the game and joins it.
  const joinAsked = params.get('join') === '1';
  useEffect(() => {
    if (!joinAsked || !controller || !view) return;
    if (view.canJoin) controller.join();
    setParams({}, { replace: true });
  }, [joinAsked, controller, view, setParams]);

  // Space or R rolls; 1–4 move that piece.
  const latest = useRef(controller);
  latest.current = controller;
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, [role="dialog"], [role="menu"]')) return;
      if (event.key === ' ' || event.key.toLowerCase() === 'r') {
        if (target?.closest('button, [role="button"]') && event.key === ' ') return;
        event.preventDefault();
        latest.current?.roll();
      } else if (/^[1-4]$/.test(event.key)) {
        latest.current?.move(Number(event.key) - 1);
      }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, []);

  if (!view || !controller) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <EmptyState icon={Dices} title="Opening the game…">
          <p className="text-muted">Games with friends live in their chat.</p>
        </EmptyState>
      </div>
    );
  }
  const { game } = view;
  const status = ludoNetStatus(view, (id) => (id === names.selfUserId ? 'You' : names.name(id)));
  const chatLink = record ? `/chat/${record.conversationId}` : '/';
  const over = game.phase === 'over' || game.phase === 'ended';
  const left = view.you >= 0 && board?.state.players[view.you]?.left === true;

  const menuItems = [
    { label: 'Rules', icon: Info, onSelect: () => setRules(true) },
    {
      label: sounds ? 'Turn game sounds off' : 'Turn game sounds on',
      icon: sounds ? VolumeX : Volume2,
      onSelect: () => useGames.getState().setSounds(!sounds),
    },
    ...((game.phase === 'lobby' || game.phase === 'playing') &&
    (view.you >= 0 || game.lobby.some((e) => e.userId === names.selfUserId)) &&
    !left
      ? [
          {
            label: 'Leave the game',
            icon: DoorOpen,
            destructive: true,
            onSelect: () => controller.leave(),
          },
        ]
      : []),
    ...(view.isHost && (game.phase === 'lobby' || game.phase === 'playing')
      ? [
          {
            label: 'End for everyone',
            icon: OctagonX,
            destructive: true,
            onSelect: () => controller.end(),
          },
        ]
      : []),
  ];

  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center gap-2 p-4 md:p-5">
      <div className="flex w-full items-center gap-2">
        <h1 className="flex-1 font-display text-2xl font-extrabold">Ludo</h1>
        <ChatButton
          conversationId={record?.conversationId}
          onOpen={() => void navigate(chatLink)}
        />
        <Menu
          label="Game menu"
          trigger={
            <IconButton aria-label="Game menu">
              <EllipsisVertical aria-hidden size={20} />
            </IconButton>
          }
          items={menuItems}
        />
      </div>

      <DesyncNotice view={view} />

      {game.phase === 'lobby' || game.phase === 'missing' || game.phase === 'invalid' || !board ? (
        <NetLobby
          view={view}
          type="ludo"
          selfUserId={names.selfUserId}
          nameOf={nameOf}
          onJoin={() => controller.join()}
          onStart={() => controller.start()}
          status={status}
        />
      ) : (
        <>
          <Table
            view={view}
            nameOf={nameOf}
            dark={dark}
            animate={motion === 'full'}
            pace={pace}
            lastDice={lastDice}
            now={now}
            onRoll={() => controller.roll()}
            onMove={(token) => controller.move(token)}
          />
          <div className="flex min-h-14 flex-col items-center gap-1">
            <p aria-live="polite" className="text-center font-bold">
              {status}
            </p>
            {ludoRollNote(board) && (
              <p className="text-center text-sm text-muted">{ludoRollNote(board)}</p>
            )}
            {view.you < 0 && <p className="text-center text-xs text-muted">You are watching.</p>}
          </div>
        </>
      )}

      <NetEmotes
        view={view}
        now={now}
        nameOf={nameOf}
        onEmote={(emoji) => controller.emote(emoji)}
      />
      <MessageToasts
        conversationId={record?.conversationId}
        onOpen={() => void navigate(chatLink)}
      />

      <Dialog
        open={over && !resultSeen && board !== null}
        onOpenChange={(open) => !open && setResultSeen(true)}
        title={status}
      >
        {board && (
          <>
            {game.phase === 'over' &&
              (view.you >= 0 && board.state.players[view.you]?.rank === 1 ? (
                <Trophy aria-hidden size={44} className="mx-auto text-accent" />
              ) : (
                <Medal aria-hidden size={44} className="mx-auto text-accent" />
              ))}
            <ol className="space-y-1">
              {standings(board.state).map((entry) => {
                const seat = game.seats[entry.seat]!;
                return (
                  <li key={entry.color}>
                    {entry.rank ? ordinal(entry.rank) : entry.left ? 'Left' : '–'} ·{' '}
                    {nameOf(seat.userId)} ({LUDO_COLOR_NAMES[seat.color]})
                  </li>
                );
              })}
            </ol>
          </>
        )}
        {game.phase === 'over' && view.you >= 0 && (
          <RematchButton
            conversationId={record?.conversationId}
            type="ludo"
            settings={game.settings}
            maxPlayers={game.maxPlayers}
          />
        )}
        <Button
          variant={game.phase === 'over' && view.you >= 0 ? 'secondary' : 'primary'}
          onClick={() => void navigate(chatLink)}
        >
          <MessageCircle aria-hidden size={18} />
          Back to the chat
        </Button>
        <Button variant="ghost" onClick={() => setResultSeen(true)}>
          See the board
        </Button>
      </Dialog>
      <Dialog open={rules} onOpenChange={setRules} title="Ludo rules">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {ludoRules(game.settings).map((line) => (
            <li key={line}>{line}</li>
          ))}
          <li>Each step of a turn has 30 seconds. Three skipped turns in a row and you are out.</li>
        </ul>
        <Button variant="secondary" onClick={() => setRules(false)}>
          Close
        </Button>
      </Dialog>
    </div>
  );
}

function Table({
  view,
  nameOf,
  dark,
  animate,
  pace,
  lastDice,
  now,
  onRoll,
  onMove,
}: {
  view: LudoNetView;
  nameOf: (userId: string) => string;
  dark: boolean;
  animate: boolean;
  pace: typeof NORMAL_PACE;
  lastDice: Record<number, number>;
  now: number;
  onRoll: () => void;
  onMove: (token: number) => void;
}) {
  const board = view.board!;
  const { game } = view;
  // Your corner is bottom left; a watcher sees the first seat there.
  const rotation = rotationFor(game.seats[Math.max(0, view.you)]!.color);
  const timeLeft =
    view.deadline !== null ? Math.min(1, Math.max(0, (view.deadline - now) / LUDO_TURN_MS)) : null;
  const corner = (top: boolean, left: boolean) => {
    const seat = board.state.players.findIndex((player) => {
      const at = cornerOf(player.color, rotation);
      return at.top === top && at.left === left;
    });
    if (seat < 0) return <div className="min-w-0 flex-1" />;
    const info = game.seats[seat]!;
    return (
      <PlayerPanel
        view={board}
        seat={seat}
        level="medium"
        left={left}
        dark={dark}
        animate={animate}
        rollMs={pace.roll}
        lastDie={lastDice[seat] ?? null}
        onRoll={onRoll}
        name={nameOf(info.userId)}
        // The clock shows only to the player whose turn it is, on their own panel.
        timeLeft={
          seat === view.you && seat === board.state.current && board.waiting !== 'over'
            ? timeLeft
            : null
        }
      />
    );
  };
  return (
    <div className="flex w-[min(100%,calc(100dvh-300px))] min-w-[340px] flex-col gap-2">
      <div className="flex gap-2">
        {corner(true, true)}
        {corner(true, false)}
      </div>
      <LudoBoard
        view={board}
        rotation={rotation}
        dark={dark}
        animate={animate}
        hopMs={pace.hop}
        captureMs={pace.capture}
        onMove={onMove}
      />
      <div className="flex gap-2">
        {corner(false, true)}
        {corner(false, false)}
      </div>
    </div>
  );
}
