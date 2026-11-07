// Chat wallpapers as SVG documents, so the phone (`SvgXml`) and the web (a `data:` image, which
// the CSP allows) draw the same thing in the current scheme's colors. Quiet on purpose: they sit
// behind text.
import type { WallpaperId } from './appearance';
import type { Palette } from './schemes';

const SVG = 'xmlns="http://www.w3.org/2000/svg"';

function pattern(size: number | [number, number], content: string): string {
  const [w, h] = Array.isArray(size) ? size : [size, size];
  return (
    `<svg ${SVG} width="100%" height="100%"><defs><pattern id="p" width="${w}" height="${h}" ` +
    `patternUnits="userSpaceOnUse">${content}</pattern></defs>` +
    `<rect width="100%" height="100%" fill="url(#p)"/></svg>`
  );
}

function aurora(palette: Palette, dark: boolean): string {
  const strength = dark ? 0.32 : 0.42;
  const blob = (id: string, color: string, cx: number, cy: number, r: number) => ({
    def:
      `<radialGradient id="${id}"><stop offset="0" stop-color="${color}" stop-opacity="${strength}"/>` +
      `<stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`,
    shape: `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${id})"/>`,
  });
  const blobs = [
    blob('a', palette.primary, 60, 120, 300),
    blob('b', palette.secondary, 380, 420, 320),
    blob('c', palette['primary-end'], 80, 760, 320),
  ];
  return (
    `<svg ${SVG} width="100%" height="100%" viewBox="0 0 400 800" preserveAspectRatio="xMidYMid slice">` +
    `<defs>${blobs.map((b) => b.def).join('')}</defs>${blobs.map((b) => b.shape).join('')}</svg>`
  );
}

const STAR = 'M0-8C1-2 2-1 8 0 2 1 1 2 0 8-1 2-2 1-8 0-2-1-1-2 0-8Z';

/** The wallpaper as an SVG document, or null for a plain background. */
export function wallpaperSvg(id: WallpaperId, palette: Palette, dark: boolean): string | null {
  const ink = palette.foreground;
  const faint = dark ? 0.12 : 0.1;
  switch (id) {
    case 'none':
      return null;
    case 'aurora':
      return aurora(palette, dark);
    case 'dots':
      return pattern(
        22,
        `<circle cx="11" cy="11" r="1.6" fill="${ink}" fill-opacity="${faint + 0.04}"/>`,
      );
    case 'grid':
      return pattern(
        30,
        `<path d="M30 0H0V30" fill="none" stroke="${ink}" stroke-opacity="${faint}" stroke-width="1"/>`,
      );
    case 'waves':
      return pattern(
        [64, 28],
        `<path d="M0 14c8-10 24-10 32 0s24 10 32 0" fill="none" stroke="${ink}" ` +
          `stroke-opacity="${faint}" stroke-width="2" stroke-linecap="round"/>`,
      );
    case 'stars':
      return pattern(
        96,
        `<path transform="translate(24 28)" d="${STAR}" fill="${palette.accent}" fill-opacity="${faint + 0.06}"/>` +
          `<path transform="translate(72 70) scale(.6)" d="${STAR}" fill="${ink}" fill-opacity="${faint}"/>`,
      );
    case 'confetti': {
      const a = palette.primary;
      const b = palette.secondary;
      const o = dark ? 0.3 : 0.4;
      return pattern(
        120,
        `<rect x="14" y="20" width="12" height="5" rx="2.5" transform="rotate(32 20 22)" fill="${a}" fill-opacity="${o}"/>` +
          `<circle cx="74" cy="26" r="4" fill="${b}" fill-opacity="${o}"/>` +
          `<path d="M44 66l9 3-7 7z" fill="${b}" fill-opacity="${o}"/>` +
          `<rect x="92" y="76" width="12" height="5" rx="2.5" transform="rotate(-24 98 78)" fill="${ink}" fill-opacity="${faint + 0.04}"/>` +
          `<circle cx="18" cy="96" r="3" fill="${a}" fill-opacity="${o}"/>`,
      );
    }
  }
}
