// A game with friends at `/games/play/:gameId`: Ludo or a turn game, by the game's type.
import { Dices } from 'lucide-react';
import { useParams } from 'react-router';

import { EmptyState } from '@/components/ui/controls';

import { LudoNetPage } from './ludo/ludo-net-page';
import { turnRulesOf, useGameRecord } from './network';
import { TurnNetPage } from './turn/turn-net-page';

export function GamePage() {
  const { gameId = '' } = useParams();
  const record = useGameRecord(gameId);
  const type = record?.gameType;
  if (type === 'ludo') return <LudoNetPage />;
  const rules = turnRulesOf(type);
  if (rules) return <TurnNetPage key={gameId} gameId={gameId} rules={rules} />;
  const unknown = type !== undefined && type !== 'unknown';
  return (
    <div className="mx-auto max-w-2xl p-6">
      <EmptyState icon={Dices} title={unknown ? 'Update PingDost to play' : 'Opening the game…'}>
        <p className="text-muted">
          {unknown
            ? 'This game is newer than this version of the app.'
            : 'Games with friends live in their chat.'}
        </p>
      </EmptyState>
    </div>
  );
}
