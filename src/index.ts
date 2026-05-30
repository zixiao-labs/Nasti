// Nasti - 基于 Rolldown/Oxc 的高性能 Web 打包器
// 编程 API 入口

export { defineConfig, resolveConfig } from './config/index.js'
export { build } from './build/index.js'
export { buildElectron } from './build/electron.js'
export { createServer } from './server/index.js'
export { startElectronDev } from './server/electron-dev.js'
export { electronPlugin } from './plugins/electron.js'
export { monacoEditorPlugin } from './plugins/monaco-editor.js'

export type {
  NastiConfig,
  NastiPlugin,
  ResolvedConfig,
  ElectronConfig,
  BuildConfig,
  NastiRolldownOptions,
  DevServer,
  ModuleNode,
  HmrPayload,
  TransformResult,
} from './types.js'
export type {
  MonacoEditorPluginOptions,
  MonacoEditorLanguageWorker,
  MonacoCustomWorker,
} from './plugins/monaco-editor.js'
