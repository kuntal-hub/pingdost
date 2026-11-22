import { describe, expect, it } from 'vitest';

import {
  avatarColors,
  bubbleCorners,
  colorDistance,
  colorNames,
  colorSchemes,
  colorVariables,
  contrast,
  defaultAppearance,
  DELIVERED_TICK_ALPHA,
  gameBoardColors,
  gamePlayerColors,
  gamePlayerShapes,
  hsl,
  isDark,
  mix,
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
/** CIE76 ΔE at which two icon colors read as different colors, not shades. */
const DIFFERENT_AT_A_GLANCE = 30;

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

  it('mixes a color over another and measures how different colors look', () => {
    expect(mix('#000000', '#FFFFFF', 0.5)).toBe('#808080');
    expect(mix('#FF0000', '#0000FF', 1)).toBe('#FF0000');
    expect(colorDistance('#123456', '#123456')).toBe(0);
    expect(colorDistance('#000000', '#FFFFFF')).toBeCloseTo(100, 0);
    // Two grays a shade apart (the old ticks) are close; a blue and a gray are far apart.
    expect(colorDistance('#555555', '#333333')).toBeLessThan(DIFFERENT_AT_A_GLANCE);
    expect(colorDistance('#1D4ED8', '#555555')).toBeGreaterThan(DIFFERENT_AT_A_GLANCE);
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
      ['read', 'background', UI],
      ['read', 'surface', UI],
      ['read', 'raised', UI],
      ['on-primary-read', 'primary', UI],
      ['on-primary-read', 'primary-end', UI],
    ] as const)('%s on %s', (text, background, minimum) => {
      expect(contrast(p[text], p[background])).toBeGreaterThanOrEqual(minimum);
    });
  });

  // The user reported "delivered" (light gray) and "read" (dark gray) ticks as too alike. Read
  // must be another color, not another shade.
  it('keeps the read tick a different color from the delivered tick', () => {
    const DIFFERENT = DIFFERENT_AT_A_GLANCE;
    for (const { palette: p, label } of everyPalette()) {
      for (const fill of [p.primary, p['primary-end']]) {
        const delivered = mix(p['on-primary'], fill, DELIVERED_TICK_ALPHA);
        expect(
          colorDistance(p['on-primary-read'], delivered),
          `${label} bubble ${fill}`,
        ).toBeGreaterThanOrEqual(DIFFERENT);
      }
      expect(colorDistance(p.read, p.muted), `${label} list`).toBeGreaterThanOrEqual(DIFFERENT);
    }
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

  // Board games (ADR 0049): a piece's edge must read on the board and on every surface, the
  // shape glyph on its fill, and the four players must look like four different colors.
  it('keeps game pieces readable and the four players distinct', () => {
    for (const { palette, label, dark } of everyPalette()) {
      const board = gameBoardColors(dark);
      for (const color of gamePlayerColors) {
        const look = board.players[color];
        for (const [where, background] of [
          ['cell', board.cell],
          ['board', board.board],
          ['surface', palette.surface],
          ['background', palette.background],
        ] as const) {
          expect(
            contrast(look.ring, background),
            `${label} ${color} on ${where}`,
          ).toBeGreaterThanOrEqual(UI);
        }
        expect(contrast(look.on, look.fill), `${label} ${color} glyph`).toBeGreaterThanOrEqual(UI);
        expect(
          contrast(look.ring, look.soft),
          `${label} ${color} in its yard`,
        ).toBeGreaterThanOrEqual(UI);
        // The 3D shading reads as light and shadow of the same color, not as the color itself.
        expect(colorDistance(look.light, look.fill), `${label} ${color} light`).toBeGreaterThan(10);
        expect(colorDistance(look.dark, look.fill), `${label} ${color} dark`).toBeGreaterThan(10);
      }
      for (const a of gamePlayerColors) {
        for (const b of gamePlayerColors) {
          if (a >= b) continue;
          expect(
            colorDistance(board.players[a].fill, board.players[b].fill),
            `${label} ${a}/${b}`,
          ).toBeGreaterThanOrEqual(DIFFERENT_AT_A_GLANCE);
        }
      }
    }
    expect(new Set(Object.values(gamePlayerShapes)).size).toBe(gamePlayerColors.length);
  });

  // Phase 43 boards: ladders, snakes and square numbers read on both cell colors, the Connect
  // Four frame stands out from its holes, the dots from the board.
  it('keeps the quick-game boards readable', () => {
    for (const dark of [false, true]) {
      const board = gameBoardColors(dark);
      const label = dark ? 'dark' : 'light';
      for (const cell of [board.cell, board.cellAlt]) {
        expect(contrast(board.label, cell), `${label} label`).toBeGreaterThanOrEqual(AA);
        expect(contrast(board.ladder, cell), `${label} ladder`).toBeGreaterThanOrEqual(UI);
        for (const snake of board.snakes) {
          expect(contrast(snake, cell), `${label} snake ${snake}`).toBeGreaterThanOrEqual(UI);
        }
        for (const color of gamePlayerColors) {
          expect(
            contrast(board.players[color].ring, cell),
            `${label} ${color}`,
          ).toBeGreaterThanOrEqual(UI);
        }
      }
      expect(contrast(board.frame, board.board), `${label} frame`).toBeGreaterThanOrEqual(UI);
      expect(contrast(board.dot, board.board), `${label} dot`).toBeGreaterThanOrEqual(UI);
    }
  });

  // Chess (Phase 44): every piece's outline reads on both squares, black pieces stand out from
  // the dark squares, the coordinates are readable text, and the two squares differ.
  it('keeps the chess board readable', () => {
    for (const dark of [false, true]) {
      const { chess } = gameBoardColors(dark);
      const label = dark ? 'dark' : 'light';
      for (const square of [chess.light, chess.dark]) {
        expect(contrast(chess.white.edge, square), `${label} white edge`).toBeGreaterThanOrEqual(
          UI,
        );
        expect(contrast(chess.black.edge, square), `${label} black edge`).toBeGreaterThanOrEqual(
          UI,
        );
        expect(contrast(chess.black.fill, square), `${label} black fill`).toBeGreaterThanOrEqual(
          UI,
        );
        expect(contrast(chess.coord, square), `${label} coordinates`).toBeGreaterThanOrEqual(AA);
      }
      expect(contrast(chess.white.detail, chess.white.fill)).toBeGreaterThanOrEqual(UI);
      expect(contrast(chess.black.detail, chess.black.fill)).toBeGreaterThanOrEqual(UI);
      expect(colorDistance(chess.light, chess.dark), `${label} squares`).toBeGreaterThan(20);
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
