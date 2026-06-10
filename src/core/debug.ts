// Debug - DEBUG 环境变量驱动的命名空间调试输出（仿 Vite createDebugger）
// 用法：DEBUG=nasti:* nasti dev；NASTI_DEBUG_FILTER=foo 进一步按内容过滤
import pc from 'picocolors'

export type NastiDebugScope = `nasti:${string}`

interface DebuggerOptions {
  /** 仅当 DEBUG 精确包含该命名空间（而非 nasti:* 通配）时才启用 */
  onlyWhenFocused?: boolean | string
}

const DEBUG = process.env.DEBUG
// 同时认 vite:* —— 方便移植 Vite 插件/工作流时直接复用已有的 DEBUG 习惯
const filter = process.env.NASTI_DEBUG_FILTER || process.env.VITE_DEBUG_FILTER

export function createDebugger(
  namespace: NastiDebugScope,
  options: DebuggerOptions = {},
): ((...args: unknown[]) => void) | undefined {
  if (!DEBUG) return undefined

  const patterns = DEBUG.split(',').map((p) => p.trim())
  const enabled = patterns.some((p) => {
    if (p === '*' || p === 'nasti:*' || p === 'vite:*') return true
    // 把 vite:xxx 映射到 nasti:xxx，兼容移植的调试习惯
    const normalized = p.startsWith('vite:') ? `nasti:${p.slice(5)}` : p
    return normalized === namespace
  })
  if (!enabled) return undefined

  if (options.onlyWhenFocused) {
    const focus =
      typeof options.onlyWhenFocused === 'string'
        ? options.onlyWhenFocused
        : namespace
    if (!patterns.includes(focus)) return undefined
  }

  let lastTime = performance.now()
  return (...args: unknown[]) => {
    const now = performance.now()
    const elapsed = now - lastTime
    lastTime = now
    const msg = args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')
    if (filter && !msg.includes(filter)) return
    console.debug(
      `${pc.magenta(namespace)} ${msg} ${pc.dim(`+${Math.round(elapsed)}ms`)}`,
    )
  }
}
