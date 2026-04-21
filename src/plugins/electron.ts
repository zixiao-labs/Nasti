// Electron 内置插件
//
// 负责：
//   - 将 Electron 内置模块（electron、fs、path、...）标记为 external
//   - 在主进程/preload 代码中注入 __ELECTRON__ / __NASTI_TARGET__ 常量
//   - 检测当前模块是否属于主进程/Preload（非渲染进程）
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
      if (source === 'electron' || source.startsWith('electron/')) {
        return { id: source, external: true }
      }
      return null
    },
  }
}
