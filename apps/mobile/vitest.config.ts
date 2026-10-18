import { defineProject } from 'vitest/config';

// Unit tests for platform-independent modules only (no React Native runtime here).
export default defineProject({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
