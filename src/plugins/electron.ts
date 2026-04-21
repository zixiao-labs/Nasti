// Electron 内置插件
//
// 负责：将 Electron 模块（electron、electron/*）与 Node 内建模块（fs、path、...）
// 标记为 external，避免被打包进主进程/Preload 产物。
//
// 仅在 config.target === 'electron' 时启用
import { builtinModules } from 'node:module'
import type { NastiPlugin, ResolvedConfig } from '../types.js'

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
])

const ELECTRON_MODULES = new Set([
  'electron',
  'electron/main',
  'electron/common',
  'electron/renderer',
])

/**
 * Create a Vite/Rollup plugin that externalizes Electron and Node built-in imports according to the resolved config.
 *
 * @param config - Resolved build config; any entries in `config.electron.external` are added to the externalized modules set.
 * @returns A plugin that marks `electron` and `electron/*` imports and Node built-in modules (including `node:`-prefixed names) as external.
 */
export function electronPlugin(config: ResolvedConfig): NastiPlugin {
  const external = new Set([
    ...ELECTRON_MODULES,
    ...NODE_BUILTINS,
    ...(config.electron.external ?? []),
  ])

  return {
    name: 'nasti:electron',
    enforce: 'pre',

    resolveId(source) {
      // 显式外部化 electron 与 Node 内建模块
      if (external.has(source)) {
        return { id: source, external: true }
      }
      // 形如 `electron/xxx` 的子路径一律标记外部
      if (source.startsWith('electron/')) {
        return { id: source, external: true }
      }
      return null
    },
  }
}
