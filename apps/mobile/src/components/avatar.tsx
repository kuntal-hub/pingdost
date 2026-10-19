import { Image } from 'expo-image';
import { Text, View } from 'react-native';

interface AvatarProps {
  /** A Cloudinary `secure_url`, or null for initials. */
  url: string | null | undefined;
  name: string;
  size?: number;
}

function initials(name: string): string {
  const words = name.replace(/^@/, '').trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1 ? `${words[0]![0]}${words.at(-1)![0]}` : (words[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

/** A round profile picture, cached in memory and on disk by expo-image; initials without one. */
export function Avatar({ url, name, size = 44 }: AvatarProps) {
  const style = { width: size, height: size, borderRadius: size / 2 };
  if (url) {
    return (
      <Image
        source={{ uri: url }}
        style={style}
        cachePolicy="memory-disk"
        contentFit="cover"
        transition={150}
        accessibilityIgnoresInvertColors
        accessible={false}
      />
    );
  }
  return (
    <View
      style={style}
      className="items-center justify-center bg-primary"
      importantForAccessibility="no"
    >
      <Text className="font-semibold text-on-primary" style={{ fontSize: size * 0.38 }}>
        {initials(name)}
      </Text>
    </View>
  );
}
