// "Start a game" from a chat (Phase 42, ADR 0049): pick the game and its rules, then the
// invitation goes into the chat as a card. One to one is two players; a group picks 2–4 seats,
// taken by whoever joins first. People only: no computer players in games with friends.
import { Send } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { useChatClient } from '@/chat/store';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/controls';
import { Toggle } from '@/components/ui/input';
import { Dialog } from '@/components/ui/menu';
import type { LudoSettings } from '@pingdost/games';

import { startLudoGame } from './network';
import { useGames } from './store';

export function StartGameDialog({
  open,
  onOpenChange,
  conversationId,
  isGroup,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  isGroup: boolean;
}) {
  const client = useChatClient();
  const navigate = useNavigate();
  const [settings, setSettings] = useState<LudoSettings>(
    () => useGames.getState().ludoSetup.settings,
  );
  const [players, setPlayers] = useState<'2' | '3' | '4'>('4');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const setRule = (change: Partial<LudoSettings>) =>
    setSettings((current) => ({ ...current, ...change }));

  async function invite() {
    if (!client) return;
    setBusy(true);
    setError(undefined);
    try {
      const gameId = await startLudoGame(
        client,
        conversationId,
        settings,
        isGroup ? Number(players) : 2,
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
      title="Play Ludo"
      description={
        isGroup
          ? 'Everyone in the group gets the invitation; the first to join take the seats.'
          : 'Your friend gets the invitation in this chat.'
      }
    >
      {isGroup && (
        <section className="flex flex-col gap-2">
          <h3 className="font-bold text-muted">Players</h3>
          <Segmented
            label="Players"
            options={[
              { id: '2', label: '2' },
              { id: '3', label: '3' },
              { id: '4', label: '4' },
            ]}
            value={players}
            onChange={setPlayers}
          />
        </section>
      )}
      <section className="pd-card flex flex-col divide-y divide-border rounded-xl px-4">
        <h3 className="sr-only">Rules</h3>
        <Toggle
          label="Roll a 6 to start"
          description="Off: any roll brings a piece out."
          checked={settings.needSix}
          onChange={(needSix) => setRule({ needSix })}
        />
        <Toggle
          label="Walls"
          description="Two of your pieces on one square block everyone else."
          checked={settings.blockades}
          onChange={(blockades) => setRule({ blockades })}
        />
        <Toggle
          label="End at the first winner"
          description="Off: the others play on for places."
          checked={settings.stopAtFirstWinner}
          onChange={(stopAtFirstWinner) => setRule({ stopAtFirstWinner })}
        />
      </section>
      <p className="text-xs text-muted">
        Each turn has 30 seconds. If you are away, your app plays for you while it is open;
        otherwise your turn is skipped, and three skips in a row take you out.
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
