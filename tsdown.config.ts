import { defineConfig } from 'tsdown'

import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
    'client/hmr': 'client/hmr.ts',
  },
  format: ['esm', 'cjs'],
  platform: 'node',
  target: 'node20',
  dts: true,
  clean: true,
  sourcemap: true,
  // 保持与 tsup 时代完全一致的产物扩展名 —— package.json 的 exports
  // 指向 dist/index.js（ESM）/ dist/index.cjs（CJS），bin/nasti.js 也
  // import '../dist/cli.js'。tsdown 默认给 ESM 发 .mjs / .d.mts，会脱靶。
  outExtensions: ({ format }) =>
    format === 'es' ? { js: '.js', dts: '.d.ts' } : { js: '.cjs', dts: '.d.cts' },
  deps: {
    // import-meta-resolve 必须内联：Nasti 用它做 ESM 条件解析，
    // 不能要求下游项目自行安装。
    alwaysBundle: ['import-meta-resolve'],
    // 可选依赖 / 可选 peer —— 运行时按需 dynamic import，绝不打进产物。
    neverBundle: ['@vue/compiler-sfc', 'oxc-transform-react'],
  },
  define: {
    __NASTI_VERSION__: JSON.stringify(pkg.version),
  },
})
