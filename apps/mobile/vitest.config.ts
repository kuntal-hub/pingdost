import { fileURLToPath } from 'node:url';

import { defineProject } from 'vitest/config';

// Unit tests for platform-independent modules only (no React Native runtime here).
export default defineProject({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
