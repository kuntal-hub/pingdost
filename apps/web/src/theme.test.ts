// The appearance store on the web. A view transition runs its callback later, so quick successive
// choices must not lose each other (found by hand in Phase 31).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolvePalette, toRgbChannels } from '@pingdost/ui-tokens';

function stubBrowser(options: { viewTransitions: boolean; saved?: string }) {
  const properties = new Map<string, string>();
  const dataset: Record<string, string> = {};
  const stored = new Map<string, string>(
    options.saved ? [['pingdost.appearance', options.saved]] : [],
  );
  const pending: (() => void)[] = [];
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
    addEventListener: () => undefined,
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    },
  });
  vi.stubGlobal('document', {
    documentElement: {
      dataset,
      style: { setProperty: (name: string, value: string) => properties.set(name, value) },
    },
    querySelector: () => null,
    ...(options.viewTransitions
      ? { startViewTransition: (callback: () => void) => void pending.push(callback) }
      : {}),
  });
  return { properties, dataset, stored, pending };
}

describe('useAppearance', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps every choice when they come faster than the transition callback', async () => {
    const browser = stubBrowser({ viewTransitions: true });
    const { useAppearance, installTheme } = await import('./theme');
    installTheme();

    // A scheme change waits for its transition; the next choices come before it runs.
    useAppearance.getState().update({ scheme: 'lagoon' });
    useAppearance.getState().update({ look: 'outline' });
    useAppearance.getState().update({ font: 'tech' });
    for (const run of browser.pending) run();

    expect(useAppearance.getState().prefs).toMatchObject({
      scheme: 'lagoon',
      look: 'outline',
      font: 'tech',
    });
    const saved = JSON.parse(browser.stored.get('pingdost.appearance') ?? '{}') as {
      scheme?: string;
      look?: string;
    };
    expect(saved).toMatchObject({ scheme: 'lagoon', look: 'outline', font: 'tech' });
    expect(browser.dataset.look).toBe('outline');
    expect(browser.properties.get('--pd-primary')).toBe(
      toRgbChannels(resolvePalette('lagoon', false).primary),
    );
  });

  it('applies at once where view transitions are not available', async () => {
    const browser = stubBrowser({ viewTransitions: false });
    const { useAppearance, installTheme } = await import('./theme');
    installTheme();

    useAppearance.getState().update({ scheme: 'mango' });

    expect(browser.properties.get('--pd-primary')).toBe(
      toRgbChannels(resolvePalette('mango', false).primary),
    );
  });

  it('restores what was saved, and ignores values it does not know', async () => {
    const browser = stubBrowser({
      viewTransitions: false,
      saved: JSON.stringify({ scheme: 'grape', mode: 'dark', look: 'from-the-future' }),
    });
    const { useAppearance, installTheme } = await import('./theme');
    installTheme();

    const { prefs, dark } = useAppearance.getState();
    expect(prefs.scheme).toBe('grape');
    expect(prefs.look).toBe('soft');
    expect(dark).toBe(true);
    expect(browser.dataset.theme).toBe('dark');
  });

  it('calms motion when the system asks for reduced motion', async () => {
    const browser = stubBrowser({ viewTransitions: true });
    vi.stubGlobal('window', {
      ...(globalThis.window as object),
      matchMedia: (query: string) => ({
        matches: query.includes('reduced-motion'),
        addEventListener: () => undefined,
      }),
    });
    const { installTheme } = await import('./theme');
    installTheme();

    expect(browser.dataset.motion).toBe('calm');
  });
});
