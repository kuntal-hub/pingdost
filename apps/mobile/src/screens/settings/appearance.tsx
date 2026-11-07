// How PingDost looks and feels (ADR 0035): mode, color scheme, look, bubbles, wallpaper, font and
// more. Every change applies at once, and the preview at the top shows it. Kept on this phone.
import { useEffect, type ReactNode } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SvgXml } from 'react-native-svg';

import { Avatar } from '@/components/avatar';
import { Button } from '@/components/button';
import { Segmented, Toggle } from '@/components/controls';
import { CheckCheckIcon, CheckIcon, Icon, RotateCcwIcon } from '@/components/icon';
import { Tap } from '@/components/tap';
import { Text } from '@/components/text';
import { Wallpaper } from '@/components/wallpaper';
import { useAppearance } from '@/theme/appearance';
import { fontFamily, loadFont, useLoadedFonts } from '@/theme/fonts';
import { CSS_POP, useMotion } from '@/theme/motion';
import { useTheme } from '@/theme/theme-root';
import {
  avatarOptions,
  brandGradient,
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
  type BubbleShape,
  type FontId,
  type WallpaperId,
} from '@pingdost/ui-tokens';

const CHECK_POP = {
  from: { transform: [{ scale: 0.3 }], opacity: 0 },
  to: { transform: [{ scale: 1 }], opacity: 1 },
};

/** A mock conversation that shows every choice as it is made. */
function Preview() {
  const { palette, prefs, card, floating } = useTheme();
  const outgoing = (first: boolean, last: boolean) => {
    const corners = bubbleCorners(prefs.bubble, { outgoing: true, first, last });
    return {
      borderTopLeftRadius: corners.topLeft,
      borderTopRightRadius: corners.topRight,
      borderBottomLeftRadius: corners.bottomLeft,
      borderBottomRightRadius: corners.bottomRight,
      backgroundImage: brandGradient(palette),
      ...(prefs.look === 'sticker' ? card : {}),
    };
  };
  const incoming = bubbleCorners(prefs.bubble, { outgoing: false, first: true, last: true });
  return (
    <View
      accessible
      accessibilityLabel="Preview of a chat with your choices"
      className="overflow-hidden rounded-2xl bg-background"
      style={{ ...floating, height: 240 }}
    >
      <Wallpaper />
      <View className="flex-row items-center gap-2 bg-surface/90 px-3 py-2">
        <Avatar url={null} name="Asha K" size={34} online />
        <View>
          <Text className="font-bold text-foreground">Asha</Text>
          <Text className="text-xs font-semibold text-success">online</Text>
        </View>
      </View>
      <View className="flex-1 justify-end gap-1 p-3">
        <View
          className="max-w-[78%] self-start px-3 py-2"
          style={{
            borderTopLeftRadius: incoming.topLeft,
            borderTopRightRadius: incoming.topRight,
            borderBottomLeftRadius: incoming.bottomLeft,
            borderBottomRightRadius: incoming.bottomRight,
            backgroundColor: palette['bubble-in'],
            ...(prefs.look === 'soft' ? { boxShadow: card.boxShadow } : card),
          }}
        >
          <Text className="text-base text-on-bubble-in">this theme is so you</Text>
        </View>
        <View className="max-w-[78%] self-end px-3 py-2" style={outgoing(true, false)}>
          <Text className="text-base text-on-primary">ikr, changing it again tmrw</Text>
        </View>
        <View className="max-w-[78%] self-end px-3 py-2" style={outgoing(false, true)}>
          <Text className="text-base text-on-primary">picking a wallpaper now</Text>
          <View className="flex-row items-center justify-end gap-1">
            <Text className="text-xs text-on-primary/80">14:02</Text>
            <Icon icon={CheckCheckIcon} size={14} color="on-primary" />
          </View>
        </View>
      </View>
    </View>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <View className="gap-3">
      <View className="gap-1 px-1">
        <Text accessibilityRole="header" className="font-display text-xl text-foreground">
          {title}
        </Text>
        {hint && <Text className="text-muted">{hint}</Text>}
      </View>
      {children}
    </View>
  );
}

/** The check that pops in on the selected tile. */
function Selected() {
  const { moves } = useMotion();
  return (
    <Animated.View
      className="absolute right-2 top-2 h-6 w-6 items-center justify-center rounded-full bg-foreground"
      style={
        moves
          ? { animationName: CHECK_POP, animationDuration: 220, animationTimingFunction: CSS_POP }
          : undefined
      }
    >
      <Icon icon={CheckIcon} size={14} color="background" strokeWidth={3.2} />
    </Animated.View>
  );
}

function SchemePicker({
  prefs,
  update,
}: {
  prefs: AppearancePrefs;
  update: (patch: Partial<AppearancePrefs>) => void;
}) {
  const { dark } = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="radiogroup"
      accessibilityLabel="Color scheme"
      className="-mx-5"
      contentContainerClassName="gap-3 px-5 py-1"
    >
      {colorSchemes.map((scheme) => {
        const selected = prefs.scheme === scheme.id;
        const swatch = schemeSwatch(scheme.id, dark);
        const palette = resolvePalette(scheme.id, dark, prefs.pureBlack);
        return (
          <Tap
            key={scheme.id}
            accessibilityRole="radio"
            accessibilityLabel={`${scheme.name}. ${scheme.vibe}`}
            accessibilityState={{ selected }}
            feedback="selection"
            onPress={() => update({ scheme: scheme.id })}
            className="w-[116px] gap-2 rounded-xl p-2"
            style={{
              backgroundColor: palette.background,
              borderWidth: 2,
              borderColor: selected ? palette.accent : palette.border,
            }}
          >
            <View
              className="h-[72px] rounded-lg"
              style={{
                backgroundImage: `linear-gradient(135deg, ${swatch.from}, ${swatch.to})`,
              }}
            >
              <View
                className="absolute bottom-2 left-2 h-3 w-8 rounded-full"
                style={{ backgroundColor: palette['on-primary'], opacity: 0.8 }}
              />
              <View
                className="absolute left-2 top-2 h-5 w-5 rounded-full"
                style={{ backgroundColor: palette.secondary }}
              />
            </View>
            <Text
              numberOfLines={1}
              className="px-1 font-bold"
              style={{ color: palette.foreground }}
            >
              {scheme.name}
            </Text>
            {selected && <Selected />}
          </Tap>
        );
      })}
    </ScrollView>
  );
}

function BubbleTile({ id, label }: { id: BubbleShape; label: string }) {
  const { palette, prefs, card } = useTheme();
  const update = useAppearance((state) => state.update);
  const selected = prefs.bubble === id;
  const corners = bubbleCorners(id, { outgoing: true, first: true, last: true });
  return (
    <Tap
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      feedback="selection"
      onPress={() => update({ bubble: id })}
      className="min-w-[44%] flex-1 items-center gap-2 rounded-xl bg-surface py-4"
      style={{
        ...card,
        borderWidth: selected ? 2 : card.borderWidth,
        borderColor: selected ? palette.accent : card.borderColor,
      }}
    >
      <View
        className="h-9 w-[72px]"
        style={{
          borderTopLeftRadius: corners.topLeft,
          borderTopRightRadius: corners.topRight,
          borderBottomLeftRadius: corners.bottomLeft,
          borderBottomRightRadius: corners.bottomRight,
          backgroundImage: brandGradient(palette),
        }}
      />
      <Text className="font-bold text-foreground">{label}</Text>
      {selected && <Selected />}
    </Tap>
  );
}

function WallpaperTile({ id, label }: { id: WallpaperId; label: string }) {
  const { palette, prefs, dark } = useTheme();
  const update = useAppearance((state) => state.update);
  const selected = prefs.wallpaper === id;
  const xml = wallpaperSvg(id, palette, dark);
  return (
    <Tap
      accessibilityRole="radio"
      accessibilityLabel={`${label} wallpaper`}
      accessibilityState={{ selected }}
      feedback="selection"
      onPress={() => update({ wallpaper: id })}
      className="h-[132px] w-[84px] justify-end overflow-hidden rounded-xl bg-background"
      style={{
        borderWidth: 2,
        borderColor: selected ? palette.accent : palette.border,
      }}
    >
      {xml && (
        <View className="absolute inset-0">
          <SvgXml xml={xml} width="100%" height="100%" />
        </View>
      )}
      <View className="bg-surface/90 py-1">
        <Text numberOfLines={1} className="text-center text-xs font-bold text-foreground">
          {label}
        </Text>
      </View>
      {selected && <Selected />}
    </Tap>
  );
}

function FontTile({ id, label, description }: { id: FontId; label: string; description: string }) {
  const { palette, prefs, card } = useTheme();
  const update = useAppearance((state) => state.update);
  const selected = prefs.font === id;
  const ready = useLoadedFonts((state) => state.loaded.includes(id));
  // Each tile shows its own font, so opening this screen loads them all.
  useEffect(() => {
    void loadFont(id);
  }, [id]);
  const family = ready ? fontFamily(id, 'display') : undefined;
  return (
    <Tap
      accessibilityRole="radio"
      accessibilityLabel={`${label} font. ${description}`}
      accessibilityState={{ selected }}
      feedback="selection"
      onPress={() => update({ font: id })}
      className="min-w-[44%] flex-1 gap-1 rounded-xl bg-surface p-4"
      style={{
        ...card,
        borderWidth: selected ? 2 : card.borderWidth,
        borderColor: selected ? palette.accent : card.borderColor,
      }}
    >
      <Text
        className="text-foreground"
        style={{
          fontFamily: family,
          fontSize: 30,
          lineHeight: 36,
          ...(family ? {} : { fontWeight: '800' }),
        }}
      >
        Aa
      </Text>
      <Text className="font-bold text-foreground">{label}</Text>
      <Text numberOfLines={2} className="text-xs text-muted">
        {description}
      </Text>
      {selected && <Selected />}
    </Tap>
  );
}

function SwitchRow({
  title,
  subtitle,
  value,
  onChange,
}: {
  title: string;
  subtitle: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  const { card } = useTheme();
  return (
    <View className="flex-row items-center gap-3 rounded-xl bg-surface p-4" style={card}>
      <View className="flex-1 gap-1">
        <Text className="text-base font-bold text-foreground">{title}</Text>
        <Text className="text-muted">{subtitle}</Text>
      </View>
      <Toggle accessibilityLabel={title} value={value} onValueChange={onChange} />
    </View>
  );
}

function LookPreviewCard({
  id,
  label,
  description,
}: {
  id: AppearancePrefs['look'];
  label: string;
  description: string;
}) {
  const { palette, dark, prefs } = useTheme();
  const update = useAppearance((state) => state.update);
  const selected = prefs.look === id;
  const surface = surfaceStyle(palette, id, dark);
  return (
    <Tap
      accessibilityRole="radio"
      accessibilityLabel={`${label}. ${description}`}
      accessibilityState={{ selected }}
      feedback="selection"
      onPress={() => update({ look: id })}
      className="flex-1 items-center gap-2 rounded-xl p-2"
      style={{
        backgroundColor: selected ? `${palette.accent}1F` : 'transparent',
        borderWidth: 2,
        borderColor: selected ? palette.accent : 'transparent',
      }}
    >
      <View className="h-[64px] w-full rounded-lg bg-surface" style={surface} />
      <Text className="font-bold text-foreground">{label}</Text>
    </Tap>
  );
}

export function AppearanceScreen() {
  const prefs = useAppearance((state) => state.prefs);
  const update = useAppearance((state) => state.update);
  const reset = useAppearance((state) => state.reset);
  const { dark } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="gap-7 p-5"
      contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Preview />

      <Section title="Mode">
        <Segmented
          accessibilityLabel="Light or dark mode"
          options={modeOptions}
          value={prefs.mode}
          onChange={(mode) => update({ mode })}
        />
        {dark && (
          <SwitchRow
            title="Pure black"
            subtitle="True black backgrounds. Looks crisp and saves battery on OLED screens."
            value={prefs.pureBlack}
            onChange={(pureBlack) => update({ pureBlack })}
          />
        )}
      </Section>

      <Section title="Colors" hint="Every scheme works in light and dark.">
        <SchemePicker prefs={prefs} update={update} />
      </Section>

      <Section title="Look" hint="How cards, buttons and bars sit on the page.">
        <View accessibilityRole="radiogroup" className="flex-row gap-1">
          {lookOptions.map((option) => (
            <LookPreviewCard key={option.id} {...option} />
          ))}
        </View>
      </Section>

      <Section title="Chat bubbles">
        <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-3">
          {bubbleOptions.map((option) => (
            <BubbleTile key={option.id} id={option.id} label={option.label} />
          ))}
        </View>
      </Section>

      <Section title="Wallpaper">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          accessibilityRole="radiogroup"
          accessibilityLabel="Chat wallpaper"
          className="-mx-5"
          contentContainerClassName="gap-3 px-5 py-1"
        >
          {wallpaperOptions.map((option) => (
            <WallpaperTile key={option.id} id={option.id} label={option.label} />
          ))}
        </ScrollView>
      </Section>

      <Section title="Font">
        <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-3">
          {fontOptions.map((option) => (
            <FontTile
              key={option.id}
              id={option.id}
              label={option.label}
              description={option.description}
            />
          ))}
        </View>
      </Section>

      <Section title="Text size">
        <Segmented
          accessibilityLabel="Text size"
          options={textSizeOptions}
          value={prefs.textSize}
          onChange={(textSize) => update({ textSize })}
        />
      </Section>

      <Section title="Corners">
        <Segmented
          accessibilityLabel="Corner roundness"
          options={cornerOptions}
          value={prefs.corners}
          onChange={(corners) => update({ corners })}
        />
      </Section>

      <Section title="Profile pictures">
        <Segmented
          accessibilityLabel="Profile picture shape"
          options={avatarOptions}
          value={prefs.avatar}
          onChange={(avatar) => update({ avatar })}
        />
      </Section>

      <Section title="Spacing">
        <Segmented
          accessibilityLabel="Spacing"
          options={densityOptions}
          value={prefs.density}
          onChange={(density) => update({ density })}
        />
      </Section>

      <Section
        title="Motion"
        hint={motionOptions.find((option) => option.id === prefs.motion)?.description ?? ''}
      >
        <Segmented
          accessibilityLabel="Amount of animation"
          options={motionOptions}
          value={prefs.motion}
          onChange={(motion) => update({ motion })}
        />
      </Section>

      <SwitchRow
        title="Haptics"
        subtitle="Tiny vibrations when you swipe, react and send."
        value={prefs.haptics}
        onChange={(haptics) => update({ haptics })}
      />

      <Button
        label="Back to defaults"
        icon={RotateCcwIcon}
        variant="secondary"
        onPress={() =>
          Alert.alert(
            'Reset appearance?',
            'Colors, bubbles, wallpaper and the rest go back to how they started.',
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Reset', style: 'destructive', onPress: reset },
            ],
          )
        }
      />
      <Text className="px-1 text-center text-xs text-muted">
        These choices stay on this phone and never leave it.
      </Text>
    </ScrollView>
  );
}
