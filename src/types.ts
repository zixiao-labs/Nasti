// Nasti - 核心类型定义
// 兼容 Vite Plugin 接口

export interface NastiConfig {
  /** 项目根目录 */
  root?: string
  /** 公共基础路径 */
  base?: string
  /** 运行模式 */
  mode?: 'development' | 'production'
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
  /** 环境变量前缀 */
  envPrefix?: string | string[]
  /** 日志级别 */
  logLevel?: 'info' | 'warn' | 'error' | 'silent'
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
  framework: 'react' | 'vue' | 'auto'
  command: 'build' | 'serve'
  resolve: Required<ResolveConfig>
  plugins: NastiPlugin[]
  server: Required<ServerConfig>
  build: Required<BuildConfig>
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
