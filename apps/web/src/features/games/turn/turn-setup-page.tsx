// Setting up a turn game against the computer in the browser (Phase 43): computer players where
// the game allows more than one, the difficulty (not for Snakes and Ladders), and the options.
import { Play } from 'lucide-react';
import { useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';

import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/controls';
import { Toggle } from '@/components/ui/input';
import {
  BOT_LEVEL_NAMES,
  BOT_LEVELS,
  catalogEntry,
  isTurnGameId,
  turnRules,
  type BotLevel,
  type TurnGameId,
  type TurnSoloOptions,
} from '@pingdost/games';

import { turnSetupOf, useGames } from '../store';
import { TurnSettingsEditor } from './turn-settings';

const LEVEL_DETAIL: Partial<Record<TurnGameId, Record<BotLevel, string>>> = {
  'tic-tac-toe': {
    easy: 'Plays almost anywhere.',
    medium: 'Takes its wins and blocks yours.',
    hard: 'Never loses. A draw is a good result.',
  },
  'connect-four': {
    easy: 'Looks one move ahead, and slips now and then.',
    medium: 'Looks four moves ahead.',
    hard: 'Looks six moves ahead.',
  },
  'dots-and-boxes': {
    easy: 'Often hands boxes over.',
    medium: 'Takes every box and never gives one away early.',
    hard: 'Fights for the last safe line and keeps control of long chains.',
  },
  'last-card': {
    easy: 'Plays any card that fits, and sometimes forgets to call.',
    medium: 'Saves wilds, and hits the next player when they are close to out.',
    hard: 'Also keeps to its strongest color and plays draw four early on a threat.',
  },
  chess: {
    easy: 'Looks one move ahead and often picks a weaker move.',
    medium: 'Looks about three moves ahead.',
    hard: 'Thinks up to a second and a half per move, as deep as it can.',
  },
};

export function TurnSetupPage() {
  const { game = '' } = useParams();
  if (!isTurnGameId(game)) return <Navigate to="/games" replace />;
  return <Setup key={game} game={game} />;
}

function Setup({ game }: { game: TurnGameId }) {
  const navigate = useNavigate();
  const rules = turnRules(game);
  const saved = useGames((state) => state.turnSolo[game]);
  const sounds = useGames((state) => state.sounds);
  const [options, setOptions] = useState<TurnSoloOptions>(() =>
    turnSetupOf(useGames.getState(), game),
  );
  const most = rules.maxPlayers - 1;
  const detail = LEVEL_DETAIL[game]?.[options.level];
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-5 p-4 md:p-6">
      <h1 className="font-display text-2xl font-extrabold">Play {catalogEntry(game).name}</h1>
      {most > 1 && (
        <section className="flex flex-col gap-2">
          <h2 className="font-bold text-muted">Computer players</h2>
          <Segmented
            label="Computer players"
            options={Array.from({ length: most }, (_, i) => ({
              id: String(i + 1),
              label: String(i + 1),
            }))}
            value={String(options.computers)}
            onChange={(id) => setOptions({ ...options, computers: Number(id) })}
          />
        </section>
      )}
      {rules.levels ? (
        <section className="flex flex-col gap-2">
          <h2 className="font-bold text-muted">Difficulty</h2>
          <Segmented
            label="Difficulty"
            options={BOT_LEVELS.map((level) => ({ id: level, label: BOT_LEVEL_NAMES[level] }))}
            value={options.level}
            onChange={(level) => setOptions({ ...options, level })}
          />
          {detail && <p className="text-sm text-muted">{detail}</p>}
        </section>
      ) : (
        <p className="text-sm text-muted">
          The dice decide every move, so the computer players have no difficulty levels.
        </p>
      )}
      <TurnSettingsEditor
        rules={rules}
        settings={options.settings}
        onChange={(settings) => setOptions({ ...options, settings })}
      />
      <section className="pd-card flex flex-col rounded-xl px-4">
        <h2 className="sr-only">While playing</h2>
        <Toggle
          label="Game sounds"
          description="Moves, dice and wins."
          checked={sounds}
          onChange={(value) => useGames.getState().setSounds(value)}
        />
      </section>
      <Button
        onClick={() => {
          useGames.getState().startTurnSolo(game, options);
          void navigate(`/games/${game}`, { replace: true });
        }}
      >
        <Play aria-hidden size={18} />
        Start game
      </Button>
      {saved && !saved.state.ranks && (
        <p className="text-center text-sm text-muted">This replaces your unfinished game.</p>
      )}
      <p className="text-xs text-muted">
        Computer players are only for games on your own; games with friends are people only. Games
        against the computer run in this browser and send nothing.
      </p>
    </div>
  );
}
