import { defineConfig } from 'tsup';

// Bundles the two entrypoints. Workspace packages ship TypeScript source, so they are
// bundled in; npm dependencies (including the native argon2 binding) stay external.
export default defineConfig({
  entry: ['src/main.ts', 'src/worker.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/^@pingdost\//],
});
