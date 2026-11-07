import { describe, expect, it } from 'vitest';

import {
  avatarColors,
  bubbleCorners,
  colorNames,
  colorSchemes,
  colorVariables,
  contrast,
  defaultAppearance,
  hsl,
  isDark,
  normalizeAppearance,
  radiusVariables,
  resolvePalette,
  schemeIds,
  senderColor,
  surfaceStyle,
  tailwindColors,
  tailwindRadii,
  toRgbChannels,
  wallpaperOptions,
  wallpaperSvg,
  withAlpha,
  type Palette,
} from './index';

const AA = 4.5;
const AAA = 7;
/** WCAG's minimum for large text and icons. */
const UI = 3;

function everyPalette(): { label: string; palette: Palette; dark: boolean }[] {
  return schemeIds.flatMap((id) => [
    { label: `${id} light`, palette: resolvePalette(id, false), dark: false },
    { label: `${id} dark`, palette: resolvePalette(id, true), dark: true },
    { label: `${id} pure black`, palette: resolvePalette(id, true, true), dark: true },
  ]);
}

describe('color helpers', () => {
  it('converts hex colors to RGB channels', () => {
    expect(toRgbChannels('#0B7A64')).toBe('11 122 100');
    expect(() => toRgbChannels('teal')).toThrow();
  });

  it('builds rgba strings and hsl colors', () => {
    expect(withAlpha('#FF0000', 0.5)).toBe('rgba(255, 0, 0, 0.5)');
    expect(hsl(0, 100, 50)).toBe('#FF0000');
    expect(hsl(0, 0, 100)).toBe('#FFFFFF');
    expect(hsl(240, 100, 50)).toBe('#0000FF');
  });

  it('computes WCAG contrast', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21);
    expect(contrast('#777777', '#777777')).toBeCloseTo(1);
  });
});

describe('color schemes', () => {
  it('offers ten distinct schemes', () => {
    expect(schemeIds).toHaveLength(10);
    expect(new Set(schemeIds).size).toBe(10);
    expect(new Set(colorSchemes.map((s) => s.name)).size).toBe(10);
  });

  it('defines every color as #RRGGBB in every mode', () => {
    for (const { palette, label } of everyPalette()) {
      expect(Object.keys(palette).sort(), label).toEqual([...colorNames].sort());
      for (const name of colorNames) {
        expect(palette[name], `${label} ${name}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    }
  });

  it('pure black is really black, and only in dark mode', () => {
    expect(resolvePalette('volt', true, true).background).toBe('#000000');
    expect(resolvePalette('volt', true, false).background).not.toBe('#000000');
    expect(resolvePalette('volt', false, true).background).not.toBe('#000000');
  });

  describe.each(everyPalette())('$label meets WCAG contrast', ({ palette: p }) => {
    it.each([
      ['foreground', 'background', AAA],
      ['foreground', 'surface', AAA],
      ['foreground', 'raised', AAA],
      ['muted', 'background', AA],
      ['muted', 'surface', AA],
      ['muted', 'raised', AA],
      ['on-primary', 'primary', AA],
      ['on-primary', 'primary-end', AA],
      ['on-secondary', 'secondary', AA],
      ['accent', 'background', AA],
      ['accent', 'surface', AA],
      ['accent', 'raised', UI],
      ['on-bubble-in', 'bubble-in', AAA],
      ['success', 'background', AA],
      ['success', 'surface', AA],
      ['warning', 'background', AA],
      ['warning', 'surface', AA],
      ['danger', 'background', AA],
      ['danger', 'surface', AA],
      ['on-danger', 'danger', AA],
    ] as const)('%s on %s', (text, background, minimum) => {
      expect(contrast(p[text], p[background])).toBeGreaterThanOrEqual(minimum);
    });
  });

  it('keeps group sender names readable on incoming bubbles', () => {
    const ids = ['a', 'bb', 'user-1', 'user-22', '665f1c2e9a', 'zzz', 'q1', 'k9'];
    for (const { palette, label, dark } of everyPalette()) {
      for (const id of ids) {
        expect(
          contrast(senderColor(id, dark), palette['bubble-in']),
          `${label} ${id}`,
        ).toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it('keeps avatar initials readable and stable', () => {
    for (const seed of ['Ana', 'kuntal', 'Group of friends', '@x', 'न', 'long name here']) {
      const { from, to, on } = avatarColors(seed);
      expect(contrast(on, from), seed).toBeGreaterThanOrEqual(AA);
      expect(contrast(on, to), seed).toBeGreaterThanOrEqual(AA);
      expect(avatarColors(seed)).toEqual({ from, to, on });
    }
  });
});

describe('css variables', () => {
  it('maps Tailwind colors onto the CSS variables', () => {
    const palette = resolvePalette('volt', true);
    expect(tailwindColors().primary).toBe('rgb(var(--color-primary) / <alpha-value>)');
    expect(colorVariables(palette)['--color-primary']).toBe(toRgbChannels(palette.primary));
    expect(Object.keys(colorVariables(palette))).toHaveLength(colorNames.length);
  });

  it('maps Tailwind radii onto the radius variables', () => {
    expect(tailwindRadii().lg).toBe('var(--radius-lg)');
    expect(tailwindRadii().full).toBe('9999px');
    expect(radiusVariables('round')['--radius-lg']).toBe(20);
    expect(radiusVariables('tight')['--radius-lg']).toBeLessThan(
      radiusVariables('extra')['--radius-lg'],
    );
  });
});

describe('appearance prefs', () => {
  it('fills in defaults for nothing stored', () => {
    expect(normalizeAppearance(undefined)).toEqual(defaultAppearance);
    expect(normalizeAppearance('nonsense')).toEqual(defaultAppearance);
    expect(normalizeAppearance({})).toEqual(defaultAppearance);
  });

  it('keeps valid values and drops unknown ones', () => {
    const prefs = normalizeAppearance({
      scheme: 'grape',
      look: 'sticker',
      motion: 'off',
      haptics: false,
      pureBlack: true,
      wallpaper: 'from-a-newer-build',
      mode: 7,
      extra: 'ignored',
    });
    expect(prefs.scheme).toBe('grape');
    expect(prefs.look).toBe('sticker');
    expect(prefs.motion).toBe('off');
    expect(prefs.haptics).toBe(false);
    expect(prefs.pureBlack).toBe(true);
    expect(prefs.wallpaper).toBe(defaultAppearance.wallpaper);
    expect(prefs.mode).toBe(defaultAppearance.mode);
    expect(prefs).not.toHaveProperty('extra');
  });

  it('resolves the mode against the device', () => {
    expect(isDark({ mode: 'system' }, true)).toBe(true);
    expect(isDark({ mode: 'system' }, false)).toBe(false);
    expect(isDark({ mode: 'light' }, true)).toBe(false);
    expect(isDark({ mode: 'dark' }, false)).toBe(true);
  });
});

describe('bubble corners', () => {
  it('tightens the corners on the sender side inside a run', () => {
    const middle = bubbleCorners('round', { outgoing: true, first: false, last: false });
    expect(middle.topRight).toBeLessThan(middle.topLeft);
    expect(middle.bottomRight).toBeLessThan(middle.bottomLeft);
    const incoming = bubbleCorners('round', { outgoing: false, first: false, last: false });
    expect(incoming.topLeft).toBeLessThan(incoming.topRight);
  });

  it('pinches only the last bubble of a run for the tail shape', () => {
    const last = bubbleCorners('tail', { outgoing: true, first: true, last: true });
    expect(last.bottomRight).toBe(2);
    const first = bubbleCorners('tail', { outgoing: true, first: true, last: false });
    expect(first.bottomRight).toBeGreaterThan(2);
  });
});

describe('surfaces', () => {
  const palette = resolvePalette('volt', false);

  it('gives each look its own treatment', () => {
    expect(surfaceStyle(palette, 'sticker', false).borderWidth).toBe(2);
    expect(surfaceStyle(palette, 'sticker', false).boxShadow).toContain(palette.foreground);
    expect(surfaceStyle(palette, 'outline', false).boxShadow).toBe('none');
    expect(surfaceStyle(palette, 'soft', false).borderWidth).toBe(0);
  });
});

describe('wallpapers', () => {
  it('draws every wallpaper except the plain one, in every mode', () => {
    for (const { id } of wallpaperOptions) {
      const svg = wallpaperSvg(id, resolvePalette('grape', true), true);
      if (id === 'none') expect(svg).toBeNull();
      else expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg".*<\/svg>$/);
    }
  });

  it('uses the scheme colors', () => {
    const palette = resolvePalette('mango', false);
    expect(wallpaperSvg('aurora', palette, false)).toContain(palette.primary);
  });
});
