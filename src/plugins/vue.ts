// 内置 Vue 插件 - SFC 编译 + Vue HMR
import crypto from 'node:crypto'
import type { NastiPlugin, ResolvedConfig } from '../types.js'
import { transformCode } from '../core/transformer.js'

const VUE_FILE_RE = /\.vue$/
const VUE_QUERY_RE = /\.vue\?vue&type=(script|template|style)(&index=\d+)?(&lang=\w+)?/

interface VueCompilerSfc {
  parse: (source: string, options?: any) => any
  compileScript: (sfc: any, options: any) => any
  compileTemplate: (options: any) => any
  compileStyleAsync: (options: any) => Promise<any>
}

let compiler: VueCompilerSfc | null = null

async function loadVueCompiler(): Promise<VueCompilerSfc | null> {
  if (compiler) return compiler
  try {
    compiler = await import('@vue/compiler-sfc')
    return compiler
  } catch {
    return null
  }
}

export function vuePlugin(config: ResolvedConfig): NastiPlugin {
  const isDev = config.command === 'serve'
  const descriptorCache = new Map<string, any>()

  return {
    name: 'nasti:vue',
    enforce: 'pre',

    async resolveId(source) {
      // 处理 .vue 虚拟模块请求 (?vue&type=...)
      if (VUE_QUERY_RE.test(source)) {
        return source
      }
      return null
    },

    async transform(code, id) {
      // 处理 .vue 文件
      if (!VUE_FILE_RE.test(id) && !VUE_QUERY_RE.test(id)) return null

      const sfc = await loadVueCompiler()
      if (!sfc) {
        console.warn('[nasti:vue] @vue/compiler-sfc not found. Install it: npm install @vue/compiler-sfc')
        return null
      }

      // 处理虚拟模块请求（子块）
      if (VUE_QUERY_RE.test(id)) {
        return handleVueSubBlock(id, sfc, descriptorCache, config)
      }

      // 解析 SFC
      const { descriptor, errors } = sfc.parse(code, { filename: id })
      if (errors.length) {
        console.error(`[nasti:vue] Parse error in ${id}:`, errors[0].message)
        return null
      }

      descriptorCache.set(id, descriptor)
      const scopeId = hashId(id)

      // 编译 script
      let scriptCode = ''
      if (descriptor.script || descriptor.scriptSetup) {
        const compiled = sfc.compileScript(descriptor, {
          id: scopeId,
          isProd: !isDev,
          inlineTemplate: true,
          // 让 compileScript 产出 `const __sfc__ = ...`（而非默认的 `export default {...}`）。
          // 否则下方追加的 `__sfc__.render` / `__sfc__.__scopeId` / HMR 记录会引用一个
          // 不存在的 `__sfc__`，并与 compileScript 自带的 `export default` 形成双重默认导出。
          genDefaultAs: '__sfc__',
        })
        scriptCode = compiled.content
      }

      // 编译 template（如果没有 inline）
      let templateCode = ''
      if (descriptor.template && !descriptor.scriptSetup) {
        const compiled = sfc.compileTemplate({
          source: descriptor.template.content,
          filename: id,
          id: scopeId,
          compilerOptions: { scopeId: `data-v-${scopeId}` },
        })
        templateCode = compiled.code
      }

      // 组装输出。若 SFC 只有 <template> 而无任何 <script>，scriptCode 为空，
      // 兜底一个空组件对象，保证后续 `__sfc__.render` / `__scopeId` 赋值成立。
      let output = scriptCode || 'const __sfc__ = {}'

      if (templateCode) {
        output += `\n${templateCode}\n`
        output += `\n__sfc__.render = render\n`
      }

      // style 导入
      if (descriptor.styles.length > 0) {
        for (let i = 0; i < descriptor.styles.length; i++) {
          const style = descriptor.styles[i]
          const lang = style.lang ?? 'css'
          output += `\nimport "${id}?vue&type=style&index=${i}&lang=${lang}"\n`
        }
      }

      // scoped 标记
      output += `\n__sfc__.__scopeId = "data-v-${scopeId}"\n`

      // HMR
      if (isDev) {
        output += `
__sfc__.__hmrId = ${JSON.stringify(scopeId)}
if (typeof __VUE_HMR_RUNTIME__ !== 'undefined') {
  __VUE_HMR_RUNTIME__.createRecord(__sfc__.__hmrId, __sfc__)
}
if (import.meta.hot) {
  import.meta.hot.accept((mod) => {
    if (!mod) return
    const { default: updated } = mod
    if (typeof __VUE_HMR_RUNTIME__ !== 'undefined') {
      __VUE_HMR_RUNTIME__.rerender(updated.__hmrId, updated.render)
    }
  })
}
`
      }

      output += `\nexport default __sfc__\n`

      // compileScript 对 lang="ts" 的 SFC 会在产物里保留 TS 注解 —— 不仅是用户脚本，
      // 连内联 render 也带（如 `(_ctx: any, _cache: any) =>`、`($event: any) => ...`）。
      // Nasti 的 oxc 转译按扩展名只处理 .ts/.tsx，不碰 .vue，所以这里显式把组装后的
      // 产物按 TS 走一遍 oxc 剥离类型，产出纯 JS —— dev（浏览器原生 ESM）与 build
      // （Rolldown 解析）都需要这一步，否则裸 TS 会直接触发解析错误。
      const lang = descriptor.scriptSetup?.lang ?? descriptor.script?.lang
      if (lang === 'ts') {
        const transpiled = transformCode(`${id}.ts`, output, { sourcemap: false })
        return { code: transpiled.code }
      }

      return { code: output }
    },

    handleHotUpdate(ctx) {
      const { file, modules } = ctx
      if (VUE_FILE_RE.test(file)) {
        // Vue 文件更新: 标记为自接受
        for (const mod of modules) {
          mod.isSelfAccepting = true
        }
        // 清除缓存
        descriptorCache.delete(file)
      }
      return modules
    },
  }
}

async function handleVueSubBlock(
  id: string,
  sfc: VueCompilerSfc,
  cache: Map<string, any>,
  config: ResolvedConfig,
): Promise<{ code: string } | null> {
  const match = id.match(/(.+\.vue)\?vue&type=(\w+)(?:&index=(\d+))?(?:&lang=(\w+))?/)
  if (!match) return null

  const [, filePath, type, indexStr, lang] = match
  const descriptor = cache.get(filePath)
  if (!descriptor) return null

  if (type === 'style') {
    const index = parseInt(indexStr ?? '0', 10)
    const style = descriptor.styles[index]
    if (!style) return null

    const scopeId = hashId(filePath)
    const result = await sfc.compileStyleAsync({
      source: style.content,
      filename: filePath,
      id: `data-v-${scopeId}`,
      scoped: style.scoped ?? false,
    })

    // 将 CSS 转为 JS 模块注入
    const cssCode = JSON.stringify(result.code)
    return {
      code: `
const css = ${cssCode};
const style = document.createElement('style');
style.setAttribute('data-v-${scopeId}', '');
style.textContent = css;
document.head.appendChild(style);

if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.prune(() => style.remove());
}
`,
    }
  }

  return null
}

function hashId(filename: string): string {
  return crypto.createHash('sha256').update(filename).digest('hex').slice(0, 8)
}
