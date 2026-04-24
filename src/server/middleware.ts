// HTTP 中间件 - 请求拦截与按需转译
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
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
  let cjsPath: string
  try {
    // 先在 Nasti 自己安装目录下找
    cjsPath = __require.resolve('react-refresh/cjs/react-refresh-runtime.development.js')
  } catch {
    // 兜底：从 dist 向上找
    cjsPath = path.resolve(__dirname_esm, '../../node_modules/react-refresh/cjs/react-refresh-runtime.development.js')
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

  // 重写 bare imports 为浏览器可用路径
  code = rewriteImports(code, config)

  const transformResult = { code }
  mod.transformResult = transformResult
  return transformResult
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

/** 重写 import/export 语句中的 bare specifier */
function rewriteImports(code: string, _config: ResolvedConfig): string {
  // 处理所有 from '...' 形式（import ... from、export ... from、export * from）
  return code.replace(
    /\bfrom\s+(['"])([^'"./][^'"]*)\1/g,
    (match, quote: string, specifier: string) => {
      return `from ${quote}/@modules/${specifier}${quote}`
    },
  ).replace(
    // 处理纯副作用导入: import 'bare-specifier'
    /\bimport\s+(['"])([^'"./][^'"]*)\1/g,
    (match, quote: string, specifier: string) => {
      return `import ${quote}/@modules/${specifier}${quote}`
    },
  ).replace(
    // 处理动态导入: import('bare-specifier')
    /\bimport\s*\(\s*(['"])([^'"./][^'"]*)\1\s*\)/g,
    (match, quote: string, specifier: string) => {
      return `import(${quote}/@modules/${specifier}${quote})`
    },
  )
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
