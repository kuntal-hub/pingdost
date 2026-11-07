// Tailwind v3 config for NativeWind v4. CommonJS because `nativewind/preset` ships no types;
// Tailwind loads it (and the TypeScript tokens package) through jiti.
const plugin = require('tailwindcss/plugin');

const {
  colorVariables,
  radiusVariables,
  resolvePalette,
  spacing,
  tailwindColors,
  tailwindRadii,
} = require('@pingdost/ui-tokens');

/** @param {Record<string | number, number>} scale */
const px = (scale) =>
  Object.fromEntries(Object.entries(scale).map(([key, value]) => [key, `${value}px`]));

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    colors: { transparent: 'transparent', ...tailwindColors() },
    spacing: px(spacing),
    borderRadius: tailwindRadii(),
    extend: {},
  },
  plugins: [
    // Default values on :root; `ThemeRoot` swaps in the user's scheme and corners at runtime.
    plugin(({ addBase }) =>
      addBase({
        ':root': {
          ...colorVariables(resolvePalette('volt', false)),
          ...px(radiusVariables('round')),
        },
      }),
    ),
  ],
};
