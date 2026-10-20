import { fileURLToPath } from 'node:url';

import { defineProject } from 'vitest/config';

// Unit tests run in Node: Web Crypto is built in, and fake-indexeddb stands in for IndexedDB.
export default defineProject({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.test.ts'],
    setupFiles: ['fake-indexeddb/auto'],
  },
});
