import { useRouter, useSegments } from 'expo-router';
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { useState } from 'react';
import { Modal, Pressable, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CSS_EASE_IN_OUT, CSS_EASE_OUT, CSS_POP, haptic, useMotion } from '@/theme/motion';
import { useTheme } from '@/theme/theme-root';
import { brandGradient } from '@pingdost/ui-tokens';

import {
  Icon,
  MessageCircleIcon,
  MessageCirclePlusIcon,
  PhoneIcon,
  PlusIcon,
  SettingsIcon,
  UsersRoundIcon,
  type LucideIcon,
} from './icon';
import { Tap } from './tap';
import { Text } from './text';

const BAR_HEIGHT = 64;
/** The first screen of each tab; deeper screens get the whole height. */
const ROOT_SCREENS: readonly string[] = ['chats', 'calls', 'settings'];
const PAD = 5;

const TABS: Record<string, { label: string; icon: LucideIcon }> = {
  '(chats)': { label: 'Chats', icon: MessageCircleIcon },
  '(calls)': { label: 'Calls', icon: PhoneIcon },
  '(settings)': { label: 'Settings', icon: SettingsIcon },
};

/** Bottom padding that keeps a tab's content clear of the floating bar. */
export function useTabBarInset(): number {
  const insets = useSafeAreaInsets();
  return insets.bottom + BAR_HEIGHT + 32;
}

const DIAL_IN = {
  from: { transform: [{ translateY: 18 }, { scale: 0.9 }], opacity: 0 },
  to: { transform: [{ translateY: 0 }, { scale: 1 }], opacity: 1 },
};

/** The "+" beside the tabs: opens a small fan of "start something" actions. */
function NewButton() {
  const router = useRouter();
  const { floating, palette, prefs } = useTheme();
  const insets = useSafeAreaInsets();
  const { moves, fades } = useMotion();
  const [open, setOpen] = useState(false);

  const fill = {
    backgroundImage: `linear-gradient(135deg, ${palette.secondary}, ${palette.secondary})`,
    ...(prefs.look === 'sticker' ? floating : { boxShadow: floating.boxShadow }),
  };

  const items = [
    { label: 'New chat', icon: MessageCirclePlusIcon, href: '/new-chat' as const },
    { label: 'New group', icon: UsersRoundIcon, href: '/new-group' as const },
  ];

  const button = (rotated: boolean) => (
    <Tap
      accessibilityLabel={rotated ? 'Close' : 'Start a new chat or group'}
      accessibilityState={{ expanded: rotated }}
      feedback="light"
      scaleTo={0.9}
      onPress={() => setOpen(!open)}
      className="items-center justify-center rounded-full"
      style={[{ width: BAR_HEIGHT, height: BAR_HEIGHT }, fill]}
    >
      <Animated.View
        style={{
          transform: [{ rotate: rotated ? '45deg' : '0deg' }],
          ...(moves
            ? {
                transitionProperty: 'transform',
                transitionDuration: 220,
                transitionTimingFunction: CSS_POP,
              }
            : {}),
        }}
      >
        <Icon icon={PlusIcon} size={28} color="on-secondary" strokeWidth={2.6} />
      </Animated.View>
    </Tap>
  );

  return (
    <>
      {button(false)}
      <Modal
        visible={open}
        transparent
        statusBarTranslucent
        navigationBarTranslucent
        animationType={fades ? 'fade' : 'none'}
        onRequestClose={() => setOpen(false)}
      >
        <Pressable
          accessibilityLabel="Close"
          onPress={() => setOpen(false)}
          className="flex-1"
          style={{ backgroundColor: 'rgba(5, 5, 15, 0.55)' }}
        />
        <View
          pointerEvents="box-none"
          className="absolute right-4 items-end gap-3"
          style={{ bottom: insets.bottom + 12 }}
        >
          {items.map((item, index) => (
            <Animated.View
              key={item.label}
              style={
                moves
                  ? {
                      animationName: DIAL_IN,
                      animationDuration: 260,
                      animationDelay: (items.length - 1 - index) * 50,
                      animationFillMode: 'both',
                      animationTimingFunction: CSS_POP,
                    }
                  : undefined
              }
            >
              <Tap
                accessibilityLabel={item.label}
                feedback="selection"
                onPress={() => {
                  setOpen(false);
                  router.push(item.href);
                }}
                className="min-h-[52px] flex-row items-center gap-3 rounded-full bg-surface pl-4 pr-5"
                style={floating}
              >
                <Icon icon={item.icon} size={22} color="accent" />
                <Text className="text-base font-bold text-foreground">{item.label}</Text>
              </Tap>
            </Animated.View>
          ))}
          {button(true)}
        </View>
      </Modal>
    </>
  );
}

/**
 * The tab bar floats over the content as a pill, with a highlight that slides between tabs. It
 * drops out of the way when a tab's stack goes deeper. Tab switches themselves do not animate:
 * they happen too often to be worth waiting for.
 */
export function FloatingTabBar({ state, emitter, navigateToTab }: BottomTabBarProps) {
  const { palette, floating } = useTheme();
  const insets = useSafeAreaInsets();
  const { moves, fades } = useMotion();
  const [width, setWidth] = useState(0);
  const slot = width > 0 ? (width - PAD * 2) / state.routes.length : 0;
  const focused = state.routes[state.index];
  const hidden = !ROOT_SCREENS.includes(useSegments().at(-1) ?? '');
  const onChats = focused?.name === '(chats)';

  return (
    <Animated.View
      pointerEvents={hidden ? 'none' : 'box-none'}
      className="absolute left-4 right-4 flex-row items-center gap-3"
      style={{
        bottom: insets.bottom + 12,
        opacity: hidden ? 0 : 1,
        transform: [{ translateY: hidden ? BAR_HEIGHT + insets.bottom + 24 : 0 }],
        ...(fades
          ? {
              transitionProperty: ['transform', 'opacity'],
              transitionDuration: 220,
              transitionTimingFunction: CSS_EASE_OUT,
            }
          : {}),
      }}
    >
      <View
        accessibilityRole="tablist"
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        className="flex-1 flex-row rounded-full bg-surface"
        style={[{ height: BAR_HEIGHT, padding: PAD }, floating]}
      >
        {slot > 0 && (
          <Animated.View
            className="rounded-full"
            style={{
              position: 'absolute',
              top: PAD - floating.borderWidth,
              bottom: PAD - floating.borderWidth,
              left: PAD - floating.borderWidth,
              width: slot,
              backgroundImage: brandGradient(palette),
              transform: [{ translateX: slot * state.index }],
              ...(fades
                ? {
                    transitionProperty: 'transform',
                    transitionDuration: moves ? 300 : 120,
                    transitionTimingFunction: moves ? CSS_POP : CSS_EASE_IN_OUT,
                  }
                : {}),
            }}
          />
        )}
        {state.routes.map((route, index) => {
          const tab = TABS[route.name];
          if (!tab) return null;
          const active = index === state.index;
          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityLabel={tab.label}
              accessibilityState={{ selected: active }}
              onPress={() => {
                const event = emitter.emit({
                  type: 'tabPress',
                  target: route.key,
                  canPreventDefault: true,
                });
                if (active || event.defaultPrevented) return;
                haptic('selection');
                navigateToTab(route.key);
              }}
              className="flex-1 items-center justify-center gap-1"
            >
              <Icon
                icon={tab.icon}
                size={22}
                color={active ? 'on-primary' : 'muted'}
                strokeWidth={active ? 2.6 : 2.2}
              />
              <Text
                numberOfLines={1}
                className={`text-xs font-bold ${active ? 'text-on-primary' : 'text-muted'}`}
              >
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {onChats && <NewButton />}
    </Animated.View>
  );
}
