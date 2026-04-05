// CSS 处理插件 - 处理 .css 导入
import path from 'node:path'
import type { NastiPlugin, ResolvedConfig } from '../types.js'

export function cssPlugin(config: ResolvedConfig): NastiPlugin {
  return {
    name: 'nasti:css',

    resolveId(source) {
      if (source.endsWith('.css')) return null // 交给 resolve 插件处理
      return null
    },

    transform(code, id) {
      if (!id.endsWith('.css')) return null

      // 将 CSS 中的相对 url() 路径重写为绝对路径，确保打包后资源路径正确
      const rewritten = rewriteCssUrls(code, id, config.root)

      if (config.command === 'serve') {
        // Dev 模式: 将 CSS 转为 JS 模块，通过 style 标签注入
        const escaped = JSON.stringify(rewritten)
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

// HMR
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.prune(() => {
    style.remove();
  });
}

export default css;
`,
        }
      }

      // Build 模式: 返回重写后的 CSS，由 rolldown 处理提取
      return rewritten !== code ? { code: rewritten } : null
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
    const relative = '/' + path.relative(root, resolved)
    return `url(${relative})`
  })
}
