// A turn game's own options in the browser (solo setup and invitations).
import { Segmented } from '@/components/ui/controls';
import { Toggle } from '@/components/ui/input';
import {
  DOTS_SIZES,
  type AnyTurnRules,
  type DotsSettings,
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
