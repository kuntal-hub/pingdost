// Camera effects in a video call (ADR 0038, 0048): the groups (Beauty, Fun, Filters; Lenses only
// where faces are tracked) as a switch over a grid of round buttons, "None" first. Picking one
// applies it at once.
import {
  Aperture,
  Ban,
  Bubbles,
  Camera,
  Candy,
  Cat,
  CircleDot,
  Clapperboard,
  Cloud,
  Contrast,
  Crown,
  Dog,
  Drama,
  Droplet,
  Eye,
  Film,
  Flame,
  FlipHorizontal2,
  Flower2,
  Gem,
  Ghost,
  Glasses,
  Grid2x2,
  Grid3x3,
  Haze,
  Heart,
  Hexagon,
  Laugh,
  Layers,
  Maximize,
  Minimize,
  Moon,
  MoveHorizontal,
  MoveVertical,
  Palette,
  PawPrint,
  PenTool,
  Rabbit,
  Rainbow,
  ScanFace,
  Smile,
  Snowflake,
  Sparkle,
  Sparkles,
  Star,
  Sun,
  SunMedium,
  Sunset,
  Thermometer,
  Tornado,
  Tv,
  Waves,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { EFFECT_GROUPS, type EffectIcon, type VideoEffectKind } from '@pingdost/call-engine';

import { effectChoices, setVideoEffect, useCalls } from './runtime';

const ICONS: Record<EffectIcon, LucideIcon> = {
  aperture: Aperture,
  bubbles: Bubbles,
  camera: Camera,
  candy: Candy,
  cat: Cat,
  'circle-dot': CircleDot,
  clapperboard: Clapperboard,
  cloud: Cloud,
  contrast: Contrast,
  crown: Crown,
  dog: Dog,
  drama: Drama,
  droplet: Droplet,
  eye: Eye,
  film: Film,
  flame: Flame,
  'flip-horizontal-2': FlipHorizontal2,
  'flower-2': Flower2,
  gem: Gem,
  ghost: Ghost,
  glasses: Glasses,
  'grid-2x2': Grid2x2,
  'grid-3x3': Grid3x3,
  haze: Haze,
  heart: Heart,
  hexagon: Hexagon,
  laugh: Laugh,
  layers: Layers,
  maximize: Maximize,
  minimize: Minimize,
  moon: Moon,
  'move-horizontal': MoveHorizontal,
  'move-vertical': MoveVertical,
  palette: Palette,
  'paw-print': PawPrint,
  'pen-tool': PenTool,
  rabbit: Rabbit,
  rainbow: Rainbow,
  'scan-face': ScanFace,
  smile: Smile,
  snowflake: Snowflake,
  sparkle: Sparkle,
  sparkles: Sparkles,
  star: Star,
  sun: Sun,
  'sun-medium': SunMedium,
  sunset: Sunset,
  thermometer: Thermometer,
  tornado: Tornado,
  tv: Tv,
  waves: Waves,
  zap: Zap,
};

export function EffectsPanel({ onClose }: { onClose: () => void }) {
  const effect = useCalls((state) => state.effect);
  const effects = effectChoices();
  const groups = EFFECT_GROUPS.filter((group) => effects.some((e) => e.kind === group.kind));
  const [kind, setKind] = useState<VideoEffectKind>(
    () => effects.find((e) => e.id === effect)?.kind ?? groups[0]?.kind ?? 'beauty',
  );
  const options = [
    { id: 'none', label: 'None', Icon: Ban },
    ...effects
      .filter((e) => e.kind === kind)
      .map((e) => ({ id: e.id, label: e.label, Icon: ICONS[e.icon] })),
  ];
  return (
    <div
      role="dialog"
      aria-labelledby="effects-title"
      className="absolute bottom-24 left-1/2 flex w-[min(92vw,34rem)] -translate-x-1/2 flex-col gap-3 rounded-lg border border-border bg-surface p-4 text-foreground shadow-xl"
    >
      <div className="flex items-center justify-between gap-2">
        <p id="effects-title" className="font-semibold">
          Camera effects
        </p>
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      </div>
      <div
        role="group"
        aria-label="Effect groups"
        className="flex gap-1 rounded-full bg-raised p-1"
      >
        {groups.map((group) => (
          <button
            key={group.kind}
            type="button"
            aria-pressed={group.kind === kind}
            onClick={() => setKind(group.kind)}
            className={cn(
              'min-h-9 flex-1 cursor-pointer rounded-full px-3 text-sm font-semibold',
              group.kind === kind
                ? 'bg-brand text-on-primary'
                : 'text-foreground hover:bg-accent/15',
            )}
          >
            {group.label}
          </button>
        ))}
      </div>
      <div
        role="radiogroup"
        aria-labelledby="effects-title"
        // A fixed height: switching groups must not move the switch above.
        className="grid h-60 auto-rows-min grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-1 overflow-y-auto"
      >
        {options.map(({ id, label, Icon }) => {
          const selected = effect === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => void setVideoEffect(id)}
              className="pd-press flex min-w-0 cursor-pointer flex-col items-center gap-1 rounded-lg p-1 text-xs font-semibold hover:bg-accent/10"
            >
              <span
                className={cn(
                  'flex h-12 w-12 items-center justify-center rounded-full',
                  selected
                    ? 'bg-brand text-on-primary ring-2 ring-accent ring-offset-2 ring-offset-surface'
                    : 'bg-raised text-foreground',
                )}
              >
                <Icon aria-hidden className="h-6 w-6" />
              </span>
              <span className="w-full truncate text-center">{label}</span>
            </button>
          );
        })}
      </div>
      <p className="text-sm text-muted">
        Effects are drawn in this browser before the picture is encrypted. Lenses and face effects
        (ears, glasses, big eyes) need face tracking, which is in the phone app.
      </p>
    </div>
  );
}
