// CSS post 插件 - build 期 per-chunk CSS 抽取（NASTI_2.0_PLAN.md §2.2）
//
// renderChunk 在 Rolldown 真实插件上下文中运行（经 build/index.ts 转发表），
// this.emitFile({type:'asset'}) 经 output.assetFileNames 产出带 hash 的 .css，
// this.getFileName(ref) 立即可解析最终文件名（asset hash 由内容决定，与 chunk
// hash 无关，因此 renderChunk 期即可取得）。
//
// - entry chunk：css 文件名记入 engine.entryCss，由 build/index.ts 注入静态
//   <link rel="stylesheet"> 到 index.html
// - 动态 chunk：在 chunk 代码"尾部"追加幂等的运行时 <link> 注入片段
//   （追加而非前置 —— 保持原代码行号，sourcemap 仍然对齐；FOUC 窗口已知，
//   Phase 3 的打包模式会换 DevEngine 路径）
// - augmentChunkHash 把 chunk 关联的 CSS 内容折进 JS chunk hash（缓存正确性）
import type { RenderedChunk } from 'rolldown'
import type { NastiPlugin, ResolvedConfig } from '../types.js'
import { type CssEngine, normalizeCssModuleId, minifyCss } from '../core/css-engine.js'

/** 按 chunk 模块执行顺序聚合该 chunk 的 CSS（id 两侧都已规范化） */
function collectChunkCss(chunk: RenderedChunk, engine: CssEngine): string {
  const ids = chunk.moduleIds ?? Object.keys(chunk.modules)
  let css = ''
  for (const id of ids) {
    const styles = engine.styles.get(normalizeCssModuleId(id))
    if (styles) css += styles + '\n'
  }
  return css
}

export function cssPostPlugin(config: ResolvedConfig, engine: CssEngine): NastiPlugin {
  return {
    name: 'nasti:css-post',
    enforce: 'post',

    async renderChunk(code, chunk) {
      const css = collectChunkCss(chunk, engine)
      if (!css) return null

      // 单文件模式：跨 chunk 累积，generateBundle 一次性 emit
      if (!config.build.cssCodeSplit) {
        engine.pendingSingle.push(css)
        return null
      }

      const finalCss = config.build.cssMinify ? await minifyCss(css, config) : css
      const ref = this.emitFile({
        type: 'asset',
        name: `${chunk.name}.css`,
        source: finalCss,
      })
      const fileName = this.getFileName(ref)
      engine.allCss.push(fileName)

      if (chunk.isEntry) {
        const key = chunk.facadeModuleId ?? chunk.name
        const existing = engine.entryCss.get(key) ?? []
        existing.push(fileName)
        engine.entryCss.set(key, existing)
        return null
      }

      // 动态 chunk：运行时注入 <link>（幂等，data-nasti-css 标记去重）
      const href = JSON.stringify(config.base + fileName)
      const snippet =
        `\n;(function(){try{var d=document,h=${href};` +
        `if(!d.querySelector('link[data-nasti-css="'+h+'"]')){` +
        `var l=d.createElement('link');l.rel='stylesheet';l.href=h;` +
        `l.setAttribute('data-nasti-css',h);d.head.appendChild(l);}}catch(e){}})();`
      return { code: code + snippet, map: null }
    },

    augmentChunkHash(chunk) {
      // CSS 内容变 → JS chunk hash 变（动态 chunk 的注入 URL、缓存失效正确性）
      const css = collectChunkCss(chunk, engine)
      return css || undefined
    },

    async generateBundle() {
      if (config.build.cssCodeSplit || engine.pendingSingle.length === 0) return
      const merged = engine.pendingSingle.join('\n')
      const finalCss = config.build.cssMinify ? await minifyCss(merged, config) : merged
      const ref = this.emitFile({ type: 'asset', name: 'style.css', source: finalCss })
      const fileName = this.getFileName(ref)
      engine.singleFileName = fileName
      engine.allCss.push(fileName)
    },
  }
}
