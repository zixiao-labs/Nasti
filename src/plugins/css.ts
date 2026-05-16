// CSS 处理插件 - 处理 .css 导入
import path from 'node:path'
import type { NastiPlugin, ResolvedConfig } from '../types.js'
import { compileTailwind, hasTailwindDirectives } from './tailwind.js'

export function cssPlugin(config: ResolvedConfig): NastiPlugin {
  return {
    name: 'nasti:css',

    resolveId(source) {
      if (source.endsWith('.css')) return null // 交给 resolve 插件处理
      return null
    },

    async transform(code, id) {
      if (!id.endsWith('.css')) return null

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
      const rewritten = rewriteCssUrls(cssSource, id, config.root)
      const escaped = JSON.stringify(rewritten)

      if (config.command === 'serve') {
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

      // Build 模式: rolldown 1.x 移除了实验性的 CSS bundling，直接返回 CSS
      // 会触发 UNSUPPORTED_FEATURE。把样式包成纯 JS 模块，在运行时挂到 <style>
      // 上 —— 同 dev 一致，省掉 HMR 头部即可。还要把 `moduleType` 显式声明为
      // `js`，否则 rolldown 仍按 `.css` 扩展名走 CSS 流水线、再次抛错。
      // 参考: https://github.com/rolldown/rolldown/issues/4271

      const cssConfig = config.build.css || {}
      const nonce = cssConfig.nonce
      const emitCssFile = cssConfig.emitCssFile

      if (emitCssFile) {
        // Emit CSS as a separate asset file and return JS that injects a <link> tag
        const fileName = `assets/${path.basename(id, '.css')}.css`
        this.emitFile({
          type: 'asset',
          fileName,
          source: rewritten,
        })

        return {
          code: `
const link = document.createElement('link');
link.rel = 'stylesheet';
link.href = ${JSON.stringify('/' + fileName)};
document.head.appendChild(link);

export default ${escaped};
`,
          moduleType: 'js',
        }
      }

      // Default: inline <style> injection
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
    const relative = '/' + path.relative(root, resolved)
    return `url(${relative})`
  })
}
