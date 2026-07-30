// Nasti - 核心类型定义
// 兼容 Vite Plugin 接口

import type { InputOptions, OutputOptions, RenderedChunk } from 'rolldown'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  SFCAsyncStyleCompileOptions,
  SFCParseOptions,
  SFCScriptCompileOptions,
  SFCTemplateCompileOptions,
} from '@vue/compiler-sfc'
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
  /**
   * 环境配置 map（Environment API，2.0）。默认注入 `{ client, ssr }`。
   *
   * `client` 环境与 top-level `resolve`/`build` **精确镜像**：对
   * `environments.client` 的覆盖会写回 top-level（反之亦然），保证读 flat
   * config 的既有插件与新 API 看到同一份配置。
   */
  environments?: Record<string, EnvironmentOptions>
  /** 实验特性（无稳定性保证，随时可能变更/移除） */
  experimental?: ExperimentalOptions
}

export interface ExperimentalOptions {
  /**
   * dev 用 Rolldown `dev()` 引擎整体打包 client 环境后从内存服务
   * （完整打包模式 / Full Bundle Mode）。HMR 由引擎的 patch 机制驱动，
   * 动态 import 走懒编译端点。依赖 rolldown 实验 API（无 semver 保护，
   * Nasti 会精确锁定经过验证的 Rolldown 版本）。unbundled 管线保持默认。
   * @experimental
   * @default false
   */
  bundledDev?: boolean
}

/** 单个环境的可配置面（Environment API） */
export interface EnvironmentOptions {
  /**
   * 产物消费者：决定 per-env 的 resolve 行为与 `import.meta.env.SSR` 取值。
   * 默认：环境名为 'client' → 'client'，其余 → 'server'。
   */
  consumer?: 'client' | 'server'
  /**
   * 该环境的构建入口（相对 root）。client 默认从 HTML 提取；显式配置后可覆盖。
   * 非 client 环境只有声明 entry 或 driver 才会被 `nasti build` 构建。
   */
  entry?: string | string[]
  /**
   * HTML 入口（相对 root），仅 client consumer 使用。默认 `index.html`。
   * Electron renderer 会把 `electron.renderer` 映射到这里。
   */
  html?: string
  /**
   * 是否参与生产构建。默认 true；设为 false 可跳过默认 client，构建纯多环境应用。
   * 仅影响 `nasti build`，不影响 dev server 中环境实例的可见性。
   */
  buildEnabled?: boolean
  /**
   * 外部环境编译驱动标识。声明后由插件的 `createEnvironmentDriver` 提供实际实现，
   * 可用于接入 Rspeedy 等不基于 Rolldown 的构建系统。
   */
  driver?: string
  /** per-env 路径解析（client 默认含 'browser' condition；server 走 node conditions） */
  resolve?: ResolveConfig
  /** per-env 构建覆盖（未设置的字段回退 top-level build） */
  build?: BuildConfig
  /**
   * Vue SFC 编译扩展点。每个环境可独立设置 compiler-sfc 选项与源码变换，
   * 同一个 SFC 的虚拟模块 id / scope id 不包含环境名，因而在多图之间保持稳定。
   */
  vue?: VueEnvironmentOptions
}

export interface VueSfcTransformContext {
  filename: string
  environmentName: string
  type: 'sfc' | 'template' | 'style'
  index?: number
}

export type VueSfcSourceTransform = (
  source: string,
  context: VueSfcTransformContext,
) =>
  | string
  /**
   * Object results may provide a source map from `code` back to `source`.
   * Nasti composes it with compiler-sfc maps where that stage supports chaining.
   */
  | { code: string; map?: unknown }
  | Promise<string | { code: string; map?: unknown }>

/** 直接透传给 `@vue/compiler-sfc` 对应阶段的 per-environment 选项。 */
export interface VueEnvironmentOptions {
  parse?: SFCParseOptions
  script?: Partial<SFCScriptCompileOptions>
  template?: Partial<SFCTemplateCompileOptions>
  style?: Partial<SFCAsyncStyleCompileOptions>
  transformSfc?: VueSfcSourceTransform
  transformTemplate?: VueSfcSourceTransform
  transformStyle?: VueSfcSourceTransform
}

/** 解析后的环境配置 */
export interface ResolvedEnvironmentOptions {
  consumer: 'client' | 'server'
  /** 是否参与生产构建 */
  buildEnabled: boolean
  /** 环境构建入口（绝对路径）；client 未显式配置时为空并从 HTML 提取 */
  entry: string[]
  /** HTML 入口绝对路径（仅 client consumer 有值） */
  html?: string
  /** 外部环境编译驱动标识 */
  driver?: string
  resolve: Required<ResolveConfig>
  build: Required<BuildConfig>
  vue: VueEnvironmentOptions
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
   * @deprecated 请改用 `css.emit` 控制是否写出 CSS 文件。控制拆分用
   * `build.cssCodeSplit`，控制压缩用 `build.cssMinify`。
   */
  emitCssFile?: boolean
  /**
   * 是否在浏览器运行时 / HTML 中注入 CSS。原生 client 环境可关闭注入，
   * 同时继续保留 CSS 模块图与结构化元数据。
   * @default true
   */
  inject?: boolean
  /**
   * 是否写出 `.css` 文件。关闭后仍收集每个 chunk 的 CSS 所有权。
   * @default true
   */
  emit?: boolean
}

// Vite 兼容的插件接口
export interface NastiPlugin {
  name: string
  enforce?: 'pre' | 'post'
  /** 必须在当前插件 setup 前完成 setup 的插件名 */
  pre?: string[]
  /** 必须在当前插件 setup 后完成 setup 的插件名 */
  post?: string[]
  apply?: 'build' | 'serve' | ((config: ResolvedConfig, env: { mode: string; command: string }) => boolean)

  // 通用钩子
  /** 插件初始化与跨插件 API 注册；每次 resolveConfig 只执行一次 */
  setup?: (api: PluginApi) => void | Promise<void>
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
  /**
   * Environment API：在环境配置最终解析前调整单个环境的选项。
   * 对每个环境名调用一次（含默认注入的 client/ssr）。
   */
  configEnvironment?: (
    name: string,
    options: EnvironmentOptions,
    env: { mode: string; command: string },
  ) => EnvironmentOptions | null | void | Promise<EnvironmentOptions | null | void>
  /**
   * Environment API：按环境过滤插件。返回 false 则该插件不进入此环境的
   * 插件管线。未声明时插件应用于所有环境（与 Vite 默认一致）。
   */
  applyToEnvironment?: (environment: EnvironmentInstance) => boolean
  /**
   * 为声明了 `environment.options.driver` 的环境提供外部编译驱动。
   * 一个环境只能被一个插件接管；返回多个驱动会报错。
   */
  createEnvironmentDriver?: (
    environment: EnvironmentInstance,
    api: PluginApi,
  ) =>
    | EnvironmentDriver
    | null
    | undefined
    | Promise<EnvironmentDriver | null | undefined>
  /**
   * 所有环境构建完成后的 app 级收尾钩子，用于跨环境聚合产物。
   * Vue Lynx 原生后端可在这里组合 background/main-thread bundle。
   */
  afterBuildApp?: (
    results: Record<string, EnvironmentBuildResult>,
    api: PluginApi,
    context: BuildAppContext,
  ) => void | Promise<void>
  configureServer?: (server: DevServer) => void | (() => void) | Promise<void | (() => void)>
  transformIndexHtml?: (html: string) => string | HtmlTagDescriptor[] | { html: string; tags: HtmlTagDescriptor[] } | Promise<string | HtmlTagDescriptor[] | { html: string; tags: HtmlTagDescriptor[] }>
  handleHotUpdate?: (ctx: HmrContext) => void | ModuleNode[] | Promise<void | ModuleNode[]>
  /**
   * 一个文件在所有 dev client 环境完成失效、插件 HMR 钩子与重新转换后调用一次。
   * 多运行时工具链可据此只重编码受影响的 native section。
   */
  handleHotUpdateApp?: (ctx: AppHmrContext) => void | Promise<void>
}

export interface PluginContext {
  resolve: (source: string, importer?: string) => Promise<ResolveIdResult>
  emitFile: (file: EmittedFile) => string
  getModuleInfo: (id: string) => ModuleInfo | null
  /**
   * Environment API：当前钩子运行所在的环境（dev 管线中可用；
   * 生产构建的 Rolldown 钩子注入在 Phase 2 接线）。
   */
  environment?: EnvironmentInstance
}

export type PluginApiKey = string | symbol

/** 插件 setup 与环境驱动共享的跨插件 API。 */
export interface PluginApi {
  readonly config: ResolvedConfig
  readonly logger: Logger
  expose: <T>(key: PluginApiKey, value: T) => void
  useExposed: <T>(key: PluginApiKey) => T | undefined
}

export interface EnvironmentBuildOutput {
  fileName: string
  type: string
  code?: string
  source?: Uint8Array | string
  map?: unknown
  name?: string
  names?: string[]
  isEntry?: boolean
  isDynamicEntry?: boolean
  imports?: string[]
  dynamicImports?: string[]
  moduleIds?: string[]
}

export interface EnvironmentCssModule {
  id: string
  source: string
  code: string
}

export interface EnvironmentCssChunk {
  fileName: string
  moduleIds: string[]
  cssFileNames: string[]
}

export interface EnvironmentCssMetadata {
  modules: Record<string, EnvironmentCssModule>
  chunks: Record<string, EnvironmentCssChunk>
}

export interface EnvironmentChunkMetadata {
  fileName: string
  name: string
  isEntry: boolean
  isDynamicEntry: boolean
  imports: string[]
  dynamicImports: string[]
  moduleIds: string[]
  css: string[]
  assets: string[]
}

export interface EnvironmentAssetMetadata {
  fileName: string
  names: string[]
  publicPath: string
}

/** 单个环境附加到标准构建结果上的结构化元数据。 */
export interface EnvironmentBuildMetadata {
  entries?: Record<string, string>
  publicPath?: string
  manifest?: unknown
  stats?: unknown
  chunks?: Record<string, EnvironmentChunkMetadata>
  assets?: Record<string, EnvironmentAssetMetadata>
  css?: EnvironmentCssMetadata
  sourceMaps?: Record<string, unknown>
}

/** 外部环境驱动或原生 Rolldown 环境返回的标准构建结果。 */
export interface EnvironmentBuildResult extends EnvironmentBuildMetadata {
  output: EnvironmentBuildOutput[]
}

/** app 级 finalizer 写出的聚合产物。 */
export interface AppBuildOutput extends EnvironmentBuildOutput {
  type: 'asset'
  source: Uint8Array | string
}

/**
 * 所有环境完成后提供给 `afterBuildApp` 的只读查询与产物写出接口。
 * Lynx 等多运行时工具链可用它聚合 background/main-thread 结果，而无需读取磁盘目录。
 */
export interface BuildAppContext {
  readonly config: ResolvedConfig
  readonly results: Readonly<Record<string, EnvironmentBuildResult>>
  readonly output: readonly AppBuildOutput[]
  getResult: (environmentName: string) => EnvironmentBuildResult | undefined
  getArtifact: (
    environmentName: string,
    fileName: string,
  ) => EnvironmentBuildOutput | undefined
  getEntry: (
    environmentName: string,
    entryName: string,
  ) => EnvironmentBuildOutput | undefined
  getManifest: <T = unknown>(environmentName: string) => T | undefined
  getChunk: (
    environmentName: string,
    fileName: string,
  ) => EnvironmentChunkMetadata | undefined
  getCss: (environmentName: string) => EnvironmentCssMetadata | undefined
  getSourceMap: (environmentName: string, fileName: string) => unknown
  resolvePublicPath: (environmentName: string, fileName: string) => string | undefined
  /** 将聚合产物安全地写入 top-level `build.outDir`，并纳入 BuildResult.appOutput。 */
  emitFile: (file: AppBuildOutput) => string
}

/** 外部环境驱动返回的开发服务信息。 */
export interface EnvironmentServeResult {
  localUrls?: string[]
  networkUrls?: string[]
  middleware?: (
    request: IncomingMessage,
    response: ServerResponse,
    next: (error?: unknown) => void,
  ) => void
}

export interface EnvironmentDriverContext {
  environment: EnvironmentInstance
  config: ResolvedConfig
  api: PluginApi
  logger: Logger
}

export interface EnvironmentDriverServeContext extends EnvironmentDriverContext {
  server: DevServer
}

export interface EnvironmentDriver {
  name: string
  build?: (
    context: EnvironmentDriverContext,
  ) => EnvironmentBuildResult | Promise<EnvironmentBuildResult>
  serve?: (
    context: EnvironmentDriverServeContext,
  ) => EnvironmentServeResult | void | Promise<EnvironmentServeResult | void>
  watchChange?: (
    file: string,
    event: 'add' | 'change' | 'unlink',
    context: EnvironmentDriverContext,
  ) => void | Promise<void>
  close?: (context: EnvironmentDriverContext) => void | Promise<void>
}

/**
 * 环境实例的公共面（核心实现见 core/environment.ts 的 NastiEnvironment）。
 * 插件经 `this.environment` / `applyToEnvironment(env)` 感知环境。
 */
export interface EnvironmentInstance {
  name: string
  consumer: 'client' | 'server'
  mode: 'dev' | 'build'
  config: ResolvedConfig
  options: ResolvedEnvironmentOptions
  hot: HotChannel
  /** 声明 driver 后，由插件提供的外部环境编译驱动 */
  driver?: EnvironmentDriver
  /** per-environment dev 模块图与插件列表。 */
  moduleGraph: ModuleGraph
  plugins: NastiPlugin[]
  /**
   * 在该环境的独立 transform 管线中请求模块。仅 dev 环境在初始化后可用。
   */
  transformRequest: (url: string) => Promise<{ code: string; map?: unknown } | null>
  /** 内置 CSS 管线登记模块；工具链通常读取 getCssModule(s)。 */
  setCssModule: (module: EnvironmentCssModule) => void
  getCssModule: (id: string) => EnvironmentCssModule | undefined
  getCssModules: () => Readonly<Record<string, EnvironmentCssModule>>
  setAssetModule: (id: string, fileName: string) => void
  getAssetModules: () => Readonly<Record<string, string>>
  /** 由生产插件登记 entries / manifest / stats，构建完成后合并进环境结果。 */
  setBuildMetadata: (metadata: EnvironmentBuildMetadata) => void
}

/**
 * renderChunk / augmentChunkHash 的 `this`：Rolldown 真实插件上下文的最小可用面。
 * 与 {@link PluginContext}（dev/buildStart 用的 stub）不同，这里的 emitFile 返回
 * referenceId，getFileName 能解析出带 hash 的最终文件名。
 */
export interface RenderChunkContext {
  emitFile: (file: EmittedFile) => string
  getFileName: (referenceId: string) => string
  /** 当前生产钩子所属环境；BG/MT 同为 client consumer 时也可准确区分。 */
  environment: EnvironmentInstance
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
  /** 每次失效递增，防止较慢的旧转换覆盖较新的缓存。 */
  invalidationVersion: number
  isSelfAccepting: boolean
  /** Environment API：节点所属环境名（per-env 模块图，默认 'client'） */
  environment?: string
}

// 解析后的完整配置
export interface ResolvedConfig {
  root: string
  base: string
  mode: 'development' | 'production'
  target: 'web' | 'electron'
  /** `auto` 在配置解析阶段已收敛为具体框架 */
  framework: 'react' | 'vue'
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
  /**
   * 解析后的环境 map（默认 client + ssr）。`environments.client` 的
   * resolve/build 与 top-level **同引用**（精确镜像，运行时有断言校验）。
   */
  environments: Record<string, ResolvedEnvironmentOptions>
  experimental: Required<ExperimentalOptions>
}

// Dev Server 接口
export interface DevServer {
  config: ResolvedConfig
  middlewares: any // connect instance
  /**
   * client 环境模块图的别名（back-compat）。
   * @deprecated 跟随 Vite 退役 flat `server.*` 的方向，2.x 移除；
   * 新代码请用 `server.environments.client.moduleGraph`。
   */
  moduleGraph: ModuleGraph
  watcher: any // chokidar FSWatcher
  ws: WebSocketServer
  /** Environment API：每个 client-consumer 环境都有独立的 transform/HMR 管线。 */
  environments: Record<string, EnvironmentInstance>
  /** 外部环境驱动启动后返回的服务 URL / middleware 信息 */
  environmentServices: Record<string, EnvironmentServeResult>
  listen: (port?: number) => Promise<DevServer>
  close: () => Promise<void>
  transformRequest: (url: string) => Promise<TransformResult>
  transformEnvironmentRequest: (
    environmentName: string,
    url: string,
  ) => Promise<TransformResult>
  /**
   * SSR：在 server consumer 环境（默认 `ssr`）中加载并执行模块，返回其导出。
   * Vite `server.ssrLoadModule` 的 back-compat shim（底层是 module runner +
   * HotChannel invoke 桥）。模块经 moduleRunnerTransform 转换后在进程内求值，
   * `import.meta.env.SSR === true`，bare import 外部化交给 node 解析。
   */
  ssrLoadModule: (url: string) => Promise<Record<string, unknown>>
}

export interface ModuleGraph {
  getModuleByUrl: (url: string) => ModuleNode | undefined
  getModuleById: (id: string) => ModuleNode | undefined
  getModulesByFile: (file: string) => Set<ModuleNode> | undefined
  ensureEntryFromUrl: (url: string) => Promise<ModuleNode>
  invalidateModule: (mod: ModuleNode, timestamp?: number) => void
  invalidateModuleAndImporters: (mod: ModuleNode, timestamp?: number) => void
  getHmrBoundaries: (
    mod: ModuleNode,
  ) => Array<{ boundary: ModuleNode; acceptedVia: ModuleNode }>
  invalidateAll: () => void
}

export interface WebSocketServer {
  send: (payload: HmrPayload) => void
  close: () => void
}

// ─── HotChannel（Environment API 的 per-env 热更通道）─────────────────────
//
// 接口一次性定全（含 invoke 契约：fetchModule / getBuiltins / _skipFsCheck，
// 供 Phase 2 的 SSR module runner 与未来 edge transport 使用，避免重构）。
// Phase 1 的实现面：client = ws 包装；非 client = noop。

export type HotChannelListener = (data: unknown, client: HotChannelClient) => void

export interface HotChannelClient {
  send: (payload: HmrPayload) => void
}

/** module runner 经 invoke 调用的 RPC 方法集（Vite DevEnvironment.hot.setInvokeHandler 同构） */
export interface HotChannelInvokeHandlers {
  /** runner 回调 fetchModule → transformRequest → 求值 */
  fetchModule: (id: string, importer?: string, options?: { cached?: boolean }) => Promise<unknown>
  /** server 环境的内建模块清单（string/RegExp，序列化需对齐 runner 期望） */
  getBuiltins?: () => Promise<Array<string | RegExp>> | Array<string | RegExp>
  /** 网络暴露的 transport 跳过文件系统存在性检查（安全相关，显式带上） */
  _skipFsCheck?: boolean
}

export interface HotChannel {
  /** 向该环境的所有客户端广播 */
  send: (payload: HmrPayload) => void
  /** 监听客户端自定义事件（custom events / invoke transport） */
  on?: (event: string, listener: HotChannelListener) => void
  off?: (event: string, listener: HotChannelListener) => void
  listen?: () => void
  close?: () => void | Promise<void>
  /** 注册 invoke 处理器（SSR runner 的 RPC 桥；Phase 1 仅定义契约） */
  setInvokeHandler?: (handlers: HotChannelInvokeHandlers | undefined) => void
}

export interface HmrContext {
  file: string
  timestamp: number
  modules: ModuleNode[]
  read: () => string | Promise<string>
  server: DevServer
  environment: EnvironmentInstance
}

export interface EnvironmentTransformedModule {
  module: ModuleNode
  result: { code: string; map?: unknown } | null
}

export interface EnvironmentHotUpdateResult {
  environment: EnvironmentInstance
  modules: ModuleNode[]
  updates: HmrUpdate[]
  transformed: EnvironmentTransformedModule[]
  fullReload: boolean
}

export interface AppHmrContext {
  file: string
  timestamp: number
  environments: Readonly<Record<string, EnvironmentHotUpdateResult>>
  server: DevServer
}

export type HmrPayload = (
  | { type: 'connected' }
  | { type: 'update'; updates: HmrUpdate[] }
  | { type: 'full-reload'; path?: string }
  | { type: 'prune'; paths: string[] }
  | { type: 'error'; err: { message: string; stack?: string } }
  | { type: 'custom'; event: string; data?: unknown }
) & { environment?: string }

export interface HmrUpdate {
  type: 'js-update' | 'css-update'
  path: string
  acceptedPath: string
  timestamp: number
}
