// Camera effects in a video call (ADR 0038, 0048): the groups (Beauty, Lenses, Fun, Filters) as
// tabs over a sideways row of round buttons, "None" first. Picking one applies it at once.
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { Segmented } from '@/components/controls';
import { BanIcon, EFFECT_ICONS, Icon, type LucideIcon } from '@/components/icon';
import { Tap } from '@/components/tap';
import { Text } from '@/components/text';
import { usePalette } from '@/theme/theme-root';
import { EFFECT_GROUPS, type VideoEffect, type VideoEffectKind } from '@pingdost/call-engine';
import { brandGradient } from '@pingdost/ui-tokens';

function EffectButton({
  label,
  icon,
  selected,
  onPress,
}: {
  label: string;
  icon: LucideIcon;
  selected: boolean;
  onPress: () => void;
}) {
  const palette = usePalette();
  return (
    <Tap
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      feedback="selection"
      scaleTo={0.9}
      onPress={onPress}
      className="w-[70px] items-center gap-1"
    >
      <View
        className={`h-14 w-14 items-center justify-center rounded-full ${selected ? '' : 'bg-white/15'}`}
        style={
          selected
            ? { backgroundImage: brandGradient(palette), borderWidth: 2, borderColor: '#FFFFFF' }
            : undefined
        }
      >
        <Icon icon={icon} size={26} color={selected ? 'on-primary' : '#FFFFFF'} strokeWidth={2} />
      </View>
      <Text
        className={`text-center text-xs text-white ${selected ? 'font-bold' : 'font-semibold'}`}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Tap>
  );
}

export function EffectPicker({
  effects,
  value,
  onChange,
}: {
  effects: readonly VideoEffect[];
  value: string;
  onChange: (id: string) => void;
}) {
  const groups = EFFECT_GROUPS.filter((group) => effects.some((e) => e.kind === group.kind));
  const [kind, setKind] = useState<VideoEffectKind>(
    () => effects.find((e) => e.id === value)?.kind ?? groups[0]?.kind ?? 'beauty',
  );
  const shown = effects.filter((effect) => effect.kind === kind);
  return (
    <View className="gap-3">
      <View className="px-5">
        <Segmented
          options={groups.map((group) => ({ id: group.kind, label: group.label }))}
          value={kind}
          onChange={setKind}
          accessibilityLabel="Effect groups"
        />
      </View>
      <ScrollView
        horizontal
        accessibilityRole="radiogroup"
        accessibilityLabel="Camera effects"
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-1 px-4"
      >
        <EffectButton
          label="None"
          icon={BanIcon}
          selected={value === 'none'}
          onPress={() => onChange('none')}
        />
        {shown.map((effect) => (
          <EffectButton
            key={effect.id}
            label={effect.label}
            icon={EFFECT_ICONS[effect.icon]}
            selected={value === effect.id}
            onPress={() => onChange(effect.id)}
          />
        ))}
      </ScrollView>
      <Text className="px-5 text-xs font-semibold text-white/80">
        {kind === 'lens' || kind === 'fun'
          ? 'Face effects follow your face. Everything runs on your phone before the picture is encrypted.'
          : 'Effects run on your phone before the picture is encrypted.'}
      </Text>
    </View>
  );
}
