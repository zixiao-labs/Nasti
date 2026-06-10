// Nasti - 核心类型定义
// 兼容 Vite Plugin 接口

import type { InputOptions, OutputOptions, RenderedChunk } from 'rolldown'
import type { Logger } from './core/logger.js'

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
  /** 启动/重启时是否允许清屏（CI/非 TTY 下自动禁用），默认 true */
  clearScreen?: boolean
  /** 自定义 Logger（替换内置实现，logLevel 等选项由自定义实现自行处理） */
  customLogger?: Logger
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
  /**
   * 透传给 Rolldown 的底层选项，供生产应用手动控制代码拆分与 Tree-shaking。
   *
   * - input 侧（`treeshake`、`resolve`、`external`、`platform` 等）会合并进 `rolldown()`；
   * - `output` 会合并进 `bundle.write()`，用于控制代码拆分
   *   （`output.advancedChunks` / `output.codeSplitting`）、chunk 命名等。
   *
   * 注：`input` 与 `plugins` 由 Nasti 管理，故不在此暴露；`output.dir` 始终由
   * `build.outDir` 决定（HTML 改写依赖产物路径），传入会被忽略。
   */
  rolldownOptions?: NastiRolldownOptions
  emptyOutDir?: boolean
  css?: CssConfig
  /** 体积表是否计算 gzip 压缩后大小（大产物可关闭以加速构建），默认 true */
  reportCompressedSize?: boolean
  /** 触发大 chunk 警告的体积阈值（单位 kB，按压缩前 chunk 体积），默认 500 */
  chunkSizeWarningLimit?: number
  /** 按 chunk 抽取 CSS 为独立 .css 文件（关闭则全部合并为单个 CSS 文件），默认 true */
  cssCodeSplit?: boolean
  /** 是否压缩抽取出的 CSS（Lightning CSS，不可用时回退正则压缩），默认同 minify */
  cssMinify?: boolean
}

/**
 * Nasti 暴露的 Rolldown 选项：在 Rolldown {@link InputOptions} 基础上去掉由 Nasti
 * 接管的 `input` / `plugins`，并补充一个 `output` 出口用于 `bundle.write()`。
 */
export type NastiRolldownOptions = Omit<InputOptions, 'input' | 'plugins'> & {
  /** 传给 `bundle.write()` 的输出选项：代码拆分（`advancedChunks` / `codeSplitting`）、chunk 命名等 */
  output?: OutputOptions
}

export interface CssConfig {
  /** CSP nonce to add to inline <style> tags (dev only since 2.0 — build emits real .css files) */
  nonce?: string
  /**
   * @deprecated 2.0 起 build 始终抽取真实 .css 文件（per-chunk hash + <link> 注入），
   * 该开关不再生效。控制拆分用 `build.cssCodeSplit`，控制压缩用 `build.cssMinify`。
   */
  emitCssFile?: boolean
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
  /**
   * Rolldown output 阶段钩子：对每个 chunk 的最终代码做变换或按 chunk 收集产物。
   * 仅在生产构建生效（dev unbundled 管线没有 chunk 概念）。
   *
   * `this` 是 Rolldown 真实的（Rollup 兼容）插件上下文，不是 PluginContext stub：
   * `this.emitFile({type:'asset'})` 经 `output.assetFileNames` 产出带 hash 的文件，
   * `this.getFileName(ref)` 可立即解析最终文件名。CSS per-chunk 抽取依赖这两点。
   */
  renderChunk?: (
    this: RenderChunkContext,
    code: string,
    chunk: RenderedChunk,
  ) => string | { code: string; map?: unknown } | null | undefined | Promise<string | { code: string; map?: unknown } | null | undefined>
  /** 向 chunk hash 折叠额外输入（如该 chunk 关联的 CSS 内容），保证缓存正确性 */
  augmentChunkHash?: (
    this: RenderChunkContext,
    chunk: RenderedChunk,
  ) => string | void | Promise<string | void>
  /**
   * Rolldown output 收尾钩子（write 前最后时机）。`this` 同 renderChunk，
   * 可 emitFile 补充产物（如 cssCodeSplit:false 的合并 CSS、manifest 等）。
   */
  generateBundle?: (
    this: RenderChunkContext,
    options?: unknown,
    bundle?: Record<string, unknown>,
  ) => void | Promise<void>

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

/**
 * renderChunk / augmentChunkHash 的 `this`：Rolldown 真实插件上下文的最小可用面。
 * 与 {@link PluginContext}（dev/buildStart 用的 stub）不同，这里的 emitFile 返回
 * referenceId，getFileName 能解析出带 hash 的最终文件名。
 */
export interface RenderChunkContext {
  emitFile: (file: EmittedFile) => string
  getFileName: (referenceId: string) => string
}

export interface ResolveIdOptions {
  isEntry?: boolean
  ssr?: boolean
}

export type ResolveIdResult = string | null | undefined | { id: string; external?: boolean }
export type LoadResult = string | null | undefined | { code: string; map?: unknown }
export type TransformResult =
  | string
  | null
  | undefined
  | {
      code: string
      map?: unknown
      moduleType?: string
      /** 透传 Rolldown：'no-treeshake' 可保证模块不被摇出 chunk.moduleIds */
      moduleSideEffects?: boolean | 'no-treeshake'
    }

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
  clearScreen: boolean
  /** 已接线 logLevel 的 Logger 实例，所有 Nasti 输出统一经此通道 */
  logger: Logger
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
