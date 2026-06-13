// CSS 引擎 - build 期 per-chunk CSS 抽取的共享状态与工具
//
// 架构（NASTI_2.0_PLAN.md §2.2）：
//   compile 阶段（plugins/css.ts）  ：Tailwind 编译 + url() 重写，把 CSS 字符串
//                                     按规范化模块 id 注册进 styles Map，向
//                                     bundler 返回空 JS stub（moduleType:'js'，
//                                     Rolldown 1.x 移除了原生 CSS 打包，见 #4271）
//   css-post 阶段（plugins/css-post.ts）：renderChunk 按 chunk.moduleIds 聚合
//                                     CSS、压缩、emitFile 产出带 hash 的 .css
//
// 压缩器是 Lightning CSS（守卫导入，可选依赖）—— 这是相对 Vite 默认
// （PostCSS 转换器 + Lightning 压缩器）的有意分歧：纯 Rust、依赖更小。
// 不可用时回退到保守的正则压缩。
import type { ResolvedConfig } from '../types.js'
import { createDebugger } from './debug.js'

const debug = createDebugger('nasti:css')

export interface CssEngine {
  /** 规范化模块 id → 编译后的 CSS 字符串 */
  styles: Map<string, string>
  /** entry chunk 的 facadeModuleId → 抽出的 css 文件名（用于 HTML <link> 注入） */
  entryCss: Map<string, string[]>
  /** 全部已 emit 的 css 文件名（按 render 顺序） */
  allCss: string[]
  /** cssCodeSplit:false 时的跨 chunk 累积（按 renderChunk 顺序） */
  pendingSingle: string[]
  /** cssCodeSplit:false 时最终单文件名 */
  singleFileName: string | null
}

export function createCssEngine(): CssEngine {
  return {
    styles: new Map(),
    entryCss: new Map(),
    allCss: [],
    pendingSingle: [],
    singleFileName: null,
  }
}

/**
 * 规范化模块 id：去掉 Rolldown 虚拟模块的 null-byte 前缀。
 * **保留 query** —— Vue style 子块（`App.vue?vue&type=style&...&lang.css`）与
 * 父模块 `App.vue` 是不同模块，剥 query 会让二者 key 撞车导致 CSS 重复输出。
 * chunk.moduleIds 里的 id 必须与 transform 期注册的 key 一致 —— 两侧都过这个函数。
 */
export function normalizeCssModuleId(id: string): string {
  return id.startsWith('\0') ? id.slice(1) : id
}

let lightningCss: typeof import('lightningcss') | null | undefined

/**
 * 压缩 CSS：优先 Lightning CSS（守卫导入），不可用时回退正则压缩。
 * Tailwind v4 的输出已自行 flatten @import，这里不做 @import 解析。
 */
export async function minifyCss(css: string, config: ResolvedConfig): Promise<string> {
  if (lightningCss === undefined) {
    try {
      lightningCss = await import('lightningcss')
    } catch {
      lightningCss = null
      debug?.('lightningcss unavailable, falling back to regex minifier')
    }
  }
  if (lightningCss) {
    try {
      const result = lightningCss.transform({
        filename: 'bundle.css',
        code: Buffer.from(css),
        minify: true,
        // 不展开 @import（Tailwind 已 flatten；裸 @import 保留原样交给浏览器）
        errorRecovery: true,
      })
      for (const w of result.warnings ?? []) {
        config.logger.warnOnce(`[nasti:css] ${w.message}`)
      }
      return result.code.toString()
    } catch (err: any) {
      config.logger.warnOnce(
        `[nasti:css] Lightning CSS minify failed (${err.message}), emitting unminified CSS`,
      )
      return css
    }
  }
  return fallbackMinify(css)
}

/** 保守的正则压缩：去注释、压空白。不做任何结构性变换。 */
function fallbackMinify(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // 仅折叠结构性标点周围的空白；不碰 + > ~ —— 它们在 calc()（`1 + 2`）
    // 与选择器组合符里语义敏感，去空格会产出非法 CSS
    .replace(/\s*([{}:;,])\s*/g, '$1')
    .replace(/;}/g, '}')
    .replace(/\s+/g, ' ')
    .trim()
}
