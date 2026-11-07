import { Image } from 'expo-image';
import { View } from 'react-native';
import Animated from 'react-native-reanimated';

import { CSS_EASE_OUT, useMotion } from '@/theme/motion';
import { usePalette, useTheme } from '@/theme/theme-root';
import { avatarColors, avatarRadius } from '@pingdost/ui-tokens';

import { Text } from './text';

interface AvatarProps {
  /** A Cloudinary `secure_url`, or null for initials. */
  url: string | null | undefined;
  name: string;
  size?: number;
  /** A small "online" dot on the corner. */
  online?: boolean;
  /** A gradient ring: this chat has something new. */
  ring?: boolean;
}

function initials(name: string): string {
  const words = name.replace(/^@/, '').trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1 ? `${words[0]![0]}${words.at(-1)![0]}` : (words[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

const PULSE = {
  from: { transform: [{ scale: 1 }], opacity: 0.7 },
  to: { transform: [{ scale: 2.2 }], opacity: 0 },
};

function OnlineDot({ size, radius }: { size: number; radius: number }) {
  const palette = usePalette();
  const { moves } = useMotion();
  const dot = Math.max(10, Math.round(size * 0.26));
  // Sits on the rounded corner: on a circle that corner is further in.
  const inset = radius >= size / 2 ? Math.round(size * 0.02) : -Math.round(dot * 0.2);
  return (
    <View
      className="absolute items-center justify-center"
      style={{ right: inset, bottom: inset, width: dot, height: dot }}
    >
      {moves && (
        <Animated.View
          className="absolute rounded-full"
          style={{
            width: dot,
            height: dot,
            backgroundColor: palette.success,
            animationName: PULSE,
            animationDuration: 1800,
            animationIterationCount: 'infinite',
            animationTimingFunction: CSS_EASE_OUT,
          }}
        />
      )}
      <View
        className="rounded-full"
        style={{
          width: dot,
          height: dot,
          backgroundColor: palette.success,
          borderWidth: 2,
          borderColor: palette.background,
        }}
      />
    </View>
  );
}

/**
 * A profile picture, cached in memory and on disk by expo-image; colorful initials without one.
 * A person keeps their color across schemes; the shape follows the user's setting.
 */
export function Avatar({ url, name, size = 44, online = false, ring = false }: AvatarProps) {
  const { prefs } = useTheme();
  const palette = usePalette();
  const radius = avatarRadius(prefs.avatar, size);
  const style = { width: size, height: size, borderRadius: radius };
  const colors = avatarColors(name);
  const face = url ? (
    <Image
      source={{ uri: url }}
      style={style}
      cachePolicy="memory-disk"
      contentFit="cover"
      transition={150}
      accessibilityIgnoresInvertColors
      accessible={false}
    />
  ) : (
    <View
      style={[style, { backgroundImage: `linear-gradient(135deg, ${colors.from}, ${colors.to})` }]}
      className="items-center justify-center"
      importantForAccessibility="no"
    >
      <Text
        className="font-display"
        style={{
          color: colors.on,
          fontSize: Math.round(size * 0.38),
          lineHeight: Math.round(size * 0.46),
        }}
      >
        {initials(name)}
      </Text>
    </View>
  );
  const body = ring ? (
    <View
      className="items-center justify-center"
      style={{
        width: size + 8,
        height: size + 8,
        borderRadius: radius + 4,
        backgroundImage: `linear-gradient(135deg, ${palette.primary}, ${palette.secondary})`,
      }}
    >
      <View
        className="items-center justify-center"
        style={{
          width: size + 4,
          height: size + 4,
          borderRadius: radius + 2,
          backgroundColor: palette.background,
        }}
      >
        {face}
      </View>
    </View>
  ) : (
    face
  );
  if (!online) return body;
  return (
    <View>
      {body}
      <OnlineDot size={size} radius={radius} />
    </View>
  );
}
