// Nasti - 核心类型定义
// 兼容 Vite Plugin 接口

export interface NastiConfig {
  /** 项目根目录 */
  root?: string
  /** 公共基础路径 */
  base?: string
  /** 运行模式 */
  mode?: 'development' | 'production'
  /** 打包目标平台：web（默认）或 electron */
  target?: 'web' | 'electron'
  /** 框架自动检测或手动指定 */
  framework?: 'react' | 'vue' | 'auto'
  /** 路径解析配置 */
  resolve?: ResolveConfig
  /** 插件列表 */
  plugins?: NastiPlugin[]
  /** 开发服务器配置 */
  server?: ServerConfig
  /** 构建配置 */
  build?: BuildConfig
  /** Electron 配置（当 target === 'electron' 时生效） */
  electron?: ElectronConfig
  /** 环境变量前缀 */
  envPrefix?: string | string[]
  /** 日志级别 */
  logLevel?: 'info' | 'warn' | 'error' | 'silent'
}

/** Electron 目标专用配置，支持 Electron 41+ */
export interface ElectronConfig {
  /** 主进程入口文件，相对项目根目录 */
  main?: string
  /** Preload 脚本入口，相对项目根目录。可传入多个 */
  preload?: string | string[]
  /** 渲染进程（Web）入口 HTML，默认沿用根目录 index.html */
  renderer?: string
  /**
   * 主进程与 preload 打包目标 Node 版本。
   * Electron 41 捆绑 Node 22.x，默认为 'node22'
   */
  nodeTarget?: string
  /**
   * 主进程输出格式：cjs（默认，兼容 Electron 加载器）或 esm
   * （Electron 41+ 完整支持 ESM 主进程）
   */
  mainFormat?: 'cjs' | 'esm'
  /** Preload 输出格式，默认 cjs（Electron contextIsolation 推荐） */
  preloadFormat?: 'cjs' | 'esm'
  /** Electron 可执行文件路径，默认从 node_modules/electron 查找 */
  electronPath?: string
  /** 传递给 Electron 的命令行参数（dev 模式） */
  electronArgs?: string[]
  /** 开发时主/preload 文件变化后自动重启 Electron，默认 true */
  autoRestart?: boolean
  /** 声明最低 Electron 版本，默认 41（低于此版本将警告） */
  minVersion?: number
  /** 主进程/preload 的外部依赖（不参与打包，运行时 require） */
  external?: string[]
}

export interface ResolveConfig {
  alias?: Record<string, string>
  extensions?: string[]
  conditions?: string[]
  mainFields?: string[]
}

export interface ServerConfig {
  port?: number
  host?: string | boolean
  https?: boolean
  open?: boolean | string
  proxy?: Record<string, string | ProxyConfig>
  cors?: boolean
  hmr?: boolean | HmrConfig
}

export interface HmrConfig {
  port?: number
  host?: string
  protocol?: 'ws' | 'wss'
  overlay?: boolean
}

export interface ProxyConfig {
  target: string
  changeOrigin?: boolean
  rewrite?: (path: string) => string
}

export interface BuildConfig {
  outDir?: string
  assetsDir?: string
  minify?: boolean | 'oxc'
  sourcemap?: boolean | 'inline' | 'hidden'
  target?: string | string[]
  rolldownOptions?: Record<string, unknown>
  emptyOutDir?: boolean
}

// Vite 兼容的插件接口
export interface NastiPlugin {
  name: string
  enforce?: 'pre' | 'post'
  apply?: 'build' | 'serve' | ((config: ResolvedConfig, env: { mode: string; command: string }) => boolean)

  // 通用钩子
  buildStart?: (this: PluginContext) => void | Promise<void>
  buildEnd?: (this: PluginContext, error?: Error) => void | Promise<void>
  /**
   * Called once after `bundle.close()` in production builds, mirroring Rollup/Vite semantics.
   * Plugins use this to emit final-stage artifacts that depend on the bundle being fully written
   * (PWA manifests, service workers, sitemaps, etc.). Not invoked in dev.
   */
  closeBundle?: (this: PluginContext, error?: Error) => void | Promise<void>
  resolveId?: (this: PluginContext, source: string, importer: string | undefined, options: ResolveIdOptions) => ResolveIdResult | Promise<ResolveIdResult>
  load?: (this: PluginContext, id: string) => LoadResult | Promise<LoadResult>
  transform?: (this: PluginContext, code: string, id: string) => TransformResult | Promise<TransformResult>

  // Vite 特有钩子
  config?: (config: NastiConfig, env: { mode: string; command: string }) => NastiConfig | null | void | Promise<NastiConfig | null | void>
  configResolved?: (config: ResolvedConfig) => void | Promise<void>
  configureServer?: (server: DevServer) => void | (() => void) | Promise<void | (() => void)>
  transformIndexHtml?: (html: string) => string | HtmlTagDescriptor[] | { html: string; tags: HtmlTagDescriptor[] } | Promise<string | HtmlTagDescriptor[] | { html: string; tags: HtmlTagDescriptor[] }>
  handleHotUpdate?: (ctx: HmrContext) => void | ModuleNode[] | Promise<void | ModuleNode[]>
}

export interface PluginContext {
  resolve: (source: string, importer?: string) => Promise<ResolveIdResult>
  emitFile: (file: EmittedFile) => string
  getModuleInfo: (id: string) => ModuleInfo | null
}

export interface ResolveIdOptions {
  isEntry?: boolean
  ssr?: boolean
}

export type ResolveIdResult = string | null | undefined | { id: string; external?: boolean }
export type LoadResult = string | null | undefined | { code: string; map?: unknown }
export type TransformResult = string | null | undefined | { code: string; map?: unknown }

export interface EmittedFile {
  type: 'asset' | 'chunk'
  name?: string
  fileName?: string
  source?: string | Uint8Array
}

export interface ModuleInfo {
  id: string
  importers: string[]
  importedIds: string[]
}

export interface HtmlTagDescriptor {
  tag: string
  attrs?: Record<string, string | boolean>
  children?: string | HtmlTagDescriptor[]
  injectTo?: 'head' | 'body' | 'head-prepend' | 'body-prepend'
}

// 模块图节点
export interface ModuleNode {
  id: string
  file: string | null
  url: string
  type: 'js' | 'css'
  importers: Set<ModuleNode>
  importedModules: Set<ModuleNode>
  acceptedHmrDeps: Set<ModuleNode>
  transformResult: TransformResult | null
  lastHMRTimestamp: number
  isSelfAccepting: boolean
}

// 解析后的完整配置
export interface ResolvedConfig {
  root: string
  base: string
  mode: 'development' | 'production'
  target: 'web' | 'electron'
  framework: 'react' | 'vue' | 'auto'
  command: 'build' | 'serve'
  resolve: Required<ResolveConfig>
  plugins: NastiPlugin[]
  server: Required<ServerConfig>
  build: Required<BuildConfig>
  electron: Required<ElectronConfig>
  envPrefix: string[]
  logLevel: 'info' | 'warn' | 'error' | 'silent'
}

// Dev Server 接口
export interface DevServer {
  config: ResolvedConfig
  middlewares: any // connect instance
  moduleGraph: ModuleGraph
  watcher: any // chokidar FSWatcher
  ws: WebSocketServer
  listen: (port?: number) => Promise<DevServer>
  close: () => Promise<void>
  transformRequest: (url: string) => Promise<TransformResult>
}

export interface ModuleGraph {
  getModuleByUrl: (url: string) => ModuleNode | undefined
  getModuleById: (id: string) => ModuleNode | undefined
  getModulesByFile: (file: string) => Set<ModuleNode> | undefined
  ensureEntryFromUrl: (url: string) => Promise<ModuleNode>
  invalidateModule: (mod: ModuleNode) => void
  invalidateAll: () => void
}

export interface WebSocketServer {
  send: (payload: HmrPayload) => void
  close: () => void
}

export interface HmrContext {
  file: string
  timestamp: number
  modules: ModuleNode[]
  read: () => string | Promise<string>
  server: DevServer
}

export type HmrPayload =
  | { type: 'connected' }
  | { type: 'update'; updates: HmrUpdate[] }
  | { type: 'full-reload'; path?: string }
  | { type: 'prune'; paths: string[] }
  | { type: 'error'; err: { message: string; stack?: string } }

export interface HmrUpdate {
  type: 'js-update' | 'css-update'
  path: string
  acceptedPath: string
  timestamp: number
}
