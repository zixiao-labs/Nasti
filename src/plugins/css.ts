// CSS 处理插件 - 处理 .css 导入
//
// dev：编译后注入可热更新的 <style>（行为与 1.x 完全一致）
// build：compile 阶段 —— 编译 + url() 重写后把 CSS 注册进 CssEngine，
//        向 Rolldown 返回空 JS stub（moduleType:'js'，规避 rolldown#4271
//        移除原生 CSS 打包后的报错；no-treeshake 保证模块留在 chunk.moduleIds
//        里供 css-post 的 renderChunk 聚合）。真正的 .css 产物由
//        plugins/css-post.ts 在 renderChunk 期 per-chunk 抽取。
import path from 'node:path'
import type { NastiPlugin, ResolvedConfig } from '../types.js'
import type { CssEngine } from '../core/css-engine.js'
import { normalizeCssModuleId } from '../core/css-engine.js'
import { compileTailwind, hasTailwindDirectives } from './tailwind.js'

export function cssPlugin(
  config: ResolvedConfig,
  engine?: CssEngine,
  consumer: 'client' | 'server' = 'client',
): NastiPlugin {
  return {
    name: 'nasti:css',

    resolveId(source) {
      if (source.endsWith('.css')) return null // 交给 resolve 插件处理
      return null
    },

    async transform(code, id) {
      // 匹配 .css 文件与 .css 结尾的虚拟模块（如 Vue style 子块
      // `App.vue?vue&type=style&index=0&lang.css`）；?raw / ?url 交给 assets 插件
      const [file, query = ''] = id.split('?', 2)
      const isCssRequest = file.endsWith('.css') || /\.css$/.test(id)
      if (!isCssRequest) return null
      if (query === 'raw' || query === 'url') return null

      // Tailwind v4: when the stylesheet uses any v4 directive, hand the
      // entire source to Tailwind. Tailwind's own compiler resolves all
      // `@import`s (including bare specifiers like `@heroui/styles`), runs
      // the oxide scanner to discover utility candidates, and emits a
      // fully-flattened stylesheet — which is exactly what the browser
      // needs when we inline the result into a `<style>` tag below.
      let cssSource = code
      if (hasTailwindDirectives(code)) {
        const compiled = await compileTailwind(code, id, config.root)
        cssSource = compiled.css
      }

      // 将 CSS 中的相对 url() 路径重写为绝对路径，确保打包后资源路径正确
      const rewritten = rewriteCssUrls(cssSource, file, config.root)
      const escaped = JSON.stringify(rewritten)
      const normalizedId = normalizeCssModuleId(id)
      const cssModule = { id: normalizedId, source: code, code: rewritten }
      const map = config.build.sourcemap
        ? {
            version: 3,
            sources: [id],
            sourcesContent: [code],
            names: [],
            mappings: '',
          }
        : undefined
      engine?.modules.set(normalizedId, cssModule)
      this.environment?.setCssModule?.(cssModule)

      // ?inline：只要编译后的字符串，不注入、不抽取（dev/build 行为一致）
      if (query === 'inline') {
        return { code: `export default ${escaped};\n`, map, moduleType: 'js' }
      }

      // server consumer（SSR dev/build、Electron main/preload）：无 DOM 环境，
      // 返回 CSS 字符串导出（SSR 可收集），真实 .css 产物由 client 环境负责
      if (consumer === 'server') {
        return { code: `export default ${escaped};\n`, map, moduleType: 'js' }
      }

      if (config.command === 'serve') {
        if (config.build.css.inject === false) {
          return {
            code: `export default ${escaped};\n`,
            map,
            moduleType: 'js',
            moduleSideEffects: 'no-treeshake',
          }
        }
        // Dev 模式: 注入可热更新的 <style> 标签
        return {
          code: `
const css = ${escaped};
const __nasti_css_id__ = ${JSON.stringify(id)};
const __nasti_existing__ = document.querySelector('style[data-nasti-css=' + JSON.stringify(__nasti_css_id__) + ']');
if (__nasti_existing__) __nasti_existing__.remove();
const style = document.createElement('style');
style.setAttribute('data-nasti-css', __nasti_css_id__);
style.textContent = css;
document.head.appendChild(style);

// HMR（prune 在 bundled 模式的 rolldown hot context 上不存在，须守卫）
if (import.meta.hot) {
  import.meta.hot.accept();
  if (import.meta.hot.prune) {
    import.meta.hot.prune(() => {
      style.remove();
    });
  }
}

export default css;
`,
          map,
          // bundled dev（DevEngine）下该模块会进 Rolldown：不标 js 会按 .css
          // 扩展名走 CSS 管线触发 #4271 报错；unbundled 中间件忽略此字段
          moduleType: 'js',
        }
      }

      // Build 模式：注册进 CssEngine，由 css-post 在 renderChunk 抽取为
      // 带 hash 的 .css 文件。返回空 stub —— CSS 文本不再进 JS bundle
      // （1.x 是运行时 <style>/<link> 注入 + export default css 字符串，
      // 体积双份；`import css from './x.css'` 现在得到 ''，需要字符串请用
      // `?inline`，与 Vite 语义一致）。
      if (engine) {
        engine.styles.set(normalizedId, rewritten)
        return {
          code: `export default '';\n`,
          map,
          moduleType: 'js',
          // 防止空 stub 被 tree-shake 出 chunk.moduleIds（css-post 靠它定位）
          moduleSideEffects: 'no-treeshake',
        }
      }

      // 无 engine（理论上只有未迁移的调用方）：保留 1.x 运行时注入兜底
      const cssConfig = config.build.css || {}
      const nonce = cssConfig.nonce
      const nonceAttr = nonce ? `style.setAttribute('nonce', ${JSON.stringify(nonce)});` : ''
      return {
        code: `
const css = ${escaped};
const style = document.createElement('style');
style.setAttribute('data-nasti-css', ${JSON.stringify(id)});
${nonceAttr}
style.textContent = css;
document.head.appendChild(style);

export default css;
`,
        map,
        moduleType: 'js',
      }
    },
  }
}

/** CSS URL 重写（将相对路径转为绝对路径） */
export function rewriteCssUrls(css: string, from: string, root: string): string {
  return css.replace(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g, (match, url: string) => {
    // 跳过绝对路径、data URI、http(s) URL
    if (url.startsWith('/') || url.startsWith('data:') || url.startsWith('http')) {
      return match
    }
    const resolved = path.resolve(path.dirname(from), url)
    // path.relative 在 Windows 上产出反斜杠 —— URL 必须用 POSIX 分隔符
    const relative = '/' + path.relative(root, resolved).replace(/\\/g, '/')
    return `url(${relative})`
  })
}
