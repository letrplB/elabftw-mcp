import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node22',
  dts: false,
  clean: true,
  splitting: false,
  sourcemap: true,
  minify: false,
  shims: false,
});
