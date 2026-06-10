import type { NastiConfig, ResolvedConfig, BuildConfig, ServerConfig, ResolveConfig, ElectronConfig } from '../types.js'

const defaultResolve: Required<ResolveConfig> = {
  alias: {},
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.vue'],
  conditions: ['import', 'module', 'browser', 'default'],
  mainFields: ['module', 'jsnext:main', 'jsnext', 'main'],
}

const defaultServer: Required<ServerConfig> = {
  port: 3000,
  host: 'localhost',
  https: false,
  open: false,
  proxy: {},
  cors: true,
  hmr: true,
}

const defaultBuild: Required<BuildConfig> = {
  outDir: 'dist',
  assetsDir: 'assets',
  minify: true,
  sourcemap: false,
  target: 'es2022',
  rolldownOptions: {},
  emptyOutDir: true,
  css: {},
  reportCompressedSize: true,
  chunkSizeWarningLimit: 500,
  cssCodeSplit: true,
  // 默认跟随 build.minify（resolveConfig 中按 minify 取值填充）
  cssMinify: true,
}

// Electron 41+ 捆绑 Node 22.x / Chromium 138，故主进程目标默认 node22
const defaultElectron: Required<ElectronConfig> = {
  main: 'src/electron/main.ts',
  preload: 'src/electron/preload.ts',
  renderer: 'index.html',
  nodeTarget: 'node22',
  mainFormat: 'cjs',
  preloadFormat: 'cjs',
  electronPath: '',
  electronArgs: [],
  autoRestart: true,
  minVersion: 41,
  external: ['electron'],
}

export const defaults: Required<Omit<NastiConfig, 'plugins' | 'customLogger'>> & { plugins: [] } = {
  root: '.',
  base: '/',
  mode: 'development',
  target: 'web',
  framework: 'auto',
  resolve: defaultResolve,
  server: defaultServer,
  build: defaultBuild,
  electron: defaultElectron,
  plugins: [],
  envPrefix: ['NASTI_', 'VITE_'],
  logLevel: 'info',
  clearScreen: true,
}
