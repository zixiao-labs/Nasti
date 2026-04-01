import type { NastiConfig, ResolvedConfig, BuildConfig, ServerConfig, ResolveConfig } from '../types.js'

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
}

export const defaults: Required<Omit<NastiConfig, 'plugins'>> & { plugins: [] } = {
  root: '.',
  base: '/',
  mode: 'development',
  framework: 'auto',
  resolve: defaultResolve,
  server: defaultServer,
  build: defaultBuild,
  plugins: [],
  envPrefix: ['NASTI_', 'VITE_'],
  logLevel: 'info',
}
