// Small interactive controls used across settings and lists.
import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { CSS_EASE_IN_OUT, CSS_POP, haptic, useMotion } from '@/theme/motion';
import { usePalette, useTheme } from '@/theme/theme-root';
import { brandGradient } from '@pingdost/ui-tokens';

import { CheckIcon, Icon } from './icon';
import { Tap } from './tap';
import { Text } from './text';

const MARK_POP = {
  from: { transform: [{ scale: 0.3 }] },
  to: { transform: [{ scale: 1 }] },
};

/** The motion of a state change, or none when the user turned motion off. */
function useTransition(duration: number, property: 'transform' | 'all' = 'transform') {
  const { moves, fades } = useMotion();
  if (!fades) return {};
  return {
    transitionProperty: property,
    transitionDuration: moves ? duration : Math.min(duration, 120),
    transitionTimingFunction: moves ? CSS_POP : CSS_EASE_IN_OUT,
  };
}

const TRACK = { width: 52, height: 32 };
const THUMB = 24;
const INSET = 4;

interface ToggleProps {
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  accessibilityLabel: string;
}

/** An on/off switch whose thumb pops across. */
export function Toggle({ value, onValueChange, disabled, accessibilityLabel }: ToggleProps) {
  const palette = usePalette();
  const transition = useTransition(220);
  const colors = useTransition(180, 'all');
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      disabled={disabled}
      hitSlop={8}
      onPress={() => {
        haptic('selection');
        onValueChange(!value);
      }}
      style={{ opacity: disabled ? 0.5 : 1 }}
    >
      <Animated.View
        style={{
          ...TRACK,
          borderRadius: TRACK.height / 2,
          backgroundColor: value ? palette.primary : palette.raised,
          borderWidth: 1,
          borderColor: value ? palette.primary : palette.border,
          ...colors,
        }}
      >
        <Animated.View
          style={{
            position: 'absolute',
            top: INSET - 1,
            left: INSET - 1,
            width: THUMB,
            height: THUMB,
            borderRadius: THUMB / 2,
            backgroundColor: value ? palette['on-primary'] : palette.muted,
            transform: [{ translateX: value ? TRACK.width - THUMB - INSET * 2 : 0 }],
            ...transition,
          }}
        />
      </Animated.View>
    </Pressable>
  );
}

interface SegmentedProps<Id extends string> {
  options: readonly { id: Id; label: string }[];
  value: Id;
  onChange: (id: Id) => void;
  accessibilityLabel: string;
}

/** Choose one of a few; the highlight slides between them. */
export function Segmented<Id extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
}: SegmentedProps<Id>) {
  const palette = usePalette();
  const [width, setWidth] = useState(0);
  const transition = useTransition(260);
  const index = Math.max(
    0,
    options.findIndex((option) => option.id === value),
  );
  const slot = width > 0 ? (width - 8) / options.length : 0;
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      className="flex-row rounded-full bg-raised p-1"
    >
      {slot > 0 && (
        <Animated.View
          style={{
            position: 'absolute',
            top: 4,
            bottom: 4,
            left: 4,
            width: slot,
            borderRadius: 999,
            backgroundImage: brandGradient(palette),
            transform: [{ translateX: slot * index }],
            ...transition,
          }}
        />
      )}
      {options.map((option) => {
        const selected = option.id === value;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            onPress={() => {
              if (selected) return;
              haptic('selection');
              onChange(option.id);
            }}
            className="min-h-[40px] flex-1 items-center justify-center px-1"
          >
            <Text
              numberOfLines={1}
              className={`font-bold ${selected ? 'text-on-primary' : 'text-muted'}`}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

interface ChipProps {
  label: string;
  selected?: boolean;
  count?: number;
  onPress: () => void;
  icon?: ReactNode;
}

/** A filter or quick option. */
export function Chip({ label, selected = false, count, onPress, icon }: ChipProps) {
  const { palette, card, prefs } = useTheme();
  return (
    <Tap
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={count ? `${label}, ${count}` : label}
      feedback="selection"
      onPress={onPress}
      className="min-h-[38px] flex-row items-center gap-2 rounded-full px-4"
      style={
        selected
          ? {
              backgroundImage: brandGradient(palette),
              ...(prefs.look === 'sticker' ? card : {}),
            }
          : { backgroundColor: palette.surface, ...card, boxShadow: 'none' }
      }
    >
      {icon}
      <Text className={`font-bold ${selected ? 'text-on-primary' : 'text-foreground'}`}>
        {label}
      </Text>
      {count !== undefined && count > 0 && (
        <View
          className={`min-w-[20px] items-center rounded-full px-1 ${selected ? 'bg-on-primary/20' : 'bg-accent/20'}`}
        >
          <Text className={`text-xs font-bold ${selected ? 'text-on-primary' : 'text-accent'}`}>
            {count > 99 ? '99+' : count}
          </Text>
        </View>
      )}
    </Tap>
  );
}

/** A checkbox's mark; the row around it carries the role and the label. */
export function CheckMark({ checked }: { checked: boolean }) {
  const { moves } = useMotion();
  return (
    <View
      importantForAccessibility="no"
      className={`h-6 w-6 items-center justify-center rounded-sm border-2 ${
        checked ? 'border-accent bg-accent' : 'border-muted'
      }`}
    >
      {checked && (
        <Animated.View
          style={
            moves
              ? {
                  animationName: MARK_POP,
                  animationDuration: 200,
                  animationTimingFunction: CSS_POP,
                }
              : undefined
          }
        >
          <Icon icon={CheckIcon} size={16} color="background" strokeWidth={3.4} />
        </Animated.View>
      )}
    </View>
  );
}

/** A radio button's mark. */
export function RadioMark({ checked }: { checked: boolean }) {
  const { moves } = useMotion();
  return (
    <View
      importantForAccessibility="no"
      className={`h-6 w-6 items-center justify-center rounded-full border-2 ${
        checked ? 'border-accent' : 'border-muted'
      }`}
    >
      {checked && (
        <Animated.View
          className="h-3 w-3 rounded-full bg-accent"
          style={
            moves
              ? {
                  animationName: MARK_POP,
                  animationDuration: 200,
                  animationTimingFunction: CSS_POP,
                }
              : undefined
          }
        />
      )}
    </View>
  );
}

/** A horizontally scrolling row of chips or options. */
export function ChipRow({ children, label }: { children: ReactNode; label: string }) {
  return (
    <ScrollView
      horizontal
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-2 px-5 py-1"
    >
      {children}
    </ScrollView>
  );
}
