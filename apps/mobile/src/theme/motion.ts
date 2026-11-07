// Motion and haptics (ADR 0035): the user's setting and the system's "reduce motion" both count,
// and whichever is calmer wins.
import * as Haptics from 'expo-haptics';
import { Easing, cubicBezier, useReducedMotion } from 'react-native-reanimated';

import type { Motion } from '@pingdost/ui-tokens';

import { useAppearance } from './appearance';

/** `transitionTimingFunction` / `animationTimingFunction` of a Reanimated CSS style. */
export const CSS_EASE_OUT = cubicBezier(0.23, 1, 0.32, 1);
export const CSS_EASE_IN_OUT = cubicBezier(0.77, 0, 0.175, 1);
/** A little overshoot, for things that pop in. Only used at the "full" setting. */
export const CSS_POP = cubicBezier(0.34, 1.56, 0.64, 1);

/** For `withTiming`. */
export const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

/**
 * What may move now. `full`: springs, scale and bursts. `calm`: fades and color changes only.
 * `off`: nothing moves; state changes just happen.
 */
export function useMotion(): { level: Motion; moves: boolean; fades: boolean } {
  const setting = useAppearance((state) => state.prefs.motion);
  const reduced = useReducedMotion();
  const level: Motion = setting === 'full' && reduced ? 'calm' : setting;
  return { level, moves: level === 'full', fades: level !== 'off' };
}

type HapticKind = 'selection' | 'light' | 'medium' | 'success' | 'warning' | 'error';

/** One haptic per user action, at the moment it happens; never the only feedback. */
export function haptic(kind: HapticKind): void {
  if (!useAppearance.getState().prefs.haptics) return;
  // Devices without a vibrator (and the emulator) reject: nothing to do about that.
  const done = (): void => undefined;
  switch (kind) {
    case 'selection':
      void Haptics.selectionAsync().catch(done);
      break;
    case 'light':
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(done);
      break;
    case 'medium':
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(done);
      break;
    case 'success':
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(done);
      break;
    case 'warning':
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(done);
      break;
    case 'error':
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(done);
      break;
  }
}
