// Every piece of text in the app goes through these (ADR 0035). React Native has no inherited
// font, so `Text` applies the user's font and text size here. Screens keep writing the usual
// classes: `text-lg font-semibold`. `font-display` is the headline face.
import { createContext, useContext, type ComponentProps, type ComponentPropsWithRef } from 'react';
import { Text as NativeText, TextInput as NativeInput, type TextStyle } from 'react-native';

import { useAppearance } from '@/theme/appearance';
import { fontFamily, useLoadedFonts, type FontWeight } from '@/theme/fonts';
import { usePalette } from '@/theme/theme-root';
import { textScales, typeScale, type FontId } from '@pingdost/ui-tokens';

const SIZE = /(?:^|\s)text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl)(?=\s|$)/;
const WEIGHT = /(?:^|\s)font-(normal|medium|semibold|bold|extrabold|black|display)(?=\s|$)/;
const COLOR =
  /(?:^|\s)text-(?!xs(\s|$)|sm(\s|$)|base(\s|$)|lg(\s|$)|xl(\s|$)|\dxl(\s|$)|center|left|right|justify)/;

const WEIGHTS: Record<string, FontWeight> = {
  normal: 400,
  medium: 600,
  semibold: 600,
  bold: 700,
  extrabold: 'display',
  black: 'display',
  display: 'display',
};

const SYSTEM_WEIGHTS: Record<FontWeight, TextStyle['fontWeight']> = {
  400: '400',
  600: '600',
  700: '700',
  display: '800',
};

type Size = keyof typeof typeScale;

interface Parsed {
  /** The classes NativeWind should still see. */
  rest: string;
  size: Size | undefined;
  weight: FontWeight | undefined;
}

const parsedClasses = new Map<string, Parsed>();

function parse(className: string | undefined, nested: boolean): Parsed {
  const key = `${nested ? 'n' : 't'}:${className ?? ''}`;
  const cached = parsedClasses.get(key);
  if (cached) return cached;
  const text = className ?? '';
  const size = SIZE.exec(text)?.[1] as Size | undefined;
  const weightName = WEIGHT.exec(text)?.[1];
  const rest = text.replace(SIZE, ' ').replace(WEIGHT, ' ').trim();
  const parsed: Parsed = {
    // Nested text inherits its color; top-level text defaults to the foreground color.
    rest: nested || COLOR.test(text) ? rest : `text-foreground ${rest}`,
    size,
    weight: weightName ? WEIGHTS[weightName] : undefined,
  };
  parsedClasses.set(key, parsed);
  return parsed;
}

function fontStyle(
  parsed: Parsed,
  font: FontId,
  ready: boolean,
  scale: number,
  options: { nested: boolean; input: boolean },
): TextStyle {
  const style: { -readonly [K in keyof TextStyle]: TextStyle[K] } = {};
  // Nested text inherits whatever it does not set.
  if (parsed.size || !options.nested) {
    const [size, line] = typeScale[parsed.size ?? (options.input ? 'base' : 'sm')];
    style.fontSize = Math.round(size * scale);
    if (!options.input) style.lineHeight = Math.round(line * scale);
  }
  if (parsed.weight !== undefined || !options.nested) {
    const weight = parsed.weight ?? 400;
    const family = ready ? fontFamily(font, weight) : undefined;
    if (family) style.fontFamily = family;
    else style.fontWeight = SYSTEM_WEIGHTS[weight];
  }
  return style;
}

const InsideText = createContext(false);

function useFontSettings() {
  const font = useAppearance((state) => state.prefs.font);
  const scale = useAppearance((state) => textScales[state.prefs.textSize]);
  const ready = useLoadedFonts((state) => state.loaded.includes(font));
  return { font, scale, ready };
}

export function Text({ className, style, children, ...props }: ComponentProps<typeof NativeText>) {
  const nested = useContext(InsideText);
  const { font, scale, ready } = useFontSettings();
  const parsed = parse(className, nested);
  const base = fontStyle(parsed, font, ready, scale, { nested, input: false });
  const node = (
    <NativeText className={parsed.rest} style={[base, style]} {...props}>
      {children}
    </NativeText>
  );
  // A string has no nested text to tell, which is nearly every text on screen.
  if (typeof children === 'string' || nested) return node;
  return <InsideText.Provider value={true}>{node}</InsideText.Provider>;
}

export function TextInput({
  className,
  style,
  ...props
}: ComponentPropsWithRef<typeof NativeInput>) {
  const palette = usePalette();
  const { font, scale, ready } = useFontSettings();
  const parsed = parse(className, false);
  const base = fontStyle(parsed, font, ready, scale, { nested: false, input: true });
  return (
    <NativeInput
      placeholderTextColor={palette.muted}
      selectionColor={palette.accent}
      cursorColor={palette.accent}
      className={parsed.rest}
      style={[base, style]}
      {...props}
    />
  );
}
