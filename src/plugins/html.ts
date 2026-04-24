// HTML 入口处理插件 - index.html 处理与脚本注入
import path from 'node:path'
import fs from 'node:fs'
import type { NastiPlugin, ResolvedConfig, HtmlTagDescriptor } from '../types.js'

/** 运行在用户脚本之前、安装 React Fast Refresh 全局钩子的 preamble。 */
const REACT_REFRESH_HTML_PREAMBLE = `
import RefreshRuntime from "/@react-refresh";
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
`.trim()

export function htmlPlugin(config: ResolvedConfig): NastiPlugin {
  return {
    name: 'nasti:html',
    enforce: 'post',

    transformIndexHtml(html) {
      const tags: HtmlTagDescriptor[] = []

      if (config.command === 'serve') {
        const isReactLike = config.framework === 'react' || config.framework === 'auto'

        // 先装 Fast Refresh 钩子（必须在任何用户模块之前，因为 JSX 模块 wrapper
        // 会校验 window.__vite_plugin_react_preamble_installed__）
        if (isReactLike) {
          tags.push({
            tag: 'script',
            attrs: { type: 'module' },
            children: REACT_REFRESH_HTML_PREAMBLE,
            injectTo: 'head-prepend',
          })
        }

        // HMR 客户端（内置 createHotContext 命名导出，供模块 wrapper 调用）
        tags.push({
          tag: 'script',
          attrs: { type: 'module', src: '/@nasti/client' },
          injectTo: 'head-prepend',
        })
      }

      return { html, tags }
    },
  }
}

/** 处理 HTML，注入标签并重写 script src */
export function processHtml(
  html: string,
  tags: HtmlTagDescriptor[],
): string {
  const headPrepend = tags.filter((t) => t.injectTo === 'head-prepend')
  const head = tags.filter((t) => t.injectTo === 'head' || !t.injectTo)
  const bodyPrepend = tags.filter((t) => t.injectTo === 'body-prepend')
  const body = tags.filter((t) => t.injectTo === 'body')

  if (headPrepend.length) {
    html = html.replace(/<head([^>]*)>/i, `<head$1>\n${serializeTags(headPrepend)}`)
  }
  if (head.length) {
    html = html.replace(/<\/head>/i, `${serializeTags(head)}\n</head>`)
  }
  if (bodyPrepend.length) {
    html = html.replace(/<body([^>]*)>/i, `<body$1>\n${serializeTags(bodyPrepend)}`)
  }
  if (body.length) {
    html = html.replace(/<\/body>/i, `${serializeTags(body)}\n</body>`)
  }

  return html
}

function serializeTags(tags: HtmlTagDescriptor[]): string {
  return tags.map(serializeTag).join('\n')
}

function serializeTag(tag: HtmlTagDescriptor): string {
  const attrs = tag.attrs
    ? ' ' +
      Object.entries(tag.attrs)
        .map(([k, v]) => (v === true ? k : `${k}="${v}"`))
        .join(' ')
    : ''
  const children =
    typeof tag.children === 'string'
      ? tag.children
      : tag.children
        ? serializeTags(tag.children)
        : ''

  const selfClosing = ['link', 'meta', 'br', 'hr', 'img', 'input'].includes(tag.tag)
  if (selfClosing && !children) {
    return `  <${tag.tag}${attrs} />`
  }
  return `  <${tag.tag}${attrs}>${children}</${tag.tag}>`
}

/** 读取并处理 HTML 入口文件 */
export async function readHtmlFile(root: string): Promise<string | null> {
  const htmlPath = path.resolve(root, 'index.html')
  if (!fs.existsSync(htmlPath)) return null
  return fs.readFileSync(htmlPath, 'utf-8')
}
