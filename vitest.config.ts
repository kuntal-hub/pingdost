import { defineConfig } from 'vitest/config';

// Runs every package's unit-test project in one process (IDE / `pnpm test:watch`).
// CI and `pnpm test` run the same configs per package through Turborepo.
export default defineConfig({
  test: {
    projects: ['{apps,packages,tools}/*/vitest.config.ts'],
  },
});
