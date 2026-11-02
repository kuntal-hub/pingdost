/**
 * Production builds must not log (Phase 27 log audit, ARCHITECTURE A10): every `console.*`
 * call in the web app, its service worker included, sits behind `import.meta.env.DEV`, on its
 * line or in the three lines above it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const src = fileURLToPath(new URL('.', import.meta.url));

function sources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sources(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

describe('log hygiene', () => {
  it('guards every console call with import.meta.env.DEV', () => {
    const files = sources(src);
    expect(files.length).toBeGreaterThan(30);
    const problems: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!/\bconsole\.(log|info|warn|error|debug|trace)\(/.test(line)) return;
        const window = lines.slice(Math.max(0, index - 3), index + 1).join('\n');
        if (!window.includes('import.meta.env.DEV')) {
          problems.push(`${relative(src, file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(problems).toEqual([]);
  });
});
