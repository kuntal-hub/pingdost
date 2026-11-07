import { describe, expect, it } from 'vitest';

import { formatSize } from './limits';

describe('formatSize', () => {
  it('uses the largest unit that reads well', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(92 * 1_024)).toBe('92 KB');
    expect(formatSize(100 * 1_048_576)).toBe('100.0 MB');
    expect(formatSize(63.9 * 1_073_741_824)).toBe('63.9 GB');
  });
});
