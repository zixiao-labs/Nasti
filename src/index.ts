// Nasti - 基于 Rolldown/Oxc 的高性能 Web 打包器
// 编程 API 入口

export { defineConfig, resolveConfig, detectFramework } from './config/index.js'
export { build } from './build/index.js'
export type { BuildResult } from './build/index.js'
export { buildElectron, createElectronRendererConfig } from './build/electron.js'
export { createServer } from './server/index.js'
export { startElectronDev, electronRendererDevPath } from './server/electron-dev.js'
export { electronPlugin } from './plugins/electron.js'
export { monacoEditorPlugin } from './plugins/monaco-editor.js'
export { rsc } from './plugins/rsc.js'
export type {
  RscPluginOptions,
  RscManifest,
  RscManifestReference,
} from './plugins/rsc.js'

// 2.0: Environment API + Logger
export { NastiEnvironment, resolveEnvironmentPlugins } from './core/environment.js'
export { createNoopHotChannel, createWsHotChannel } from './core/hot-channel.js'
export { createLogger, printServerUrls, LogLevels } from './core/logger.js'
export { createDebugger } from './core/debug.js'
export { loadEnv, buildEnvDefine, ssrDefineOverrides } from './core/env.js'

export type {
  NastiConfig,
  ReactOptions,
  ReactCompilerOptions,
  ReactFileFilter,
  ResolvedReactOptions,
  NastiPlugin,
  ResolvedConfig,
  ElectronConfig,
  BuildConfig,
  MinifyOption,
  NastiMinifyOptions,
  ResolvedMinifyOption,
  NastiRolldownOptions,
  DevServer,
  ModuleNode,
  HmrPayload,
  TransformResult,
  // 2.0: Environment API
  EnvironmentOptions,
  VueEnvironmentOptions,
  VueSfcTransformContext,
  VueSfcSourceTransform,
  ResolvedEnvironmentOptions,
  EnvironmentInstance,
  EnvironmentBuildOutput,
  EnvironmentBuildMetadata,
  EnvironmentBuildResult,
  EnvironmentChunkMetadata,
  EnvironmentAssetMetadata,
  EnvironmentCssMetadata,
  EnvironmentCssModule,
  EnvironmentCssChunk,
  AppBuildOutput,
  BuildAppContext,
  EnvironmentServeResult,
  EnvironmentDriver,
  EnvironmentDriverContext,
  EnvironmentDriverServeContext,
  HotChannel,
  HotChannelClient,
  HotChannelInvokeHandlers,
  EnvironmentHotUpdateResult,
  HmrUpdate,
  EnvironmentTransformedModule,
  AppHmrContext,
  PluginContext,
  PluginApi,
  PluginApiKey,
  RenderChunkContext,
} from './types.js'
export type { Logger, LogLevel, LogOptions } from './core/logger.js'
export type {
  MonacoEditorPluginOptions,
  MonacoEditorLanguageWorker,
  MonacoCustomWorker,
} from './plugins/monaco-editor.js'
