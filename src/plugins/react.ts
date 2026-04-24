// 内置 React 插件 - handleHotUpdate 保底标记 JSX 为自接受
//
// 注意：JSX/TSX 的实际转译与 Fast Refresh 包装统一由 server/middleware 管线处理
// （因为涉及 import.meta.hot 注入、模块 URL 标识、self-accepting 位），
// 此插件只保留一个后备 handleHotUpdate，防止在极端场景下（例如首次加载尚未
// transformRequest 过的模块发生 change 事件）还能走 full-reload 兜底。
import type { NastiPlugin } from '../types.js'

const REACT_FILE_RE = /\.[jt]sx$/

export function reactPlugin(_: unknown): NastiPlugin {
  return {
    name: 'nasti:react',

    handleHotUpdate(ctx) {
      const { modules } = ctx
      for (const mod of modules) {
        if (REACT_FILE_RE.test(mod.url)) {
          mod.isSelfAccepting = true
        }
      }
      return modules
    },
  }
}
