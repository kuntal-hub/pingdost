/**
 * Release builds must not log (Phase 10 handoff, Phase 27 log audit, ARCHITECTURE A10): every
 * `console.*` call in the app's JavaScript sits behind `__DEV__`, on its line or in the three
 * lines above it (`if (__DEV__) console.warn(…)`, `...(__DEV__ ? { log: … } : {})`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

function sources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'generated') found.push(...sources(path));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

function unguardedConsoleCalls(files: string[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!/\bconsole\.(log|info|warn|error|debug|trace)\(/.test(line)) return;
      const window = lines.slice(Math.max(0, index - 3), index + 1).join('\n');
      if (!window.includes('__DEV__')) {
        problems.push(`${relative(root, file)}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  return problems;
}

describe('log hygiene', () => {
  it('guards every console call in the app and its local modules with __DEV__', () => {
    const modules = readdirSync(join(root, 'modules'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, 'modules', entry.name, 'src'));
    const files = [join(root, 'src'), ...modules].flatMap((dir) => {
      try {
        return sources(dir);
      } catch {
        return [];
      }
    });
    expect(files.length).toBeGreaterThan(50);
    expect(unguardedConsoleCalls(files)).toEqual([]);
  });
});
