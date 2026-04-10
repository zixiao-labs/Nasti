// HTTP 中间件 - 请求拦截与按需转译
import path from 'node:path'
import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ResolvedConfig } from '../types.js'
import { PluginContainer } from '../core/plugin-container.js'
import { ModuleGraph } from '../core/module-graph.js'
import { transformCode, shouldTransform, getModuleType } from '../core/transformer.js'
import { readHtmlFile, processHtml } from '../plugins/html.js'
import { loadEnv, buildEnvDefine, replaceEnvInCode } from '../core/env.js'

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

  // 检查缓存
  const cached = moduleGraph.getModuleByUrl(url)
  if (cached?.transformResult) {
    return cached.transformResult as { code: string; map?: unknown }
  }

  // 解析文件路径
  const filePath = resolveUrlToFile(url, config.root)
  if (!filePath || !fs.existsSync(filePath)) return null

  // 创建/获取模块节点
  const mod = await moduleGraph.ensureEntryFromUrl(url)
  moduleGraph.registerModule(mod, filePath)

  // node_modules 模块：用 rolldown 打成浏览器可用的 ESM
  // 解决 CJS 包（如 react）无法在浏览器中作为 ESM 使用的问题
  const cleanReqUrl = url.split('?')[0]
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

  // OXC 转译 (TS/JSX/TSX)
  if (shouldTransform(filePath)) {
    const result = transformCode(filePath, code, {
      sourcemap: true,
      jsxRuntime: 'automatic',
      jsxImportSource: config.framework === 'vue' ? 'vue' : 'react',
      reactRefresh: config.framework !== 'vue',
    })
    code = result.code
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

/** 将 rolldown 生成的 __require("pkg") 调用转换为顶层 ESM import */
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
    imports.push(`import __req_${safe} from "/@modules/${pkg}";`)
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
    const direct = path.join(pkgDir, subpath)
    if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct
    for (const ext of RESOLVE_EXTENSIONS) {
      if (fs.existsSync(direct + ext)) return direct + ext
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

socket.addEventListener('message', ({ data }) => {
  const payload = JSON.parse(data);
  switch (payload.type) {
    case 'connected':
      console.log('[nasti] connected.');
      break;
    case 'update':
      payload.updates.forEach((update) => {
        if (update.type === 'js-update') {
          fetchUpdate(update);
        } else if (update.type === 'css-update') {
          updateCss(update.path);
        }
      });
      break;
    case 'full-reload':
      console.log('[nasti] full reload');
      location.reload();
      break;
    case 'error':
      console.error('[nasti] error:', payload.err.message);
      showErrorOverlay(payload.err);
      break;
  }
});

async function fetchUpdate(update) {
  const mod = hotModulesMap.get(update.path);
  if (mod) {
    const newMod = await import(update.acceptedPath + '?t=' + update.timestamp);
    mod.callbacks.forEach((cb) => cb(newMod));
  } else {
    // 没有注册 hot 回调，尝试重新 import
    await import(update.path + '?t=' + update.timestamp);
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

function showErrorOverlay(err) {
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

// import.meta.hot API
const createHotContext = (ownerPath) => ({
  accept(deps, callback) {
    if (typeof deps === 'function' || !deps) {
      // self-accepting
      const callbacks = hotModulesMap.get(ownerPath)?.callbacks || [];
      callbacks.push(deps || (() => {}));
      hotModulesMap.set(ownerPath, { callbacks });
    }
  },
  prune(callback) {
    // 模块被移除时执行
  },
  dispose(callback) {
    // 模块更新前执行清理
  },
  invalidate() {
    location.reload();
  },
  data: {},
});

// 暴露给模块使用
if (!window.__nasti_hot_map) window.__nasti_hot_map = new Map();
window.__NASTI_HMR__ = { createHotContext };
`
}
