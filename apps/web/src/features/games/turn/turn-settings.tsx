// A turn game's own options in the browser (solo setup and invitations).
import { Segmented } from '@/components/ui/controls';
import { Toggle } from '@/components/ui/input';
import {
  BLINDS_EVERY,
  DOTS_SIZES,
  formatChips,
  POKER_CHIPS,
  type AnyTurnRules,
  type ChessSettings,
  type DotsSettings,
  type PokerSettings,
  type SnakesSettings,
} from '@pingdost/games';

export function TurnSettingsEditor({
  rules,
  settings,
  onChange,
}: {
  rules: AnyTurnRules;
  settings: unknown;
  onChange: (settings: unknown) => void;
}) {
  if (rules.id === 'dots-and-boxes') {
    const value = settings as DotsSettings;
    return (
      <section className="flex flex-col gap-2">
        <h3 className="font-bold text-muted">Board</h3>
        <Segmented
          label="Board size"
          options={DOTS_SIZES.map((size) => ({ id: String(size), label: `${size}×${size}` }))}
          value={String(value.size)}
          onChange={(size) => onChange({ ...value, size: Number(size) })}
        />
        <p className="text-sm text-muted">Boxes per side. Bigger boards take longer.</p>
      </section>
    );
  }
  if (rules.id === 'chess') {
    const value = settings as ChessSettings;
    return (
      <section className="flex flex-col gap-2">
        <h3 className="font-bold text-muted">Your side</h3>
        <Segmented
          label="Your side"
          options={[
            { id: 'white', label: 'White' },
            { id: 'random', label: 'Random' },
            { id: 'black', label: 'Black' },
          ]}
          value={value.hostSide}
          onChange={(hostSide) => onChange({ ...value, hostSide })}
        />
        <p className="text-sm text-muted">White moves first.</p>
      </section>
    );
  }
  if (rules.id === 'poker') {
    const value = settings as PokerSettings;
    return (
      <section className="flex flex-col gap-2">
        <h3 className="font-bold text-muted">Starting chips</h3>
        <Segmented
          label="Starting chips"
          options={POKER_CHIPS.map((chips) => ({ id: String(chips), label: formatChips(chips) }))}
          value={String(value.chips)}
          onChange={(chips) => onChange({ ...value, chips: Number(chips) })}
        />
        <div className="pd-card rounded-xl px-4">
          <Toggle
            label="Blinds go up"
            description={`Double every ${BLINDS_EVERY} hands, so the game ends in good time. Off: always 10 and 20.`}
            checked={value.risingBlinds}
            onChange={(risingBlinds) => onChange({ ...value, risingBlinds })}
          />
        </div>
        <p className="text-sm text-muted">
          Play chips only: no real money, nothing to buy and nothing to win.
        </p>
      </section>
    );
  }
  if (rules.id === 'snakes-and-ladders') {
    const value = settings as SnakesSettings;
    return (
      <section className="pd-card flex flex-col divide-y divide-border rounded-xl px-4">
        <h3 className="sr-only">Rules</h3>
        <Toggle
          label="A 6 rolls again"
          description="Up to two extra rolls in a row."
          checked={value.sixRollsAgain}
          onChange={(sixRollsAgain) => onChange({ ...value, sixRollsAgain })}
        />
        <Toggle
          label="Bounce back from 100"
          description="Off: a roll past 100 doesn't move."
          checked={value.bounceBack}
          onChange={(bounceBack) => onChange({ ...value, bounceBack })}
        />
      </section>
    );
  }
  return null;
}
