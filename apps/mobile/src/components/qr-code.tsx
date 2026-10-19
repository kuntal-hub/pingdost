import qrcode from 'qrcode-generator';
import { useMemo } from 'react';
import { View } from 'react-native';

interface QrCodeProps {
  value: string;
  /** Width and height in dp, quiet zone included. */
  size: number;
  accessibilityLabel: string;
}

/**
 * A QR code drawn with plain Views (no native SVG dependency): each row is a run of dark
 * modules. Always dark on white with a 4-module quiet zone, as scanners expect.
 */
export function QrCode({ value, size, accessibilityLabel }: QrCodeProps) {
  const rows = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    const runs: { row: number; start: number; length: number }[] = [];
    for (let row = 0; row < count; row++) {
      let start = -1;
      for (let col = 0; col <= count; col++) {
        const dark = col < count && qr.isDark(row, col);
        if (dark && start < 0) start = col;
        if (!dark && start >= 0) {
          runs.push({ row, start, length: col - start });
          start = -1;
        }
      }
    }
    return { count, runs };
  }, [value]);

  const modules = rows.count + 8;
  const cell = size / modules;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      style={{ width: size, height: size, backgroundColor: '#FFFFFF', borderRadius: 8 }}
    >
      {rows.runs.map((run) => (
        <View
          key={`${run.row}:${run.start}`}
          style={{
            position: 'absolute',
            backgroundColor: '#000000',
            left: (run.start + 4) * cell,
            top: (run.row + 4) * cell,
            width: run.length * cell + 0.5,
            height: cell + 0.5,
          }}
        />
      ))}
    </View>
  );
}
