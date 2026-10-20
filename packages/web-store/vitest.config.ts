import { defineProject } from 'vitest/config';

// Node's Web Crypto plus fake-indexeddb stand in for the browser.
export default defineProject({
  test: {
    include: ['src/**/*.test.ts'],
    setupFiles: ['fake-indexeddb/auto'],
  },
});
