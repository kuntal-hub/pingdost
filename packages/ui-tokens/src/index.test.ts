import { describe, expect, it } from 'vitest';

import { colorNames, colorVariables, palettes, tailwindColors, toRgbChannels } from './index';

describe('ui tokens', () => {
  it('converts hex colors to RGB channels', () => {
    expect(toRgbChannels('#0B7A64')).toBe('11 122 100');
    expect(() => toRgbChannels('teal')).toThrow();
  });

  it('defines every color in both schemes', () => {
    for (const scheme of ['light', 'dark'] as const) {
      expect(Object.keys(palettes[scheme]).sort()).toEqual([...colorNames].sort());
      expect(Object.keys(colorVariables(scheme))).toHaveLength(colorNames.length);
    }
  });

  it('maps Tailwind colors onto the CSS variables', () => {
    expect(tailwindColors().primary).toBe('rgb(var(--color-primary) / <alpha-value>)');
    expect(colorVariables('dark')['--color-primary']).toBe(toRgbChannels(palettes.dark.primary));
  });
});
