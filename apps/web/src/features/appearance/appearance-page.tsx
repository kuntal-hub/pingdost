// How PingDost looks and feels in this browser (ADR 0035): the same choices as the phone's. Every
// change applies at once, and the preview beside the options shows it.
import { Check, CheckCheck, RotateCcw } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/controls';
import { Toggle } from '@/components/ui/input';
import { Dialog } from '@/components/ui/menu';
import { cn } from '@/lib/cn';
import { displayFont, useAppearance } from '@/theme';
import {
  avatarOptions,
  bubbleCorners,
  bubbleOptions,
  colorSchemes,
  cornerOptions,
  densityOptions,
  fontOptions,
  lookOptions,
  modeOptions,
  motionOptions,
  resolvePalette,
  schemeSwatch,
  surfaceStyle,
  textSizeOptions,
  wallpaperOptions,
  wallpaperSvg,
  type AppearancePrefs,
  type BubbleCorners,
} from '@pingdost/ui-tokens';

function cornerStyle(corners: BubbleCorners) {
  return {
    borderTopLeftRadius: corners.topLeft,
    borderTopRightRadius: corners.topRight,
    borderBottomLeftRadius: corners.bottomLeft,
    borderBottomRightRadius: corners.bottomRight,
  };
}

/** A mock conversation that shows every choice as it is made. */
function Preview() {
  const shape = useAppearance((state) => state.prefs.bubble);
  return (
    <div
      role="img"
      aria-label="Preview of a chat with your choices"
      className="pd-wallpaper pd-floating flex h-96 flex-col overflow-hidden rounded-2xl"
    >
      <div className="flex items-center gap-2 bg-surface/90 p-3">
        <Avatar name="Asha K" size={36} online />
        <div>
          <div className="font-bold">Asha</div>
          <div className="text-xs font-semibold text-success">online</div>
        </div>
      </div>
      <div className="flex flex-1 flex-col justify-end gap-1 p-4">
        <div
          className="w-fit max-w-[80%] bg-bubble-in px-3 py-2 text-on-bubble-in shadow-(--pd-card-shadow)"
          style={cornerStyle(bubbleCorners(shape, { outgoing: false, first: true, last: true }))}
        >
          this theme is so you
        </div>
        <div
          className="bg-brand mt-2 ml-auto w-fit max-w-[80%] px-3 py-2 text-on-primary"
          style={cornerStyle(bubbleCorners(shape, { outgoing: true, first: true, last: false }))}
        >
          ikr, changing it again tmrw
        </div>
        <div
          className="bg-brand ml-auto w-fit max-w-[80%] px-3 py-2 text-on-primary"
          style={cornerStyle(bubbleCorners(shape, { outgoing: true, first: false, last: true }))}
        >
          picking a wallpaper now
          <div className="flex items-center justify-end gap-1 text-xs text-on-primary/80">
            14:02 <CheckCheck aria-hidden size={14} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string | undefined;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="font-display text-xl font-extrabold">{title}</h2>
        {hint && <p className="text-sm text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Selected() {
  return (
    <span className="pd-pop absolute top-2 right-2 flex size-6 items-center justify-center rounded-full bg-foreground text-background">
      <Check aria-hidden size={14} strokeWidth={3.2} />
    </span>
  );
}

/** A radio button that looks like a tile; the input keeps it keyboard and screen-reader friendly. */
function Tile({
  group,
  label,
  selected,
  onSelect,
  className,
  children,
}: {
  group: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        'pd-press relative cursor-pointer overflow-hidden rounded-xl border-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent',
        selected ? 'border-accent' : 'border-border hover:border-muted',
        className,
      )}
    >
      <input
        type="radio"
        name={group}
        aria-label={label}
        className="sr-only"
        checked={selected}
        onChange={onSelect}
      />
      {children}
      {selected && <Selected />}
    </label>
  );
}

function SchemeTiles({ prefs, dark }: { prefs: AppearancePrefs; dark: boolean }) {
  const update = useAppearance((state) => state.update);
  return (
    <div
      role="radiogroup"
      aria-label="Color scheme"
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
    >
      {colorSchemes.map((scheme) => {
        const palette = resolvePalette(scheme.id, dark, prefs.pureBlack);
        const swatch = schemeSwatch(scheme.id, dark);
        return (
          <Tile
            key={scheme.id}
            group="scheme"
            label={`${scheme.name}. ${scheme.vibe}`}
            selected={prefs.scheme === scheme.id}
            onSelect={() => update({ scheme: scheme.id })}
          >
            <div className="p-2" style={{ backgroundColor: palette.background }}>
              <div
                className="relative h-16 rounded-lg"
                style={{
                  backgroundImage: `linear-gradient(135deg, ${swatch.from}, ${swatch.to})`,
                }}
              >
                <span
                  className="absolute bottom-2 left-2 h-3 w-8 rounded-full opacity-80"
                  style={{ backgroundColor: palette['on-primary'] }}
                />
                <span
                  className="absolute top-2 left-2 size-5 rounded-full"
                  style={{ backgroundColor: palette.secondary }}
                />
              </div>
              <div className="truncate px-1 pt-2 font-bold" style={{ color: palette.foreground }}>
                {scheme.name}
              </div>
              <div className="truncate px-1 text-xs" style={{ color: palette.muted }}>
                {scheme.vibe}
              </div>
            </div>
          </Tile>
        );
      })}
    </div>
  );
}

export function AppearancePage() {
  const prefs = useAppearance((state) => state.prefs);
  const dark = useAppearance((state) => state.dark);
  const palette = useAppearance((state) => state.palette);
  const update = useAppearance((state) => state.update);
  const reset = useAppearance((state) => state.reset);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="mx-auto grid max-w-6xl gap-8 p-6 lg:grid-cols-[1fr_22rem]">
      <div className="flex min-w-0 flex-col gap-8">
        <header>
          <h1 className="font-display text-4xl font-extrabold">Appearance</h1>
          <p className="text-muted">Make it yours. Saved in this browser only.</p>
        </header>

        <Section title="Mode">
          <Segmented
            label="Light or dark mode"
            options={modeOptions}
            value={prefs.mode}
            onChange={(mode) => update({ mode })}
          />
          {dark && (
            <div className="pd-card rounded-xl px-4">
              <Toggle
                label="Pure black"
                description="True black backgrounds. Crisp on OLED screens."
                checked={prefs.pureBlack}
                onChange={(pureBlack) => update({ pureBlack })}
              />
            </div>
          )}
        </Section>

        <Section title="Colors" hint="Every scheme works in light and dark.">
          <SchemeTiles prefs={prefs} dark={dark} />
        </Section>

        <Section title="Look" hint="How cards, buttons and bars sit on the page.">
          <div role="radiogroup" aria-label="Look" className="grid grid-cols-3 gap-3">
            {lookOptions.map((option) => {
              const surface = surfaceStyle(palette, option.id, dark);
              return (
                <Tile
                  key={option.id}
                  group="look"
                  label={`${option.label}. ${option.description}`}
                  selected={prefs.look === option.id}
                  onSelect={() => update({ look: option.id })}
                  className="p-3"
                >
                  <div
                    className="mb-2 h-14 rounded-lg bg-surface"
                    style={{
                      borderStyle: 'solid',
                      borderWidth: surface.borderWidth,
                      borderColor: surface.borderColor,
                      boxShadow: surface.boxShadow,
                    }}
                  />
                  <div className="font-bold">{option.label}</div>
                  <div className="text-xs text-muted">{option.description}</div>
                </Tile>
              );
            })}
          </div>
        </Section>

        <Section title="Chat bubbles">
          <div
            role="radiogroup"
            aria-label="Chat bubbles"
            className="grid grid-cols-2 gap-3 sm:grid-cols-4"
          >
            {bubbleOptions.map((option) => (
              <Tile
                key={option.id}
                group="bubble"
                label={option.label}
                selected={prefs.bubble === option.id}
                onSelect={() => update({ bubble: option.id })}
                className="flex flex-col items-center gap-2 py-4"
              >
                <div
                  className="bg-brand h-9 w-18"
                  style={cornerStyle(
                    bubbleCorners(option.id, { outgoing: true, first: true, last: true }),
                  )}
                />
                <div className="font-bold">{option.label}</div>
              </Tile>
            ))}
          </div>
        </Section>

        <Section title="Wallpaper">
          <div
            role="radiogroup"
            aria-label="Chat wallpaper"
            className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-7"
          >
            {wallpaperOptions.map((option) => {
              const svg = wallpaperSvg(option.id, palette, dark);
              return (
                <Tile
                  key={option.id}
                  group="wallpaper"
                  label={`${option.label} wallpaper`}
                  selected={prefs.wallpaper === option.id}
                  onSelect={() => update({ wallpaper: option.id })}
                  className="flex h-32 flex-col justify-end bg-background"
                >
                  {svg && (
                    <img
                      alt=""
                      src={`data:image/svg+xml,${encodeURIComponent(svg)}`}
                      className="absolute inset-0 size-full"
                    />
                  )}
                  <div className="relative bg-surface/90 py-1 text-center text-xs font-bold">
                    {option.label}
                  </div>
                </Tile>
              );
            })}
          </div>
        </Section>

        <Section title="Font">
          <div
            role="radiogroup"
            aria-label="Font"
            className="grid grid-cols-2 gap-3 lg:grid-cols-4"
          >
            {fontOptions.map((option) => (
              <Tile
                key={option.id}
                group="font"
                label={`${option.label} font. ${option.description}`}
                selected={prefs.font === option.id}
                onSelect={() => update({ font: option.id })}
                className="p-4"
              >
                <div
                  className="text-3xl font-extrabold"
                  style={{ fontFamily: displayFont(option.id) }}
                >
                  Aa
                </div>
                <div className="font-bold">{option.label}</div>
                <div className="text-xs text-muted">{option.description}</div>
              </Tile>
            ))}
          </div>
        </Section>

        <div className="grid gap-8 sm:grid-cols-2">
          <Section title="Text size">
            <Segmented
              label="Text size"
              options={textSizeOptions}
              value={prefs.textSize}
              onChange={(textSize) => update({ textSize })}
            />
          </Section>
          <Section title="Corners">
            <Segmented
              label="Corner roundness"
              options={cornerOptions}
              value={prefs.corners}
              onChange={(corners) => update({ corners })}
            />
          </Section>
          <Section title="Profile pictures">
            <Segmented
              label="Profile picture shape"
              options={avatarOptions}
              value={prefs.avatar}
              onChange={(avatar) => update({ avatar })}
            />
          </Section>
          <Section title="Spacing">
            <Segmented
              label="Spacing"
              options={densityOptions}
              value={prefs.density}
              onChange={(density) => update({ density })}
            />
          </Section>
        </div>

        <Section
          title="Motion"
          hint={motionOptions.find((option) => option.id === prefs.motion)?.description}
        >
          <Segmented
            label="Amount of animation"
            options={motionOptions}
            value={prefs.motion}
            onChange={(motion) => update({ motion })}
          />
        </Section>

        <Button variant="secondary" className="self-start" onClick={() => setConfirming(true)}>
          <RotateCcw aria-hidden size={18} /> Back to defaults
        </Button>
      </div>

      <aside className="order-first lg:order-last">
        <div className="lg:sticky lg:top-6">
          <Preview />
        </div>
      </aside>

      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Reset appearance?"
        description="Colors, bubbles, wallpaper and the rest go back to how they started."
      >
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              reset();
              setConfirming(false);
            }}
          >
            Reset
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
