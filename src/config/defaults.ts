import type {
  NastiConfig,
  BuildConfig,
  ServerConfig,
  ResolveConfig,
  ElectronConfig,
  ExperimentalOptions,
  ResolvedReactOptions,
} from '../types.js'

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
  css: {
    inject: true,
    emit: true,
  },
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

const defaultExperimental: Required<ExperimentalOptions> = {
  bundledDev: false,
}

export const defaultReact: ResolvedReactOptions = {
  include: /\.[tj]sx?$/,
  exclude: /node_modules/,
  jsxImportSource: 'react',
  jsxRuntime: 'automatic',
  compiler: false,
}

export const defaults: Required<Omit<NastiConfig, 'plugins' | 'customLogger' | 'environments' | 'experimental'>> & {
  plugins: []
  experimental: Required<ExperimentalOptions>
} = {
  root: '.',
  base: '/',
  mode: 'development',
  target: 'web',
  framework: 'auto',
  react: defaultReact,
  resolve: defaultResolve,
  server: defaultServer,
  build: defaultBuild,
  electron: defaultElectron,
  plugins: [],
  envPrefix: ['NASTI_', 'VITE_'],
  logLevel: 'info',
  clearScreen: true,
  experimental: defaultExperimental,
}
