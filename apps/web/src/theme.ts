// Light and dark colors from @pingdost/ui-tokens, applied as CSS variables through the CSSOM
// (allowed by the strict CSP, unlike an inline <style>), following the system setting.
import { colorNames, palettes, toRgbChannels, type ColorScheme } from '@pingdost/ui-tokens';

export function themeVariables(scheme: ColorScheme): Record<string, string> {
  return Object.fromEntries(
    colorNames.map((name) => [`--pd-${name}`, toRgbChannels(palettes[scheme][name])]),
  );
}

function apply(scheme: ColorScheme): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(themeVariables(scheme))) {
    root.style.setProperty(name, value);
  }
  root.dataset.theme = scheme;
}

/** Applies the system's scheme now and whenever it changes. */
export function installTheme(): void {
  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  apply(dark.matches ? 'dark' : 'light');
  dark.addEventListener('change', (event) => apply(event.matches ? 'dark' : 'light'));
}
