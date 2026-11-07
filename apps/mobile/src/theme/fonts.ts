// The font choices (ADR 0035). React Native picks an Android font by file, not by weight, so each
// weight is its own family: `pd-pop-600`. Only the chosen font is loaded; the others load when
// picked in Appearance.
/* eslint-disable @typescript-eslint/no-require-imports -- Metro bundles assets through require() */
import * as Font from 'expo-font';
import { create } from 'zustand';

import type { FontId } from '@pingdost/ui-tokens';

import { createSerialQueue } from './serial-queue';

/** The weights we ship; 500 maps to 600 so the app carries four files per font. */
export type FontWeight = 400 | 600 | 700 | 'display';

type CustomFont = Exclude<FontId, 'system'>;

const SOURCES: Record<CustomFont, Record<FontWeight, number>> = {
  pop: {
    400: require('@expo-google-fonts/figtree/400Regular/Figtree_400Regular.ttf') as number,
    600: require('@expo-google-fonts/figtree/600SemiBold/Figtree_600SemiBold.ttf') as number,
    700: require('@expo-google-fonts/figtree/700Bold/Figtree_700Bold.ttf') as number,
    display:
      require('@expo-google-fonts/bricolage-grotesque/800ExtraBold/BricolageGrotesque_800ExtraBold.ttf') as number,
  },
  bubbly: {
    400: require('@expo-google-fonts/nunito/400Regular/Nunito_400Regular.ttf') as number,
    600: require('@expo-google-fonts/nunito/600SemiBold/Nunito_600SemiBold.ttf') as number,
    700: require('@expo-google-fonts/nunito/800ExtraBold/Nunito_800ExtraBold.ttf') as number,
    display: require('@expo-google-fonts/fredoka/600SemiBold/Fredoka_600SemiBold.ttf') as number,
  },
  tech: {
    400: require('@expo-google-fonts/space-grotesk/400Regular/SpaceGrotesk_400Regular.ttf') as number,
    600: require('@expo-google-fonts/space-grotesk/500Medium/SpaceGrotesk_500Medium.ttf') as number,
    700: require('@expo-google-fonts/space-grotesk/700Bold/SpaceGrotesk_700Bold.ttf') as number,
    display: require('@expo-google-fonts/space-grotesk/700Bold/SpaceGrotesk_700Bold.ttf') as number,
  },
};

const familyName = (font: CustomFont, weight: FontWeight) => `pd-${font}-${weight}`;

/** Which fonts are ready; text uses the system font until then. */
export const useLoadedFonts = create<{ loaded: readonly FontId[] }>(() => ({
  loaded: ['system'],
}));

/** The family for this font and weight, or undefined for the system font. */
export function fontFamily(font: FontId, weight: FontWeight): string | undefined {
  return font === 'system' ? undefined : familyName(font, weight);
}

const loading = new Map<FontId, Promise<void>>();

/**
 * Font files load one at a time. Two weights can share a file (`tech`), and expo-asset writes a
 * download straight to its final path, truncating it, with no guard against a second download of
 * the same file. FreeType maps that file, so a truncation during a load is a native SIGBUS, seen on
 * a real phone opening Appearance. In sequence, the later weight finds the file with the right hash
 * and never rewrites it.
 */
const enqueueFace = createSerialQueue();

/** Loads a font once. Never rejects: on failure the text just stays in the system font. */
export function loadFont(font: FontId): Promise<void> {
  if (font === 'system') return Promise.resolve();
  const existing = loading.get(font);
  if (existing) return existing;
  const faces = (Object.entries(SOURCES[font]) as unknown as [FontWeight, number][]).map(
    ([weight, source]) => enqueueFace(() => Font.loadAsync({ [familyName(font, weight)]: source })),
  );
  const task = Promise.all(faces).then(
    () => useLoadedFonts.setState((state) => ({ loaded: [...state.loaded, font] })),
    (error: unknown) => {
      loading.delete(font);
      if (__DEV__) console.warn('font load failed', error);
    },
  );
  loading.set(font, task);
  return task;
}
