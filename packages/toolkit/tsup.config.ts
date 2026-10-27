import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
) as { version: string };

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  target: 'node18',
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  minify: false,
  shims: false,
  define: {
    __PKG_VERSION__: JSON.stringify(version),
  },
});
