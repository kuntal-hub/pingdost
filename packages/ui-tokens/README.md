# @pingdost/ui-tokens

The design system both apps share (ARCHITECTURE A1, ADR 0035).

- `schemes.ts`: the color schemes, `resolvePalette(scheme, dark, pureBlack)`, person colors.
- `appearance.ts`: every option a user can change, their prefs (`normalizeAppearance`), bubble corners, surface styles.
- `wallpapers.ts`: chat wallpapers as SVG documents, drawn the same on the phone and the web.
- `index.ts`: CSS variables and Tailwind mappings, spacing, type and motion scales, quick reactions.

`pnpm --filter @pingdost/ui-tokens test` checks every scheme, in light, dark and pure black, against WCAG contrast. A new scheme that fails cannot ship.
