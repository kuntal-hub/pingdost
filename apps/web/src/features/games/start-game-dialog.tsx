// "Start a game" from a chat (Phases 42–43, ADR 0049): pick the game and its rules, then the
// invitation goes into the chat as a card. One to one is two players; a group picks the number
// of seats, taken by whoever joins first. People only: no computer players in games with friends.
import { Send } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { useChatClient } from '@/chat/store';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/controls';
import { Toggle } from '@/components/ui/input';
import { Dialog } from '@/components/ui/menu';
import { cn } from '@/lib/cn';
import {
  GAME_CATALOG,
  isTurnGameId,
  turnRules,
  type LudoSettings,
  type TurnGameId,
} from '@pingdost/games';

import { GAME_ICONS } from './game-icons';
import { startGame } from './network';
import { turnSetupOf, useGames } from './store';
import { TurnSettingsEditor } from './turn/turn-settings';

type Playable = 'ludo' | TurnGameId;

const PLAYABLE = GAME_CATALOG.filter((entry) => entry.available);

function settingsFor(game: Playable): unknown {
  const state = useGames.getState();
  return game === 'ludo' ? state.ludoSetup.settings : turnSetupOf(state, game).settings;
}

export function StartGameDialog({
  open,
  onOpenChange,
  conversationId,
  isGroup,
  initialGame,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  isGroup: boolean;
  initialGame?: Playable | undefined;
}) {
  const client = useChatClient();
  const navigate = useNavigate();
  const [game, setGame] = useState<Playable>(initialGame ?? 'ludo');
  const [settings, setSettings] = useState<unknown>(() => settingsFor(initialGame ?? 'ludo'));
  const [players, setPlayers] = useState(4);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // A game for four needs a group.
  const choices = PLAYABLE.filter((e) => isGroup || e.minPlayers <= 2);
  const entry = choices.find((e) => e.id === game) ?? choices[0]!;
  const rules = isTurnGameId(game) ? turnRules(game) : null;
  const seats = Math.min(entry.maxPlayers, Math.max(entry.minPlayers, players));
  const ludo = settings as LudoSettings;
  const setRule = (change: Partial<LudoSettings>) => setSettings({ ...ludo, ...change });
  const timed = game === 'ludo' || rules?.turnMs !== null;

  async function invite() {
    if (!client) return;
    setBusy(true);
    setError(undefined);
    try {
      const gameId = await startGame(
        client,
        conversationId,
        entry.id as Playable,
        entry.id === game ? settings : settingsFor(entry.id as Playable),
        isGroup ? seats : 2,
      );
      onOpenChange(false);
      void navigate(`/games/play/${gameId}`);
    } catch {
      setError('The invitation could not be sent. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Play a game"
      description={
        isGroup
          ? 'Everyone in the group gets the invitation; the first to join take the seats.'
          : 'Your friend gets the invitation in this chat.'
      }
    >
      <section className="flex flex-col gap-2">
        <h3 className="font-bold text-muted">Game</h3>
        <div role="radiogroup" aria-label="Game" className="grid grid-cols-3 gap-2">
          {choices.map((option) => {
            const Glyph = GAME_ICONS[option.icon];
            const selected = option.id === game;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => {
                  setGame(option.id as Playable);
                  setSettings(settingsFor(option.id as Playable));
                }}
                className={cn(
                  'pd-press flex cursor-pointer flex-col items-center gap-1 rounded-xl px-2 py-3 text-xs font-semibold',
                  selected ? 'bg-primary text-on-primary' : 'bg-raised hover:bg-surface',
                )}
              >
                <Glyph aria-hidden size={22} className={selected ? undefined : 'text-accent'} />
                <span className="truncate">{option.name}</span>
              </button>
            );
          })}
        </div>
        <p className="text-sm text-muted">{entry.tagline}</p>
      </section>
      {isGroup && entry.maxPlayers > 2 && (
        <section className="flex flex-col gap-2">
          <h3 className="font-bold text-muted">Players</h3>
          <Segmented
            label="Players"
            options={Array.from({ length: entry.maxPlayers - 1 }, (_, i) => ({
              id: String(i + 2),
              label: String(i + 2),
            }))}
            value={String(seats)}
            onChange={(id) => setPlayers(Number(id))}
          />
        </section>
      )}
      {game === 'ludo' ? (
        <section className="pd-card flex flex-col divide-y divide-border rounded-xl px-4">
          <h3 className="sr-only">Rules</h3>
          <Toggle
            label="Roll a 6 to start"
            description="Off: any roll brings a piece out."
            checked={ludo.needSix}
            onChange={(needSix) => setRule({ needSix })}
          />
          <Toggle
            label="Walls"
            description="Two of your pieces on one square block everyone else."
            checked={ludo.blockades}
            onChange={(blockades) => setRule({ blockades })}
          />
          <Toggle
            label="End at the first winner"
            description="Off: the others play on for places."
            checked={ludo.stopAtFirstWinner}
            onChange={(stopAtFirstWinner) => setRule({ stopAtFirstWinner })}
          />
        </section>
      ) : (
        rules && <TurnSettingsEditor rules={rules} settings={settings} onChange={setSettings} />
      )}
      <p className="text-xs text-muted">
        {timed
          ? 'Each turn has 30 seconds. If you are away, your app plays for you while it is open; otherwise the others play or skip your turn, and three missed turns in a row take you out.'
          : 'No timer: play at your own pace.'}
      </p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Button disabled={!client || busy} onClick={() => void invite()}>
        <Send aria-hidden size={18} />
        Send invitation
      </Button>
    </Dialog>
  );
}
