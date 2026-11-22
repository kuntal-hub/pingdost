// Setting up Ludo against the computer (Phase 41): computer players (1–3), difficulty, color
// and rules. Computer players exist only in games on your own (ADR 0049).
import { Play } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/controls';
import { Toggle } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { useAppearance } from '@/theme';
import {
  BOT_LEVEL_NAMES,
  BOT_LEVELS,
  LUDO_COLOR_NAMES,
  LUDO_COLORS,
  type BotLevel,
  type LudoSettings,
  type LudoSoloOptions,
} from '@pingdost/games';
import { gameBoardColors } from '@pingdost/ui-tokens';

import { ShapeIcon } from '../shape';
import { useGames } from '../store';

const LEVEL_DETAIL: Record<BotLevel, string> = {
  easy: 'Moves any piece. Good for learning.',
  medium: 'Goes for captures and safe squares.',
  hard: 'Weighs every risk and looks a roll ahead.',
};

export function LudoSetupPage() {
  const navigate = useNavigate();
  const dark = useAppearance((state) => state.dark);
  const saved = useGames((state) => state.solo);
  const autoMove = useGames((state) => state.autoMove);
  const sounds = useGames((state) => state.sounds);
  const [options, setOptions] = useState<LudoSoloOptions>(() => useGames.getState().ludoSetup);
  const setRule = (change: Partial<LudoSettings>) =>
    setOptions((current) => ({ ...current, settings: { ...current.settings, ...change } }));
  const colors = gameBoardColors(dark);
  const unfinished = saved !== null && saved.state.phase !== 'over';

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 p-4 md:p-6">
      <h1 className="font-display text-2xl font-extrabold">Play Ludo</h1>

      <section className="flex flex-col gap-2">
        <h2 className="font-bold text-muted">Computer players</h2>
        <Segmented
          label="Computer players"
          options={[
            { id: '1', label: '1' },
            { id: '2', label: '2' },
            { id: '3', label: '3' },
          ]}
          value={String(options.computers) as '1' | '2' | '3'}
          onChange={(id) => setOptions({ ...options, computers: Number(id) })}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-bold text-muted">Difficulty</h2>
        <Segmented
          label="Difficulty"
          options={BOT_LEVELS.map((level) => ({ id: level, label: BOT_LEVEL_NAMES[level] }))}
          value={options.level}
          onChange={(level) => setOptions({ ...options, level })}
        />
        <p className="text-sm text-muted">{LEVEL_DETAIL[options.level]}</p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 id="ludo-color" className="font-bold text-muted">
          Your color
        </h2>
        <div role="radiogroup" aria-labelledby="ludo-color" className="flex justify-around">
          {LUDO_COLORS.map((color) => {
            const look = colors.players[color];
            const selected = options.you === color;
            return (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setOptions({ ...options, you: color })}
                className="pd-press flex cursor-pointer flex-col items-center gap-1 rounded-xl p-1"
              >
                <span
                  className="flex size-13 items-center justify-center rounded-full border-[3px]"
                  style={{
                    backgroundColor: look.fill,
                    borderColor: look.ring,
                    boxShadow: selected ? `0 0 0 4px ${look.ring}` : undefined,
                  }}
                >
                  <ShapeIcon color={color} size={22} fill={look.on} />
                </span>
                <span className={cn('text-sm', selected ? 'font-bold' : 'text-muted')}>
                  {LUDO_COLOR_NAMES[color]}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="pd-card flex flex-col divide-y divide-border rounded-xl px-4">
        <h2 className="sr-only">Rules</h2>
        <Toggle
          label="Roll a 6 to start"
          description="Off: any roll brings a piece out."
          checked={options.settings.needSix}
          onChange={(needSix) => setRule({ needSix })}
        />
        <Toggle
          label="Walls"
          description="Two of your pieces on one square block everyone else."
          checked={options.settings.blockades}
          onChange={(blockades) => setRule({ blockades })}
        />
        <Toggle
          label="End at the first winner"
          description="Off: the others play on for places."
          checked={options.settings.stopAtFirstWinner}
          onChange={(stopAtFirstWinner) => setRule({ stopAtFirstWinner })}
        />
      </section>

      <section className="pd-card flex flex-col divide-y divide-border rounded-xl px-4">
        <h2 className="sr-only">While playing</h2>
        <Toggle
          label="Move by itself"
          description="When only one piece can move, move it for me."
          checked={autoMove}
          onChange={(value) => useGames.getState().setAutoMove(value)}
        />
        <Toggle
          label="Game sounds"
          description="Dice, moves, captures and wins."
          checked={sounds}
          onChange={(value) => useGames.getState().setSounds(value)}
        />
      </section>

      <div className="flex flex-col gap-2">
        <Button
          onClick={() => {
            useGames.getState().startSolo(options);
            void navigate('/games/ludo', { replace: true });
          }}
        >
          <Play aria-hidden size={18} />
          Start game
        </Button>
        {unfinished && (
          <p className="text-center text-sm text-muted">
            Starting counts your unfinished game as a loss.
          </p>
        )}
      </div>
      <p className="text-xs text-muted">
        Computer players are only for games on your own; games with friends are people only. Games
        against the computer run in this browser and send nothing.
      </p>
    </div>
  );
}
