import { defineConfig } from 'tsup'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
    'client/hmr': 'client/hmr.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node18',
  splitting: false,
  external: ['@vue/compiler-sfc'],
  define: {
    __NASTI_VERSION__: JSON.stringify(pkg.version),
  },
})
