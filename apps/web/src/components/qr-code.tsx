import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

/**
 * A QR code as an SVG built from React elements (no innerHTML): dark modules on white with a
 * 4-module quiet zone, as scanners expect, in both color schemes.
 */
export function QrCode({ value, size, label }: { value: string; size: number; label: string }) {
  const { count, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const modules = qr.getModuleCount();
    let d = '';
    for (let row = 0; row < modules; row++) {
      let start = -1;
      for (let col = 0; col <= modules; col++) {
        const dark = col < modules && qr.isDark(row, col);
        if (dark && start < 0) start = col;
        if (!dark && start >= 0) {
          d += `M${start} ${row}h${col - start}v1h${start - col}z`;
          start = -1;
        }
      }
    }
    return { count: modules, path: d };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`-4 -4 ${count + 8} ${count + 8}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
    >
      <rect x={-4} y={-4} width={count + 8} height={count + 8} fill="#FFFFFF" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
