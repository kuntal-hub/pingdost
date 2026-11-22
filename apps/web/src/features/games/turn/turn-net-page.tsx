// A turn game with friends in the browser (Phase 43, ADR 0049): the lobby, then the board with
// each person's name and, in games with a timer, a bar for the player on the clock. Moves are E2EE
// game events in the chat; this tab folds them. Shared pieces come from `net-parts.tsx`.
import {
  DoorOpen,
  EllipsisVertical,
  Flag,
  Info,
  MessageCircle,
  OctagonX,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import { useNames } from '@/chat/hooks';
import { Button, IconButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/controls';
import { Dialog, Menu } from '@/components/ui/menu';
import { useAppearance } from '@/theme';
import {
  catalogEntry,
  FAST_TURN_PACE,
  NORMAL_TURN_PACE,
  chessInCheck,
  turnNetStatus,
  type ChessState,
  type AnyTurnRules,
} from '@pingdost/games';

import { GAME_ICONS } from '../game-icons';
import {
  ChatButton,
  DesyncNotice,
  MessageToasts,
  NetEmotes,
  NetLobby,
  RematchButton,
  useMarkActiveGame,
} from '../net-parts';
import { useNow, useTurnNetGame } from '../network';
import { useGames } from '../store';
import { TurnBoard } from './boards';
import { ResultDialog, RulesDialog } from './turn-page';
import {
  ChessMoves,
  PlayersStrip,
  TurnDie,
  useMotionLevel,
  useTurnKeys,
  useTurnSounds,
} from './turn-parts';

export function TurnNetPage({ gameId, rules }: { gameId: string; rules: AnyTurnRules }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const names = useNames();
  const dark = useAppearance((state) => state.dark);
  const motion = useMotionLevel();
  const sounds = useGames((state) => state.sounds);
  const pace = motion === 'full' ? NORMAL_TURN_PACE : FAST_TURN_PACE;
  const { controller, view, record } = useTurnNetGame(gameId, rules, pace);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [resultSeen, setResultSeen] = useState(false);
  // Chess: offer a draw along with the next move.
  const [offerDraw, setOfferDraw] = useState(false);
  const entry = catalogEntry(rules.id);
  const state = view?.state ?? null;
  const chessState = rules.id === 'chess' && state ? (state as ChessState) : null;
  const turn = view?.game.turn;
  useEffect(() => setOfferDraw(false), [turn]);
  useTurnSounds(
    rules,
    view && state ? { state, you: view.you, waiting: view.waiting, last: view.last } : null,
    pace,
    motion === 'full',
  );
  useTurnKeys(rules, controller);
  const playing = view?.game.phase === 'playing';
  const now = useNow((playing && rules.turnMs !== null) || (view?.game.emotes.length ?? 0) > 0);
  const nameOf = (userId: string) => (userId === names.selfUserId ? 'You' : names.name(userId));
  useMarkActiveGame(record ? { gameId, conversationId: record.conversationId } : null);

  // "Join" on the chat card opens the game and joins it.
  const joinAsked = params.get('join') === '1';
  useEffect(() => {
    if (!joinAsked || !controller || !view) return;
    if (view.canJoin) controller.join();
    setParams({}, { replace: true });
  }, [joinAsked, controller, view, setParams]);

  const openChat = () => {
    if (record) void navigate(`/chat/${record.conversationId}`);
  };

  if (!view || !controller) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <EmptyState icon={GAME_ICONS[entry.icon]} title="Opening the game…">
          <p className="text-muted">Games with friends live in their chat.</p>
        </EmptyState>
      </div>
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
  const timerLine =
    rules.turnMs !== null
      ? [
          'Each turn has 30 seconds. If you are away, your app plays for you while the game is open; otherwise the others play for you, and three missed turns in a row take you out.',
        ]
      : [];

  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center gap-3 p-4 md:p-5">
      <div className="flex w-full items-center gap-2">
        <h1 className="flex-1 font-display text-2xl font-extrabold">{entry.name}</h1>
        <ChatButton conversationId={record?.conversationId} onOpen={openChat} />
        <Menu
          label="Game menu"
          trigger={
            <IconButton aria-label="Game menu">
              <EllipsisVertical aria-hidden size={20} />
            </IconButton>
          }
          items={[
            { label: 'Rules', icon: Info, onSelect: () => setRulesOpen(true) },
            {
              label: sounds ? 'Turn game sounds off' : 'Turn game sounds on',
              icon: sounds ? VolumeX : Volume2,
              onSelect: () => useGames.getState().setSounds(!sounds),
            },
            ...(live && inGame && !left
              ? [
                  {
                    label: rules.id === 'chess' && playing ? 'Resign' : 'Leave the game',
                    icon: rules.id === 'chess' && playing ? Flag : DoorOpen,
                    destructive: true,
                    onSelect: () => controller.leave(),
                  },
                ]
              : []),
            ...(live && view.isHost
              ? [
                  {
                    label: 'End for everyone',
                    icon: OctagonX,
                    destructive: true,
                    onSelect: () => controller.end(),
                  },
                ]
              : []),
          ]}
        />
      </div>
      <DesyncNotice view={view} />
      {game.phase === 'lobby' || game.phase === 'missing' || game.phase === 'invalid' || !state ? (
        <NetLobby
          view={view}
          type={rules.id}
          selfUserId={names.selfUserId}
          nameOf={nameOf}
          status={status}
          onJoin={() => controller.join()}
          onStart={() => controller.start()}
        />
      ) : (
        <>
          <PlayersStrip
            rules={rules}
            state={state}
            names={seatName}
            over={over || !!state.ranks}
            timeLeft={timeLeft}
          />
          <div className="w-[min(100%,calc(100dvh-340px))] min-w-[300px]">
            <TurnBoard
              rules={rules}
              state={state}
              you={view.you}
              legal={view.legal}
              last={view.last}
              onMove={(move) =>
                controller.move(
                  offerDraw && rules.id === 'chess'
                    ? { ...(move as object), offerDraw: true }
                    : move,
                )
              }
              dark={dark}
              animate={motion === 'full'}
              pace={pace}
              names={seatName}
            />
          </div>
          <TurnDie
            rules={rules}
            state={state}
            waiting={view.waiting}
            last={view.last}
            you={view.you}
            animate={motion === 'full'}
            pace={pace}
            onRoll={() => controller.roll()}
          />
          <div className="flex min-h-10 flex-col items-center gap-1">
            <p aria-live="polite" className="text-center font-bold">
              {status}
              {chessState && chessInCheck(chessState) ? ' · Check' : ''}
            </p>
            {chessState && <ChessMoves state={chessState} />}
            {chessState && (
              <DrawOffer
                state={chessState}
                you={view.you}
                yourTurn={view.waiting === 'you'}
                offerName={chessState.drawOffer !== null ? seatName(chessState.drawOffer) : ''}
                armed={offerDraw}
                onArm={setOfferDraw}
                onAccept={() => controller.move({ acceptDraw: true })}
              />
            )}
            {view.you < 0 && <p className="text-center text-xs text-muted">You are watching.</p>}
            {view.locked && (
              <p className="text-center text-xs text-muted">
                You joined on another device: play there.
              </p>
            )}
          </div>
        </>
      )}
      <NetEmotes
        view={view}
        now={now}
        nameOf={nameOf}
        onEmote={(emoji) => controller.emote(emoji)}
      />
      <MessageToasts conversationId={record?.conversationId} onOpen={openChat} />

      {state && game.phase === 'over' && (
        <ResultDialog
          open={!resultSeen}
          onClose={() => setResultSeen(true)}
          rules={rules}
          state={state}
          you={view.you}
          names={seatName}
        >
          {view.you >= 0 && (
            <RematchButton
              conversationId={record?.conversationId}
              type={rules.id}
              settings={game.settings}
              maxPlayers={game.maxPlayers}
            />
          )}
          <Button variant={view.you >= 0 ? 'secondary' : 'primary'} onClick={openChat}>
            <MessageCircle aria-hidden size={18} />
            Back to the chat
          </Button>
          <Button variant="ghost" onClick={() => setResultSeen(true)}>
            See the board
          </Button>
        </ResultDialog>
      )}
      <Dialog
        open={game.phase === 'ended' && !resultSeen}
        onOpenChange={(open) => !open && setResultSeen(true)}
        title={status}
      >
        <Button onClick={openChat}>
          <MessageCircle aria-hidden size={18} />
          Back to the chat
        </Button>
      </Dialog>
      <RulesDialog
        rules={rules}
        settings={game.settings}
        open={rulesOpen}
        onOpenChange={setRulesOpen}
        extra={timerLine}
      />
    </div>
  );
}

/** Chess: take a draw the other player offered, or offer one with your next move. */
function DrawOffer({
  state,
  you,
  yourTurn,
  offerName,
  armed,
  onArm,
  onAccept,
}: {
  state: ChessState;
  you: number;
  yourTurn: boolean;
  offerName: string;
  armed: boolean;
  onArm: (armed: boolean) => void;
  onAccept: () => void;
}) {
  if (you < 0 || state.ranks) return null;
  const offered = state.drawOffer !== null && state.drawOffer !== you;
  if (offered && yourTurn) {
    return (
      <p className="flex items-center gap-3 rounded-2xl bg-surface px-4 py-2 text-sm">
        {offerName} offers a draw
        <Button variant="secondary" onClick={onAccept}>
          Accept
        </Button>
      </p>
    );
  }
  if (state.drawOffer === you) return <p className="text-xs text-muted">You offered a draw.</p>;
  if (!yourTurn) return null;
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input type="checkbox" checked={armed} onChange={(event) => onArm(event.target.checked)} />
      Offer a draw with my next move
    </label>
  );
}
