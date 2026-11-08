import { describe, expect, it } from 'vitest';

import { displayMediaOptions } from './platform';

describe('screen sharing picker options (ADR 0037)', () => {
  it('never offers this tab, and keeps whole screens out when the user chose one app', () => {
    const app = displayMediaOptions('app');
    expect(app).toMatchObject({
      audio: false,
      selfBrowserSurface: 'exclude',
      monitorTypeSurfaces: 'exclude',
      video: { displaySurface: 'window' },
    });
    const screen = displayMediaOptions('screen');
    expect(screen).toMatchObject({
      selfBrowserSurface: 'exclude',
      monitorTypeSurfaces: 'include',
      video: { displaySurface: 'monitor' },
    });
  });
});
