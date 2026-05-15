// HTTP 中间件 - 请求拦截与按需转译
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ResolvedConfig } from '../types.js'
import { PluginContainer } from '../core/plugin-container.js'
import { ModuleGraph } from '../core/module-graph.js'
import { transformCode, shouldTransform, getModuleType } from '../core/transformer.js'
import { readHtmlFile, processHtml } from '../plugins/html.js'
import { loadEnv, buildEnvDefine, replaceEnvInCode } from '../core/env.js'

const __dirname_esm = path.dirname(fileURLToPath(import.meta.url))
const __require = createRequire(import.meta.url)

/**
 * 将 react-refresh 的 CJS 运行时包装成浏览器可用的 ESM。
 * 原 CJS 通过 `exports.xxx = fn` 写入导出；我们用假的 module/exports/process
 * 对象跑一遍，再显式 re-export 出来。
 *
 * 读一次缓存一次：dev server 生命周期内不会变。
 */
let __refreshRuntimeCache: string | null = null
function getReactRefreshRuntimeEsm(): string {
  if (__refreshRuntimeCache) return __refreshRuntimeCache
  // react-refresh 的 package.json `exports` 没有暴露 ./cjs/*，Node 24 严格执行
  // exports 后 `require.resolve('react-refresh/cjs/...')` 会抛 ERR_PACKAGE_PATH_NOT_EXPORTED。
  // 改为先 resolve 受支持的 ./package.json，再手动拼 cjs 子路径，绕开 exports 校验。
  let cjsPath: string
  try {
    const pkgPath = __require.resolve('react-refresh/package.json')
    cjsPath = path.join(path.dirname(pkgPath), 'cjs', 'react-refresh-runtime.development.js')
  } catch (err) {
    // 兜底：从 dist 向上找
    cjsPath = path.resolve(__dirname_esm, '../../node_modules/react-refresh/cjs/react-refresh-runtime.development.js')
    if (!fs.existsSync(cjsPath)) {
      const origMsg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `[nasti] Missing dependency "react-refresh". Install it with: npm install react-refresh\nOriginal resolve error: ${origMsg}`,
      )
    }
  }
  const cjsSource = fs.readFileSync(cjsPath, 'utf-8')
  // 这些命名对应 react-refresh-runtime 的公共导出，与
  // node -e "Object.keys(require('react-refresh/runtime'))" 对齐。
  __refreshRuntimeCache = `// Wrapped react-refresh runtime -> ESM
const exports = {};
const module = { exports };
const process = { env: { NODE_ENV: 'development' } };
${cjsSource}
const __rt = module.exports;
export const injectIntoGlobalHook = __rt.injectIntoGlobalHook;
export const register = __rt.register;
export const createSignatureFunctionForTransform = __rt.createSignatureFunctionForTransform;
export const performReactRefresh = __rt.performReactRefresh;
export const isLikelyComponentType = __rt.isLikelyComponentType;
export const hasUnrecoverableErrors = __rt.hasUnrecoverableErrors;
export const setSignature = __rt.setSignature;
export const getFamilyByID = __rt.getFamilyByID;
export const getFamilyByType = __rt.getFamilyByType;
export const findAffectedHostInstances = __rt.findAffectedHostInstances;
export const collectCustomHooksForSignature = __rt.collectCustomHooksForSignature;
export default __rt;
`
  return __refreshRuntimeCache
}

/**
 * React Fast Refresh 全局钩子安装脚本。
 * 必须在用户代码之前执行，由 html.ts 以 head-prepend 的方式注入到 index.html。
 */
export const REACT_REFRESH_GLOBAL_PREAMBLE = `
import RefreshRuntime from "/@react-refresh";
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
`.trim()

/**
 * 单模块的 Fast Refresh 包装。
 *
 * 包装前先把 transformed 代码里的 `import.meta.hot` 替换为本地 `__nasti_hot__`
 * 变量 —— 规避 `import.meta` 属性赋值在某些引擎下不可写的问题，并统一 JSX/非 JSX
 * 路径的 hot 来源。
 */
function buildReactRefreshWrapper(moduleUrl: string, transformedCode: string): string {
  const urlLit = JSON.stringify(moduleUrl)
  const userCode = transformedCode.replace(/\bimport\.meta\.hot\b/g, '__nasti_hot__')
  return `import * as RefreshRuntime from "/@react-refresh";
import { createHotContext as __nasti_createHotContext__ } from "/@nasti/client";
const __nasti_hot__ = __nasti_createHotContext__(${urlLit});

if (!window.__vite_plugin_react_preamble_installed__) {
  throw new Error("[nasti] React Fast Refresh preamble missing. Make sure nasti:html is wired with framework: 'react'.");
}

const prevRefreshReg = window.$RefreshReg$;
const prevRefreshSig = window.$RefreshSig$;
window.$RefreshReg$ = (type, id) => {
  RefreshRuntime.register(type, ${urlLit} + " " + id);
};
window.$RefreshSig$ = RefreshRuntime.createSignatureFunctionForTransform;

${userCode}

window.$RefreshReg$ = prevRefreshReg;
window.$RefreshSig$ = prevRefreshSig;

if (__nasti_hot__) {
  __nasti_hot__.accept(() => {
    clearTimeout(window.__nasti_refresh_timer__);
    window.__nasti_refresh_timer__ = setTimeout(() => {
      RefreshRuntime.performReactRefresh();
    }, 30);
  });
}
`
}

/**
 * 非 JSX 模块里用户显式写了 import.meta.hot —— 注入一段 hot context 头部并替换属性访问为本地变量。
 */
function injectImportMetaHot(code: string, moduleUrl: string): string {
  if (!/\bimport\.meta\.hot\b/.test(code)) return code
  const urlLit = JSON.stringify(moduleUrl)
  const header = `import { createHotContext as __nasti_createHotContext__ } from "/@nasti/client";
const __nasti_hot__ = __nasti_createHotContext__(${urlLit});
`
  return header + code.replace(/\bimport\.meta\.hot\b/g, '__nasti_hot__')
}

export interface TransformMiddlewareContext {
  config: ResolvedConfig
  pluginContainer: PluginContainer
  moduleGraph: ModuleGraph
  envDefine?: Record<string, string>
}

/** 主转译中间件 - 处理模块请求 */
export function transformMiddleware(ctx: TransformMiddlewareContext) {
  // 预加载环境变量，避免每次请求都重新读取 .env 文件
  ctx.envDefine = buildEnvDefine(
    loadEnv(ctx.config.mode, ctx.config.root, ctx.config.envPrefix),
    ctx.config.mode,
  )
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = req.url ?? '/'

    // 设置 CORS 响应头
    if (ctx.config.server.cors) {
      const origin = req.headers.origin ?? '*'
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      if (req.method === 'OPTIONS') {
        res.statusCode = 204
        res.end()
        return
      }
    }

    // 跳过非 GET 请求
    if (req.method !== 'GET') return next()

    // 处理 HMR 客户端请求
    if (url === '/@nasti/client') {
      res.setHeader('Content-Type', 'application/javascript')
      res.end(getHmrClientCode())
      return
    }

    // 处理 HTML 请求
    if (url === '/' || url.endsWith('.html')) {
      const html = await readHtmlFile(ctx.config.root)
      if (html) {
        let processedHtml = html

        // 执行 transformIndexHtml 钩子
        for (const plugin of ctx.config.plugins) {
          if (plugin.transformIndexHtml) {
            const result = await plugin.transformIndexHtml(processedHtml)
            if (typeof result === 'string') {
              processedHtml = result
            } else if (result && 'html' in result) {
              processedHtml = processHtml(result.html, result.tags)
            } else if (Array.isArray(result)) {
              processedHtml = processHtml(processedHtml, result)
            }
          }
        }

        res.setHeader('Content-Type', 'text/html')
        res.end(processedHtml)
        return
      }
    }

    // 处理模块请求（.ts, .tsx, .jsx, .vue, .css 等）
    if (isModuleRequest(url)) {
      try {
        const result = await transformRequest(url, ctx)
        if (result) {
          const contentType = url.endsWith('.css')
            ? 'application/javascript' // CSS 已转为 JS 模块
            : 'application/javascript'
          res.setHeader('Content-Type', contentType)
          res.setHeader('Cache-Control', 'no-cache')
          res.end(typeof result === 'string' ? result : result.code)
          return
        }
      } catch (err: any) {
        console.error(`[nasti] Transform error: ${url}`, err.message)
        res.statusCode = 500
        res.end(`Transform error: ${err.message}`)
        return
      }
    }

    next()
  }
}

/** 转译单个模块 */
export async function transformRequest(
  url: string,
  ctx: TransformMiddlewareContext,
): Promise<{ code: string; map?: unknown } | null> {
  const { config, pluginContainer, moduleGraph } = ctx

  const cleanReqUrl = url.split('?')[0]

  // 检查缓存
  const cached = moduleGraph.getModuleByUrl(url)
  if (cached?.transformResult) {
    return cached.transformResult as { code: string; map?: unknown }
  }

  // React Refresh 真实运行时（来自 react-refresh/cjs 包装为 ESM）
  if (cleanReqUrl === '/@react-refresh') {
    return { code: getReactRefreshRuntimeEsm() }
  }

  // 插件提供的虚拟模块。
  //
  // Vite 风格的插件（如 chen-the-dawnstreak 的 file-based routing、virtual SVG sprite 等）
  // 用 `resolveId` 声称某个 bare specifier（例如 `virtual:chen-routes`），再用 `load` 提供模块源码。
  // `rewriteImports` 已经把 bare specifier 改写成 `/@modules/<spec>`，所以这里是它们落到 dev server 上的入口。
  //
  // 之前 dev server 仅做 `resolveUrlToFile` 的磁盘查找 → 直接 404。这里在落盘查找之前先问插件，
  // 如果有人接管这个 spec **并且** 解析后的 id 不是真实文件（`\0`-前缀或不存在），就走插件
  // 的 load → transform 管道；real file 路径则交给原来的 `bundlePackageAsEsm` 分支处理。
  //
  // 没有任何插件认领的 spec 仍然回落到 `resolveNodeModule`，npm 包加载行为不变。
  if (cleanReqUrl.startsWith('/@modules/')) {
    const spec = cleanReqUrl.slice('/@modules/'.length)
    const virtual = await loadVirtualModule(spec, ctx)
    if (virtual) {
      const mod = await moduleGraph.ensureEntryFromUrl(url)
      moduleGraph.setModuleId(mod, virtual.id)
      mod.transformResult = virtual.result
      return virtual.result
    }
  }

  // 解析文件路径
  const filePath = resolveUrlToFile(url, config.root)
  if (!filePath || !fs.existsSync(filePath)) return null

  // 创建/获取模块节点
  const mod = await moduleGraph.ensureEntryFromUrl(url)
  moduleGraph.registerModule(mod, filePath)

  // node_modules 模块：用 rolldown 打成浏览器可用的 ESM
  // 解决 CJS 包（如 react）无法在浏览器中作为 ESM 使用的问题
  if (cleanReqUrl.startsWith('/@modules/')) {
    const code = await bundlePackageAsEsm(filePath)
    const transformResult = { code }
    mod.transformResult = transformResult
    return transformResult
  }

  // 读取源码
  let code = fs.readFileSync(filePath, 'utf-8')

  // 通过插件管道 transform
  const pluginResult = await pluginContainer.transform(code, filePath)
  if (pluginResult) {
    code = typeof pluginResult === 'string' ? pluginResult : pluginResult.code
  }

  // Fast Refresh / HMR 键必须在同一文件的多次 import（?t=xxx 变化）间稳定
  const stableUrl = cleanReqUrl

  // OXC 转译 (TS/JSX/TSX)
  let wrappedWithRefresh = false
  if (shouldTransform(filePath)) {
    const isJsx = /\.[jt]sx$/.test(filePath)
    const useRefresh = isJsx && config.framework !== 'vue'
    const result = transformCode(filePath, code, {
      sourcemap: true,
      jsxRuntime: 'automatic',
      jsxImportSource: config.framework === 'vue' ? 'vue' : 'react',
      reactRefresh: useRefresh,
    })
    code = result.code
    if (useRefresh) {
      // 把模块包装起来：安装 $RefreshReg$/$RefreshSig$、建 hot context、尾部触发 performReactRefresh
      code = buildReactRefreshWrapper(stableUrl, code)
      wrappedWithRefresh = true
      // 标记为自接受，HMR 传播到此为止，不再 full-reload
      mod.isSelfAccepting = true
    }
  }

  // 非 Fast-Refresh 模块里用户自己写了 import.meta.hot 的，注入 hot context
  if (!wrappedWithRefresh) {
    code = injectImportMetaHot(code, stableUrl)
  }

  // 替换 import.meta.env.* 为实际值
  const envDefine = ctx.envDefine ?? buildEnvDefine(
    loadEnv(config.mode, config.root, config.envPrefix),
    config.mode,
  )
  code = replaceEnvInCode(code, envDefine)

  // 重写 import 规范：alias / 相对路径 → 解析后的绝对 URL（带扩展名），bare → /@modules/
  code = rewriteImports(code, config, filePath)

  const transformResult = { code }
  mod.transformResult = transformResult
  return transformResult
}

/**
 * Run the plugin `resolveId` → `load` → `transform` pipeline for a bare specifier
 * that arrived as `/@modules/<spec>`, and return the prepared JS module if (and
 * only if) the result is a virtual module — i.e. its resolved id either uses the
 * Vite-convention `\0` null-byte prefix or does not exist on disk.
 *
 * Real-file resolutions (e.g. an alias plugin remapping a bare specifier onto a
 * source file under the project) are intentionally skipped here so they fall
 * through to the normal `resolveUrlToFile` / `bundlePackageAsEsm` paths; this
 * keeps the npm-package loader and the React Refresh wrapper in charge of those.
 */
async function loadVirtualModule(
  spec: string,
  ctx: TransformMiddlewareContext,
): Promise<{ id: string; result: { code: string } } | null> {
  const { config, pluginContainer } = ctx
  const resolved = await pluginContainer.resolveId(spec)
  if (resolved == null) return null
  const resolvedId = typeof resolved === 'string' ? resolved : resolved.id
  const looksVirtual = resolvedId.startsWith('\0') || !fs.existsSync(resolvedId)
  if (!looksVirtual) return null

  const loadResult = await pluginContainer.load(resolvedId)
  if (loadResult == null) return null
  let code = typeof loadResult === 'string' ? loadResult : loadResult.code

  // Let other plugins transform the virtual source (e.g. macros, define-replace).
  const transformed = await pluginContainer.transform(code, resolvedId)
  if (transformed != null) {
    code = typeof transformed === 'string' ? transformed : transformed.code
  }

  // Replace `import.meta.env.*` and rewrite the inner import specifiers so the
  // browser can fetch them. Anchor at a synthetic file under the project root
  // so `./x` style imports inside generated code resolve from root (the same
  // contract Vite offers virtual modules whose ids don't map to a real dir).
  code = replaceEnvInCode(code, ctx.envDefine ?? buildEnvDefine(
    loadEnv(config.mode, config.root, config.envPrefix),
    config.mode,
  ))
  const anchor = path.join(config.root, '__nasti_virtual__.ts')
  code = rewriteImports(code, config, anchor)

  return { id: resolvedId, result: { code } }
}

/** 用 rolldown 将 node_modules 包打包为浏览器可用的 ESM（含 CJS→ESM 转换） */
// Promise 缓存：同一入口文件只打包一次，防止并发重复打包
const esmBundleCache = new Map<string, Promise<string>>()

async function bundlePackageAsEsm(entryFile: string): Promise<string> {
  if (!esmBundleCache.has(entryFile)) {
    esmBundleCache.set(entryFile, doBundlePackage(entryFile))
  }
  return esmBundleCache.get(entryFile)!
}

async function doBundlePackage(entryFile: string): Promise<string> {
  // 子路径入口（如 `react-aria-components/Select`）尝试生成 re-export shim，
  // 指向同包主入口。否则每个子路径会被 rolldown 各自打成独立 bundle，
  // 把同一份 `private/*.cjs` 内联多份 → 多个 `createContext(null)` 实例 →
  // React Aria 之类对 context identity 敏感的库会出现「provider 与 consumer
  // 看到的不是同一个 context」、`useContext` 返回 null 的运行期崩溃。
  // 详见: https://github.com/zixiao-labs/Nasti/pull/16
  const shim = await tryGenerateSubpathShim(entryFile)
  if (shim != null) return shim

  const { rolldown } = await import('rolldown')

  const bundle = await rolldown({
    input: entryFile,
    // 仅将其他 npm 包外部化；相对路径（包内部文件）全部内联打包
    external: (id: string) => {
      if (id.startsWith('.') || id.startsWith('/') || /^[A-Za-z]:\\/.test(id)) return false
      return true
    },
  })

  const result = await bundle.generate({ format: 'esm', exports: 'named' })
  await bundle.close()

  let code = result.output[0].code

  // 替换 process.env.NODE_ENV（rolldown 的 define 选项在此版本无效）
  code = code.replace(/process\.env\.NODE_ENV/g, '"development"')

  // 将外部化的 bare specifier 改写为 /@modules/ 路径供浏览器加载
  // ⚠️ 必须用 ^ + m 锚定行首，只匹配真正的 import/export 声明，
  // 避免误匹配字符串内出现的 from "..." 导致 SyntaxError
  code = code
    .replace(/^(import\b[^;'"]*?\bfrom\s+)(['"])([^'"./][^'"]*)(\2)/gm,
      (_, prefix, q, spec) => `${prefix}${q}/@modules/${spec}${q}`)
    .replace(/^(export\b[^;'"]*?\bfrom\s+)(['"])([^'"./][^'"]*)(\2)/gm,
      (_, prefix, q, spec) => `${prefix}${q}/@modules/${spec}${q}`)
    .replace(/^(import\s+)(['"])([^'"./][^'"]*)(\2)/gm,
      (_, prefix, q, spec) => `${prefix}${q}/@modules/${spec}${q}`)

  // CJS 外部 require 改写：
  // rolldown 将 CJS 的 require("pkg") 转为 __require("pkg")，在浏览器中抛异常。
  // 收集所有 __require("pkg")，替换为顶层 ESM import 的变量引用。
  code = rewriteExternalRequires(code)

  // CJS 包的具名导出补全：
  // rolldown 将 CJS 包包装为 __commonJSMin，只输出 export default，
  // 导致 import { parse } from '/@modules/cookie' 等具名导入失败。
  // 通过 createRequire 在 Node.js 侧加载 CJS 模块，取出 exports 的 key，
  // 在 ESM bundle 末尾补上静态具名 export。
  if (code.includes('__commonJSMin')) {
    code = await injectCjsNamedExports(code, entryFile)
  }

  return code
}

/**
 * 当入口是 npm 包的「子路径」（即 `pkg/sub` 形式，对应 `node_modules/pkg/`
 * 内部的某个非主入口文件）时，尝试改用一个薄薄的 re-export shim 替代独立 bundle，
 * shim 通过 `/@modules/<pkgName>` 复用主入口 bundle 的导出。
 *
 * 这样做是为了避免「同一份代码被打到多个 bundle 里」造成的运行时 bug：
 * 例如 `react-aria-components/Select` 与 `react-aria-components` 主入口都内部
 * 依赖 `private/Select.*`，而 rolldown 会把这份相对依赖内联到各自的 bundle 中。
 * 结果是浏览器侧出现两个独立的 `SelectContext = createContext(null)` 实例 ——
 * `<Select>` 写入的 Provider 与下方 `<SelectValue>` 读到的 Consumer 不再指向
 * 同一个 context，`useContext` 返回 null 直接崩。React Aria 的 Tabs / Collection
 * / DialogTrigger 等都属于这一类对 context identity 敏感的设计。
 *
 * 安全前提：shim 仅在主入口 **完整覆盖** 子路径所有具名导出、且各导出值
 * 与主入口下的对应值是 **同一引用**（identity 相等）时生成；否则回退到普通
 * bundling，避免错误改写有副作用的子路径（如真正分裂的入口、wrapped exports）。
 *
 * 仅 dev server 使用：build 模式走单一 rolldown 整图打包，本身不会重复内联。
 */
async function tryGenerateSubpathShim(entryFile: string): Promise<string | null> {
  // 1. 必须位于 node_modules 内
  const NM = `${path.sep}node_modules${path.sep}`
  if (!entryFile.includes(NM)) return null

  // 2. 自下而上找第一份带 `name` 的 package.json，确认所属包根目录
  let pkgDir: string | null = null
  let pkgName: string | null = null
  let dir = path.dirname(entryFile)
  while (true) {
    const pkgJsonPath = path.join(dir, 'package.json')
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'))
        if (typeof pkg?.name === 'string' && pkg.name) {
          pkgDir = dir
          pkgName = pkg.name
          break
        }
      } catch {
        // 解析失败：继续向上找，但通常意味着这不是合法包
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
    // 一旦走出 node_modules 就放弃（用户源码不应进入此分支）
    if (!dir.includes(NM)) return null
  }
  if (!pkgDir || !pkgName) return null

  // 3. 选择与入口 **同扩展名** 的主入口路径。这一步至关重要：
  //    主入口的 `.cjs` 与子路径的 `.js`（ESM）在 Node 中会走不同的加载器，
  //    各自独立产生模块实例 —— 在 step 5 的 identity 校验里永远不等。
  //    而 dev server 上游 (`resolveUrlToFile`) 优先选取 `.js`/`.mjs` 而非 `.cjs`，
  //    因此我们必须按入口实际格式去拿匹配的主入口，避免跨格式比较。
  const entryExt = path.extname(entryFile)
  const mainEntry = pickMainEntryByExtension(pkgDir, entryExt)
  if (!mainEntry) return null
  if (path.resolve(mainEntry) === path.resolve(entryFile)) return null

  // 4. 用 `import()` 加载两侧（兼容 CJS / ESM；Node 会按文件扩展名自动选用
  //    正确的加载器，并以 file URL 共享模块缓存 —— 内部对相对依赖的 `require`
  //    会命中同一份 module instance）
  let mainNs: Record<string, unknown>
  let subNs: Record<string, unknown>
  try {
    mainNs = await import(pathToFileURL(mainEntry).href)
    subNs = await import(pathToFileURL(entryFile).href)
  } catch {
    return null
  }
  if (!mainNs || typeof mainNs !== 'object') return null
  if (!subNs || typeof subNs !== 'object') return null

  const subKeys = Object.keys(subNs).filter(
    (k) => k !== '__esModule' && k !== 'default' && VALID_IDENT.test(k),
  )
  if (subKeys.length === 0) return null

  // 5. 所有具名导出都必须存在于主入口、且引用相等
  for (const k of subKeys) {
    if (!(k in mainNs)) return null
    if (mainNs[k] !== subNs[k]) return null
  }

  // 子路径的 default 也必须由主入口承载且引用相等，否则下方的
  // `export default __pkg["default"]` 会暴露错误（甚至 undefined）的 default。
  if ('default' in subNs) {
    if (!('default' in mainNs)) return null
    if (mainNs['default'] !== subNs['default']) return null
  }

  // 6. 生成 ESM shim：浏览器从 `/@modules/<pkgName>` 取到主 bundle 的命名空间，
  //    再按子路径所声明的导出名重新对外暴露
  const lines: string[] = [
    `// Nasti subpath shim → ${pkgName} (avoid duplicate bundling)`,
    `import * as __pkg from "/@modules/${pkgName}";`,
  ]
  for (const k of subKeys) {
    lines.push(`export const ${k} = __pkg[${JSON.stringify(k)}];`)
  }
  if ('default' in subNs) {
    lines.push(`export default ("default" in __pkg ? __pkg["default"] : __pkg);`)
  }
  return lines.join('\n') + '\n'
}

/**
 * 解析包主入口绝对路径，**优先匹配指定扩展名**，再回退到任意可用主入口。
 * 主入口候选来自 `exports[\".\"]`（按 import / module / default / require / node 顺序展开嵌套条件）
 * 以及顶层 `module` / `main` 字段。
 */
function pickMainEntryByExtension(pkgDir: string, preferredExt: string): string | null {
  const pkgJsonPath = path.join(pkgDir, 'package.json')
  let pkg: Record<string, any>
  try {
    pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'))
  } catch {
    return null
  }

  const candidates: string[] = []
  const collectFromExportObject = (obj: any) => {
    if (!obj || typeof obj !== 'object') return
    for (const cond of ['import', 'module', 'default', 'require', 'node']) {
      const v = obj[cond]
      if (typeof v === 'string') candidates.push(v)
      else if (v && typeof v === 'object') collectFromExportObject(v)
    }
  }
  const dot = pkg?.exports?.['.']
  if (typeof dot === 'string') candidates.push(dot)
  else if (dot && typeof dot === 'object') collectFromExportObject(dot)
  if (typeof pkg.module === 'string') candidates.push(pkg.module)
  if (typeof pkg.main === 'string') candidates.push(pkg.main)

  // 同扩展名优先
  for (const cand of candidates) {
    if (path.extname(cand) === preferredExt) {
      const full = path.resolve(pkgDir, cand)
      if (fs.existsSync(full)) return full
    }
  }
  // 任意可用候选
  for (const cand of candidates) {
    const full = path.resolve(pkgDir, cand)
    if (fs.existsSync(full)) return full
  }
  return null
}

/** 将 rolldown 生成的 __require("pkg") 调用转换为顶层 ESM import
 *  使用 namespace import + default 回退，兼容 CJS 和 ESM 模块：
 *  - CJS 包有 default export（__cjsMod）→ 取 .default
 *  - ESM 包只有 named exports → 取 namespace 本身 */
function rewriteExternalRequires(code: string): string {
  const pkgs = new Set<string>()
  const re = /__require\(["']([^"']+)["']\)/g
  let m
  while ((m = re.exec(code)) !== null) {
    pkgs.add(m[1])
  }
  if (pkgs.size === 0) return code

  let result = code
  const imports: string[] = []
  for (const pkg of pkgs) {
    const safe = pkg.replace(/[^a-zA-Z0-9_$]/g, '_')
    imports.push(`import * as __ns_${safe} from "/@modules/${pkg}";`)
    imports.push(`var __req_${safe} = "default" in __ns_${safe} ? __ns_${safe}["default"] : __ns_${safe};`)
    result = result.replaceAll(`__require("${pkg}")`, `__req_${safe}`)
    result = result.replaceAll(`__require('${pkg}')`, `__req_${safe}`)
  }

  return imports.join('\n') + '\n' + result
}

const VALID_IDENT = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/

async function injectCjsNamedExports(code: string, entryFile: string): Promise<string> {
  try {
    const { createRequire } = await import('module')
    const req = createRequire(entryFile)
    const cjsExports = req(entryFile)
    if (!cjsExports || (typeof cjsExports !== 'object' && typeof cjsExports !== 'function') || Array.isArray(cjsExports)) return code

    const namedKeys = Object.keys(cjsExports).filter(
      (k) => k !== '__esModule' && k !== 'default' && VALID_IDENT.test(k),
    )
    if (namedKeys.length === 0) return code

    // 把末尾的 "export default require_xxx();" 改写为带具名 export 的形式
    return code.replace(
      /^export default (\w+\(\));?\s*$/m,
      (_, call) => [
        `const __cjsMod = ${call};`,
        `export default __cjsMod;`,
        ...namedKeys.map((k) => `export const ${k} = __cjsMod[${JSON.stringify(k)}];`),
      ].join('\n'),
    )
  } catch {
    return code
  }
}

/**
 * 重写 import/export 语句的模块规范：
 *   - alias（如 `@/lib/api`）→ 解析后的项目内绝对 URL（带扩展名）
 *   - 相对路径（`./x`、`../x`）→ 同样解析后回写为绝对 URL
 *   - 项目内绝对路径（`/src/x`）→ 补扩展名
 *   - 其余 bare specifier → `/@modules/<spec>`
 *
 * 浏览器加载无扩展名 URL（如 `/src/i18n`）时，里面的相对路径 `./locales/en`
 * 会按字面拼接得到 `/src/locales/en`，不会自动补 `.ts` 也不知道导入文件原先在
 * `/src/i18n/`。直接按 alias / fs 解析、回写绝对 URL，浏览器就能命中正确文件。
 */
function rewriteImports(code: string, config: ResolvedConfig, filePath: string): string {
  const root = config.root
  const fileDir = path.dirname(filePath)
  // 按 key 长度降序：避免短 alias（如 `@`）抢在更具体的（如 `@/utils`）之前命中
  const aliasEntries = Object.entries(config.resolve.alias).sort(
    ([a], [b]) => b.length - a.length,
  )

  const toRootUrl = (abs: string): string =>
    '/' + path.relative(root, abs).replace(/\\/g, '/')

  const transformSpec = (spec: string): string => {
    // 解析时剥离 ?query / #hash（如 svg?url、json?import），回写时再附加到结果 URL
    const suffixMatch = spec.match(/[?#].*$/)
    const suffix = suffixMatch ? suffixMatch[0] : ''
    const baseSpec = suffix ? spec.slice(0, -suffix.length) : spec

    // 1) alias —— 必须排在 bare 分支前，否则 `@/x` 会被当成 npm 包发到 /@modules/
    for (const [key, value] of aliasEntries) {
      if (baseSpec === key || baseSpec.startsWith(key + '/')) {
        const aliasBase = resolveAliasTarget(value, root)
        const sub = baseSpec.slice(key.length).replace(/^\//, '')
        const target = sub ? path.join(aliasBase, sub) : aliasBase
        const resolved = tryResolveDiskPath(target)
        // 解析失败时保留原 spec：让浏览器照旧请求，由后续中间件返回 404，
        // 而不是把 `@/x` 错误地转成 `/@modules/@/x`。
        return resolved && isUnderRoot(resolved, root) ? toRootUrl(resolved) + suffix : spec
      }
    }

    // 2) 相对路径
    if (baseSpec.startsWith('./') || baseSpec.startsWith('../')) {
      const target = path.resolve(fileDir, baseSpec)
      const resolved = tryResolveDiskPath(target)
      return resolved && isUnderRoot(resolved, root) ? toRootUrl(resolved) + suffix : spec
    }

    // 3) 项目内绝对路径
    if (baseSpec.startsWith('/') && !baseSpec.startsWith('/@')) {
      const target = path.join(root, baseSpec.replace(/^\//, ''))
      const resolved = tryResolveDiskPath(target)
      return resolved && isUnderRoot(resolved, root) ? toRootUrl(resolved) + suffix : spec
    }

    // 4) 已经被前面步骤改写过的内部 URL（/@modules/、/@react-refresh 等）原样保留
    if (baseSpec.startsWith('/')) return spec

    // 5) bare specifier
    return `/@modules/${spec}`
  }

  return code
    // import ... from '...' / export ... from '...'
    .replace(
      /\bfrom\s+(['"])([^'"]+)\1/g,
      (_m, q: string, s: string) => `from ${q}${transformSpec(s)}${q}`,
    )
    // 副作用 import: import '...'
    .replace(
      /\bimport\s+(['"])([^'"]+)\1/g,
      (_m, q: string, s: string) => `import ${q}${transformSpec(s)}${q}`,
    )
    // 动态 import('...')
    .replace(
      /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
      (_m, q: string, s: string) => `import(${q}${transformSpec(s)}${q})`,
    )
}

/**
 * 把 alias 值统一成磁盘绝对路径。
 *   - `/Users/.../src` 这类绝对路径直接用
 *   - `/src` 这类用户写的「项目根相对」路径按 `<root>/src` 处理
 *   - 其余字符串相对 root 解析
 */
function resolveAliasTarget(value: string, root: string): string {
  if (path.isAbsolute(value) && fs.existsSync(value)) return value
  if (value.startsWith('/')) return path.join(root, value.slice(1))
  return path.resolve(root, value)
}

/** 把磁盘上的目标路径补全为存在的文件（扩展名 / index 兜底）。 */
function tryResolveDiskPath(target: string): string | null {
  if (fs.existsSync(target) && fs.statSync(target).isFile()) return target
  for (const ext of RESOLVE_EXTENSIONS) {
    const withExt = target + ext
    if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) return withExt
  }
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    for (const ext of RESOLVE_EXTENSIONS) {
      const idx = path.join(target, 'index' + ext)
      if (fs.existsSync(idx) && fs.statSync(idx).isFile()) return idx
    }
  }
  return null
}

/** alias 目标可能在 root 之外（symlink、monorepo），那种情况无法生成项目内 URL。 */
function isUnderRoot(abs: string, root: string): boolean {
  const rel = path.relative(root, abs)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

const RESOLVE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json', '.vue']
const ESM_CONDITIONS = ['import', 'browser', 'module', 'default']

/** 从 /@modules/pkgName/... URL 中提取包名（支持 scoped 包） */
function modulesUrlToPkgName(url: string): string {
  const modulePath = url.slice('/@modules/'.length).split('?')[0]
  if (modulePath.startsWith('@')) {
    return modulePath.split('/').slice(0, 2).join('/')
  }
  return modulePath.split('/')[0]
}

/** 从 root 开始向上查找包目录 */
function findPkgDir(root: string, pkgName: string): string | null {
  let dir = root
  for (;;) {
    const candidate = path.join(dir, 'node_modules', pkgName)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * 将 node_modules 文件中的相对导入改写为 /@modules/pkgName/subpath 形式。
 * 浏览器加载 /@modules/pkgName 时，相对路径 ./foo.js 会被解析为 /@modules/foo.js
 * 而非正确的 /@modules/pkgName/dist/foo.js，因此必须在服务端将其改写为绝对路径。
 */
function rewriteNodeModuleRelativeImports(
  code: string,
  pkgName: string,
  filePath: string,
  pkgDir: string,
): string {
  const fileDir = path.dirname(filePath)
  const rewrite = (spec: string): string => {
    const abs = path.resolve(fileDir, spec)
    const rel = path.relative(pkgDir, abs).replace(/\\/g, '/')
    return `/@modules/${pkgName}/${rel}`
  }
  return code
    .replace(/\bfrom\s+(['"])(\.\.?\/[^'"]*)\1/g, (_, q, spec) => `from ${q}${rewrite(spec)}${q}`)
    .replace(/\bimport\s+(['"])(\.\.?\/[^'"]*)\1/g, (_, q, spec) => `import ${q}${rewrite(spec)}${q}`)
    .replace(/\bimport\s*\(\s*(['"])(\.\.?\/[^'"]*)\1\s*\)/g, (_, q, spec) => `import(${q}${rewrite(spec)}${q})`)
}

/**
 * ESM-aware node_modules 解析：支持 package.json exports 字段的 import/browser/module/default 条件，
 * 兼容 ESM-only 包（如只有 "import" 条件而无 "require" 的包）。
 * createRequire 使用 CJS 解析逻辑，遇到 ESM-only exports 会抛异常，因此不能用于此场景。
 */
function resolveNodeModule(root: string, moduleName: string): string | null {
  // 解析包名和子路径（处理 scoped 包如 @scope/pkg/sub）
  let pkgName: string
  let subpath: string
  if (moduleName.startsWith('@')) {
    const parts = moduleName.split('/')
    pkgName = parts.slice(0, 2).join('/')
    subpath = parts.slice(2).join('/')
  } else {
    const slash = moduleName.indexOf('/')
    pkgName = slash === -1 ? moduleName : moduleName.slice(0, slash)
    subpath = slash === -1 ? '' : moduleName.slice(slash + 1)
  }

  // 向上查找 node_modules
  let pkgDir: string | null = null
  let dir = root
  for (;;) {
    const candidate = path.join(dir, 'node_modules', pkgName)
    if (fs.existsSync(candidate)) { pkgDir = candidate; break }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (!pkgDir) return null

  const pkgJsonPath = path.join(pkgDir, 'package.json')
  if (!fs.existsSync(pkgJsonPath)) return null
  let pkg: Record<string, any>
  try { pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) } catch { return null }

  // 优先使用 exports 字段（ESM-aware 条件解析）
  if (pkg.exports) {
    const exportKey = subpath ? `./${subpath}` : '.'
    const resolved = resolvePackageExports(pkg.exports, exportKey, pkgDir)
    if (resolved) return resolved
  }

  // 子路径直接文件
  if (subpath) {
    // 收集候选目录：包根目录 + module/main 字段所在的目录
    // 如 dom-helpers 的 module: 'esm/index.js'，子路径 addClass 应查找 esm/addClass.js
    const subDirs = ['']
    for (const field of ['module', 'main']) {
      if (typeof pkg[field] === 'string') {
        const dir = path.dirname(pkg[field])
        if (dir && dir !== '.' && !subDirs.includes(dir)) subDirs.push(dir)
      }
    }
    for (const dir of subDirs) {
      const direct = path.join(pkgDir, dir, subpath)
      if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct
      for (const ext of RESOLVE_EXTENSIONS) {
        if (fs.existsSync(direct + ext)) return direct + ext
      }
    }
    return null
  }

  // 主入口回退：module > main
  for (const field of ['module', 'jsnext:main', 'jsnext', 'main']) {
    if (typeof pkg[field] === 'string') {
      const entry = path.join(pkgDir, pkg[field])
      if (fs.existsSync(entry)) return entry
    }
  }

  // 最终回退：index.js
  const indexFallback = path.join(pkgDir, 'index.js')
  if (fs.existsSync(indexFallback)) return indexFallback

  return null
}

function resolvePackageExports(exports: any, key: string, pkgDir: string): string | null {
  if (typeof exports === 'string') {
    return key === '.' ? path.join(pkgDir, exports) : null
  }
  const entry = exports[key]
  if (entry === undefined) return null
  return resolveExportValue(entry, pkgDir)
}

function resolveExportValue(value: any, pkgDir: string): string | null {
  if (typeof value === 'string') return path.join(pkgDir, value)
  if (Array.isArray(value)) {
    for (const item of value) {
      const r = resolveExportValue(item, pkgDir)
      if (r) return r
    }
    return null
  }
  if (value && typeof value === 'object') {
    for (const cond of ESM_CONDITIONS) {
      if (cond in value) {
        const r = resolveExportValue(value[cond], pkgDir)
        if (r) return r
      }
    }
  }
  return null
}

function resolveUrlToFile(url: string, root: string): string | null {
  // 去除查询参数
  const cleanUrl = url.split('?')[0]

  // /@modules/ 前缀 → node_modules 预构建
  if (cleanUrl.startsWith('/@modules/')) {
    const moduleName = cleanUrl.slice('/@modules/'.length)
    return resolveNodeModule(root, moduleName)
  }

  // 普通路径
  const filePath = path.resolve(root, cleanUrl.replace(/^\//, ''))

  // 精确路径存在
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return filePath
  }

  // 扩展名补全（处理无扩展名导入，如 ./App → ./App.tsx）
  for (const ext of RESOLVE_EXTENSIONS) {
    const withExt = filePath + ext
    if (fs.existsSync(withExt)) return withExt
  }

  // 目录 index 文件（如 ./utils → ./utils/index.ts）
  for (const ext of RESOLVE_EXTENSIONS) {
    const indexFile = path.join(filePath, 'index' + ext)
    if (fs.existsSync(indexFile)) return indexFile
  }

  return null
}

function isModuleRequest(url: string): boolean {
  const cleanUrl = url.split('?')[0]
  if (/\.(ts|tsx|jsx|js|mjs|vue|css|json)$/.test(cleanUrl)) return true
  if (cleanUrl.startsWith('/@modules/')) return true
  // 无扩展名路径可能是省略扩展名的模块导入（如 /src/App）
  if (!path.extname(cleanUrl)) return true
  return false
}

function getHmrClientCode(): string {
  return `
// Nasti HMR Client
const socket = new WebSocket(\`ws://\${location.host}\`, 'nasti-hmr');
const hotModulesMap = new Map();
const disposeMap = new Map();
const pruneMap = new Map();

socket.addEventListener('message', ({ data }) => {
  const payload = JSON.parse(data);
  switch (payload.type) {
    case 'connected':
      console.log('[nasti] connected.');
      clearErrorOverlay();
      break;
    case 'update':
      payload.updates.forEach((update) => {
        if (update.type === 'js-update') {
          fetchUpdate(update);
        } else if (update.type === 'css-update') {
          updateCss(update.path);
        }
      });
      clearErrorOverlay();
      break;
    case 'full-reload':
      console.log('[nasti] full reload');
      location.reload();
      break;
    case 'prune':
      payload.paths.forEach((p) => {
        const cb = pruneMap.get(p);
        if (cb) cb();
      });
      break;
    case 'error':
      console.error('[nasti] error:', payload.err.message);
      showErrorOverlay(payload.err);
      break;
  }
});

// 自动重连（断线时指数退避）
let reconnectTimer = 0;
socket.addEventListener('close', () => {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => location.reload(), 1000);
});

async function fetchUpdate(update) {
  const mod = hotModulesMap.get(update.path);
  // 先跑 dispose（给模块机会清理副作用）
  const dispose = disposeMap.get(update.path);
  if (dispose) dispose();

  const newMod = await import(update.acceptedPath + '?t=' + update.timestamp);
  if (mod) {
    // 复制回调数组避免回调内部又修改 hotModulesMap 造成迭代异常
    [...mod.callbacks].forEach((cb) => cb(newMod));
  }
}

function updateCss(path) {
  const el = document.querySelector(\`style[data-nasti-css="\${path}"]\`);
  if (el) {
    fetch(path + '?t=' + Date.now())
      .then(r => r.text())
      .then(css => { el.textContent = css; });
  }
}

function clearErrorOverlay() {
  const el = document.getElementById('nasti-error-overlay');
  if (el) el.remove();
}

function showErrorOverlay(err) {
  clearErrorOverlay();
  const overlay = document.createElement('div');
  overlay.id = 'nasti-error-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.85);color:#fff;font-family:monospace;padding:2rem;overflow:auto;';
  const title = document.createElement('h2');
  title.style.color = '#ff5555';
  title.textContent = 'Build Error';
  const pre = document.createElement('pre');
  pre.textContent = err.message + '\\n' + (err.stack || '');
  const btn = document.createElement('button');
  btn.style.cssText = 'margin-top:1rem;padding:0.5rem 1rem;cursor:pointer';
  btn.textContent = 'Close';
  btn.onclick = () => overlay.remove();
  overlay.appendChild(title);
  overlay.appendChild(pre);
  overlay.appendChild(btn);
  document.body.appendChild(overlay);
}

/**
 * 生成 import.meta.hot 的 hot context。
 * 关键约束：同一 ownerPath 的 accept 回调必须替换（不是 append）。
 * 每次模块重新 import 都会调用 createHotContext，旧回调会被 fetchUpdate 调用后立即被新 import
 * 里的 accept 替换。不替换的话每编辑一次就多一个回调，越跑越慢。
 */
export function createHotContext(ownerPath) {
  return {
    accept(deps, callback) {
      // 自接受: hot.accept() 或 hot.accept(callback)
      if (typeof deps === 'function' || deps === undefined) {
        hotModulesMap.set(ownerPath, { callbacks: [deps || (() => {})] });
        return;
      }
      // 依赖接受: hot.accept(deps, callback)，多次调用追加
      const existing = hotModulesMap.get(ownerPath)?.callbacks ?? [];
      hotModulesMap.set(ownerPath, { callbacks: [...existing, callback] });
    },
    prune(callback) {
      pruneMap.set(ownerPath, callback);
    },
    dispose(callback) {
      disposeMap.set(ownerPath, callback);
    },
    invalidate() {
      location.reload();
    },
    data: {},
  };
}
`
}
