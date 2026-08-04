// HTTP 中间件 - 请求拦截与按需转译
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import pc from 'picocolors'
import type { EnvironmentInstance, ResolvedConfig } from '../types.js'
import { PluginContainer } from '../core/plugin-container.js'
import { ModuleGraph } from '../core/module-graph.js'
import { transformCode, shouldTransform, getModuleType } from '../core/transformer.js'
import { readHtmlFile, processHtml } from '../plugins/html.js'
import {
  loadEnv,
  buildEnvDefine,
  replaceEnvInCode,
  ssrDefineOverrides,
} from '../core/env.js'
import { removeTimestampQuery } from '../core/url.js'
import { isAssetFile } from '../plugins/assets.js'
import { isAllowedDevModulePath, isUnderRoot, getLinkedPackageRoots } from './fs-allow.js'

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
export function getReactRefreshRuntimeEsm(includeBoundaryHelpers = false): string {
  if (__refreshRuntimeCache) {
    return includeBoundaryHelpers
      ? __refreshRuntimeCache + REACT_REFRESH_BOUNDARY_HELPERS
      : __refreshRuntimeCache
  }
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
  return includeBoundaryHelpers
    ? __refreshRuntimeCache + REACT_REFRESH_BOUNDARY_HELPERS
    : __refreshRuntimeCache
}

/** @vitejs/plugin-react 同类的 Refresh boundary 校验，避免非组件导出静默保持旧值。 */
const REACT_REFRESH_BOUNDARY_HELPERS = `
function __nastiIsPlainObject(obj) {
  return Object.prototype.toString.call(obj) === '[object Object]' &&
    (obj.constructor === Object || obj.constructor === undefined);
}
function __nastiIsCompoundComponent(type) {
  if (!__nastiIsPlainObject(type)) return false;
  for (const key in type) {
    if (!isLikelyComponentType(type[key])) return false;
  }
  return true;
}
export function registerExportsForReactRefresh(filename, moduleExports) {
  for (const key in moduleExports) {
    if (key === '__esModule') continue;
    const value = moduleExports[key];
    if (isLikelyComponentType(value)) {
      register(value, filename + ' export ' + key);
    } else if (__nastiIsCompoundComponent(value)) {
      for (const subKey in value) {
        register(value[subKey], filename + ' export ' + key + '-' + subKey);
      }
    }
  }
}
let __nastiRefreshTimer;
function __nastiEnqueueRefresh() {
  clearTimeout(__nastiRefreshTimer);
  __nastiRefreshTimer = setTimeout(() => performReactRefresh(), 16);
}
function __nastiCheckExports(ignored, exports, predicate) {
  for (const key in exports) {
    if (ignored.includes(key)) continue;
    if (!predicate(key, exports[key])) return key;
  }
  return true;
}
export function validateRefreshBoundaryAndEnqueueUpdate(id, prevExports, nextExports) {
  const ignored = window.__getReactRefreshIgnoredExports?.({ id }) ?? [];
  if (__nastiCheckExports(ignored, prevExports, (key) => key in nextExports) !== true) {
    return 'Could not Fast Refresh (export removed)';
  }
  if (__nastiCheckExports(ignored, nextExports, (key) => key in prevExports) !== true) {
    return 'Could not Fast Refresh (new export)';
  }
  let hasExports = false;
  const compatible = __nastiCheckExports(ignored, nextExports, (key, value) => {
    hasExports = true;
    return isLikelyComponentType(value) ||
      __nastiIsCompoundComponent(value) ||
      prevExports[key] === value;
  });
  if (!hasExports) {
    return 'Could not Fast Refresh (no exports)';
  }
  if (compatible === true) {
    __nastiEnqueueRefresh();
    return;
  }
  return 'Could not Fast Refresh ("' + compatible + '" export is incompatible)';
}
export const __hmr_import = (module) => import(module);
`

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
  let __nasti_current_exports__;
  __nasti_hot__.accept((nextExports) => {
    if (!nextExports) return;
    if (!__nasti_current_exports__) {
      __nasti_hot__.invalidate('Could not Fast Refresh (previous exports unavailable)');
      return;
    }
    const invalidateMessage = RefreshRuntime.validateRefreshBoundaryAndEnqueueUpdate(
      ${urlLit},
      __nasti_current_exports__,
      nextExports,
    );
    if (invalidateMessage) __nasti_hot__.invalidate(invalidateMessage);
  });
  RefreshRuntime.__hmr_import(import.meta.url).then((currentExports) => {
    __nasti_current_exports__ = currentExports;
    RefreshRuntime.registerExportsForReactRefresh(${urlLit}, currentExports);
  });
}
`
}

/**
 * 非 JSX 模块里用户显式写了 import.meta.hot —— 注入一段 hot context 头部并替换属性访问为本地变量。
 */
function injectImportMetaHot(code: string, moduleUrl: string): string {
  const hotRE = /\bimport\.meta\.hot\b/g
  const matches = [...maskStringsAndComments(code).matchAll(hotRE)]
  if (matches.length === 0) return code

  for (const match of matches.reverse()) {
    const start = match.index
    code = code.slice(0, start) + '__nasti_hot__' + code.slice(start + match[0].length)
  }
  const urlLit = JSON.stringify(moduleUrl)
  const header = `import { createHotContext as __nasti_createHotContext__ } from "/@nasti/client";
const __nasti_hot__ = __nasti_createHotContext__(${urlLit});
`
  return header + code
}

export interface TransformMiddlewareContext {
  config: ResolvedConfig
  pluginContainer: PluginContainer
  moduleGraph: ModuleGraph
  environment?: EnvironmentInstance
  envDefine?: Record<string, string>
  onPrune?: (paths: string[]) => void
}

/** 主转译中间件 - 处理模块请求 */
export function transformMiddleware(ctx: TransformMiddlewareContext) {
  // 预加载环境变量，避免每次请求都重新读取 .env 文件
  ctx.envDefine = buildEnvDefine(
    loadEnv(ctx.config.mode, ctx.config.root, ctx.config.envPrefix),
    ctx.config.mode,
    ssrDefineOverrides(ctx.environment?.consumer ?? 'client'),
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
      const html = await readHtmlFile(
        ctx.config.root,
        ctx.config.environments.client?.html,
      )
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
    if (isModuleRequest(url, req.headers['sec-fetch-dest'])) {
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
        ctx.config.logger.error(
          pc.red(`Transform error: ${url}\n`) + (err.stack ?? err.message),
          { timestamp: true, error: err },
        )
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

  // HMR 的时间戳只用于绕过浏览器缓存，不能创建新的模块图节点或 hot context。
  url = removeTimestampQuery(url)
  const cleanReqUrl = url.split('?')[0]

  // 检查缓存
  const cached = moduleGraph.getModuleByUrl(url)
  if (cached?.transformResult) {
    return cached.transformResult as { code: string; map?: unknown }
  }

  // React Refresh 真实运行时（来自 react-refresh/cjs 包装为 ESM）
  if (cleanReqUrl === '/@react-refresh') {
    return { code: getReactRefreshRuntimeEsm(true) }
  }

  // `/@modules/<spec>?id=<abs>`：打包阶段已（相对 importer 真实目录）解析好的依赖文件。
  // 直接按该绝对路径打成 ESM，跳过 `resolveNodeModule(root, ...)` —— pnpm 严格布局下
  // 传递依赖不在顶层 node_modules，从 root 解析必然 404。`id` 由 externalSpecToModuleUrl /
  // subpath shim 用 encodeURIComponent 写入，URLSearchParams.get 自动解码（含 pnpm 路径里的 `+`）。
  if (cleanReqUrl.startsWith('/@modules/') && url.includes('?')) {
    const idParam = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('id')
    // 安全校验：`?id=` 本应只由我们自己写入（externalSpecToModuleUrl / subpath shim
    // 解析到的依赖真实文件），但浏览器或恶意页面可向 dev server 伪造任意绝对路径。
    // 解析真实路径后必须 (a) 是普通文件、(b) 落在 node_modules / 项目根 / 经
    // node_modules symlink 可达的 workspace·file: 包内，否则拒绝 —— 防止借此把
    // /etc/passwd、~/.ssh/* 等任意磁盘文件打成 ESM 读出去。
    let realId: string | null = null
    let realIdValid = false
    try {
      if (idParam) {
        realId = fs.realpathSync(idParam)
        // statSync 可能在 realpathSync 之后、检查之前因文件被删 / 权限变更而抛错（TOCTOU）。
        // 与上面的 realpathSync 一样按「校验失败」处理：落到下面的解析分支，而非把
        // 文件系统竞态变成 500（HTTP 路径）或向 server.transformRequest 调用方抛异常。
        realIdValid =
          fs.statSync(realId).isFile() && isAllowedDevModulePath(realId, config.root)
      }
    } catch {
      realId = null
      realIdValid = false
    }
    if (realId && realIdValid) {
      const mod = await moduleGraph.ensureEntryFromUrl(url)
      moduleGraph.registerModule(mod, realId)
      const code = await bundlePackageAsEsm(realId, config.root)
      const transformResult = { code }
      mod.transformResult = transformResult
      return transformResult
    }
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

  // 带「语义 query」的模块请求（如 Vue style 子块
  // `/abs/App.vue?vue&type=style&index=0&lang.css`）：先问插件的 load → transform
  // 管道，**不要求磁盘上存在对应文件**（虚拟子模块）。默认的"读盘 + 剥 query"
  // 路径会把子模块错当成父模块整体重新编译（1.x 的 Vue dev 样式因此从未生效）。
  // `?t=`（HMR 时间戳）除外。
  const rawQuery = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
  if (rawQuery && !/^t=\d+$/.test(rawQuery)) {
    const mod = await moduleGraph.ensureEntryFromUrl(url)
    const transformVersion = mod.invalidationVersion
    const loaded = await pluginContainer.load(url)
    if (loaded != null) {
      let code = typeof loaded === 'string' ? loaded : loaded.code
      let map = typeof loaded === 'string' ? undefined : loaded.map
      const transformed = await pluginContainer.transform(code, url)
      if (transformed != null) {
        code = typeof transformed === 'string' ? transformed : transformed.code
        if (typeof transformed !== 'string' && transformed.map != null) {
          map = transformed.map
        }
      }
      // file 关联磁盘上的父文件：父文件变更时子模块一并失效
      const parentFile = resolveUrlToFile(cleanReqUrl, config.root) ?? cleanReqUrl
      moduleGraph.registerModule(mod, parentFile)
      const hotInfo = rewriteHotAcceptDeps(code, config, parentFile)
      code = injectImportMetaHot(hotInfo.code, url)
      code = replaceEnvInCode(code, ctx.envDefine ?? buildEnvDefine(
        loadEnv(config.mode, config.root, config.envPrefix),
        config.mode,
        ssrDefineOverrides(ctx.environment?.consumer ?? 'client'),
      ))
      const importedUrls = new Set<string>()
      code = rewriteImports(code, config, parentFile, importedUrls, moduleGraph)
      const pruned = await moduleGraph.updateModuleInfo(
        mod,
        importedUrls,
        hotInfo.acceptedUrls,
        hotInfo.isSelfAccepting,
        transformVersion,
      )
      const transformResult = { code, map }
      if (pruned) {
        if (pruned.size > 0) ctx.onPrune?.([...pruned].map((item) => item.url))
        mod.transformResult = transformResult
      }
      return transformResult
    }
  }

  // 解析文件路径
  const filePath = resolveUrlToFile(url, config.root)
  if (!filePath || !fs.existsSync(filePath)) return null

  // 创建/获取模块节点
  const mod = await moduleGraph.ensureEntryFromUrl(url)
  moduleGraph.registerModule(mod, filePath)
  const transformVersion = mod.invalidationVersion

  // node_modules 模块：用 rolldown 打成浏览器可用的 ESM
  // 解决 CJS 包（如 react）无法在浏览器中作为 ESM 使用的问题
  if (cleanReqUrl.startsWith('/@modules/')) {
    const code = await bundlePackageAsEsm(filePath, config.root)
    const transformResult = { code }
    mod.transformResult = transformResult
    return transformResult
  }

  // 先允许 assets 等专用 loader 把真实文件转换为 JS；无插件接管再读源码。
  const loaded = await pluginContainer.load(filePath)
  let code =
    loaded == null
      ? fs.readFileSync(filePath, 'utf-8')
      : typeof loaded === 'string'
        ? loaded
        : loaded.code
  let map: unknown = loaded && typeof loaded !== 'string' ? loaded.map : undefined

  // 通过插件管道 transform
  const pluginResult = await pluginContainer.transform(code, filePath)
  if (pluginResult) {
    code = typeof pluginResult === 'string' ? pluginResult : pluginResult.code
    if (typeof pluginResult !== 'string') map = pluginResult.map
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
      target: ctx.environment?.options.build.target ?? config.build.target,
    })
    code = result.code
    if (result.map) map = JSON.parse(result.map)
    if (useRefresh) {
      // 把模块包装起来：安装 $RefreshReg$/$RefreshSig$、建 hot context、尾部触发 performReactRefresh
      code = buildReactRefreshWrapper(stableUrl, code)
      wrappedWithRefresh = true
    }
  }

  // 服务端与客户端必须使用同一组规范化 accept URL；否则消息里的 acceptedPath
  // 无法命中浏览器中注册的依赖回调。
  const hotInfo = rewriteHotAcceptDeps(code, config, filePath)
  code = hotInfo.code

  // 非 Fast-Refresh 模块里用户自己写了 import.meta.hot 的，注入 hot context
  if (!wrappedWithRefresh) {
    code = injectImportMetaHot(code, stableUrl)
  }

  // 替换 import.meta.env.* 为实际值
  const envDefine = ctx.envDefine ?? buildEnvDefine(
    loadEnv(config.mode, config.root, config.envPrefix),
    config.mode,
    ssrDefineOverrides(ctx.environment?.consumer ?? 'client'),
  )
  code = replaceEnvInCode(code, envDefine)

  // 重写 import 规范并同步模块图。变更后重新转换 importer 时，会给失效依赖追加
  // 时间戳，使浏览器真正重新执行依赖，而不是复用旧的 ESM Module Record。
  const importedUrls = new Set<string>()
  code = rewriteImports(code, config, filePath, importedUrls, moduleGraph)
  const pruned = await moduleGraph.updateModuleInfo(
    mod,
    importedUrls,
    hotInfo.acceptedUrls,
    wrappedWithRefresh || hotInfo.isSelfAccepting,
    transformVersion,
  )

  const transformResult = { code, map }
  if (pruned) {
    if (pruned.size > 0) ctx.onPrune?.([...pruned].map((item) => item.url))
    mod.transformResult = transformResult
  }
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
    ssrDefineOverrides(ctx.environment?.consumer ?? 'client'),
  ))
  const anchor = path.join(config.root, '__nasti_virtual__.ts')
  code = rewriteImports(code, config, anchor)

  return { id: resolvedId, result: { code } }
}

/** 用 rolldown 将 node_modules 包打包为浏览器可用的 ESM（含 CJS→ESM 转换） */
// Promise 缓存：同一入口文件只打包一次，防止并发重复打包
const esmBundleCache = new Map<string, Promise<string>>()

async function bundlePackageAsEsm(entryFile: string, root: string): Promise<string> {
  if (!esmBundleCache.has(entryFile)) {
    esmBundleCache.set(entryFile, doBundlePackage(entryFile, root))
  }
  return esmBundleCache.get(entryFile)!
}

async function doBundlePackage(entryFile: string, root: string): Promise<string> {
  // 子路径入口（如 `react-aria-components/Select`）尝试生成 re-export shim，
  // 指向同包主入口。否则每个子路径会被 rolldown 各自打成独立 bundle，
  // 把同一份 `private/*.cjs` 内联多份 → 多个 `createContext(null)` 实例 →
  // React Aria 之类对 context identity 敏感的库会出现「provider 与 consumer
  // 看到的不是同一个 context」、`useContext` 返回 null 的运行期崩溃。
  // 详见: https://github.com/zixiao-labs/Nasti/pull/16
  const shim = await tryGenerateSubpathShim(entryFile, root)
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

  // 将外部化的 bare specifier 改写为 /@modules/ 路径供浏览器加载。
  // 解析相对「本包自身的真实目录」进行（externalSpecToModuleUrl），以兼容 pnpm
  // 严格布局下未被提升到顶层 node_modules 的传递依赖。
  // ⚠️ 必须用 ^ + m 锚定行首，只匹配真正的 import/export 声明，
  // 避免误匹配字符串内出现的 from "..." 导致 SyntaxError
  const externalBaseDir = path.dirname(entryFile)
  code = code
    .replace(/^(import\b[^;'"]*?\bfrom\s+)(['"])([^'"./][^'"]*)(\2)/gm,
      (_, prefix, q, spec) => `${prefix}${q}${externalSpecToModuleUrl(spec, externalBaseDir, root)}${q}`)
    .replace(/^(export\b[^;'"]*?\bfrom\s+)(['"])([^'"./][^'"]*)(\2)/gm,
      (_, prefix, q, spec) => `${prefix}${q}${externalSpecToModuleUrl(spec, externalBaseDir, root)}${q}`)
    .replace(/^(import\s+)(['"])([^'"./][^'"]*)(\2)/gm,
      (_, prefix, q, spec) => `${prefix}${q}${externalSpecToModuleUrl(spec, externalBaseDir, root)}${q}`)

  // CJS 外部 require 改写：
  // rolldown 将 CJS 的 require("pkg") 转为 __require("pkg")，在浏览器中抛异常。
  // 收集所有 __require("pkg")，替换为顶层 ESM import 的变量引用。
  code = rewriteExternalRequires(code, externalBaseDir, root)

  // CJS 包的具名导出补全 + ESM-interop default 解包：
  // rolldown 将 CJS 包包装为 __commonJSMin，只输出 `export default require_xxx()`，
  // 该调用返回的是整个 CJS exports 对象。这会引发两类问题：
  //   1. 具名导入失败：`import { parse } from '/@modules/cookie'` 没有静态命名导出。
  //   2. default 错误：当 CJS 模块自标 `__esModule: true` 且有 `default`
  //      (tsc/babel 编译 ESM→CJS 的典型产物，如 `@gravity-ui/icons/Sun`)，
  //      `import X from '...'` 会拿到整个 namespace 对象而不是真正的 default 值，
  //      在 React 中表现为 "Element type is invalid... got: object"。
  // 通过 createRequire 在 Node.js 侧加载 CJS 模块、读取 exports，在 bundle
  // 末尾补具名 export，并按 Node import() interop 语义解包 default。
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
async function tryGenerateSubpathShim(entryFile: string, root: string): Promise<string | null> {
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
  //    再按子路径所声明的导出名重新对外暴露。
  //    主入口 URL 必须与「其他模块对该包主入口的裸 import」命中同一个浏览器模块实例
  //    —— 这正是 shim 去重 context（避免出现两份 `createContext`）的前提，见 PR #16。
  //    rewriteImports 把用户源码里的裸 import 改写成裸 `/@modules/<pkgName>`，所以当该包
  //    主入口能从项目根解析、且解析到的就是当前这份包目录（同一版本实例）时，shim 也必须
  //    用裸 URL —— 浏览器按 URL 字符串去重，带 `?id=` 会被当成另一个模块而重复实例化。
  //    否则（pnpm 下未提升到顶层的传递依赖，或根部命中的是另一个版本）才回落到 `?id=`
  //    携带绝对路径，既避免 dev server 从 root 解析 404，也不会串到错误版本。
  const rootMain = resolveNodeModule(root, pkgName)
  const mainEntryUrl =
    rootMain && rootMain.startsWith(pkgDir + path.sep)
      ? `/@modules/${pkgName}`
      : `/@modules/${pkgName}?id=${encodeURIComponent(mainEntry)}`
  const lines: string[] = [
    `// Nasti subpath shim → ${pkgName} (avoid duplicate bundling)`,
    `import * as __pkg from "${mainEntryUrl}";`,
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
function rewriteExternalRequires(code: string, baseDir: string, root: string): string {
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
    imports.push(`import * as __ns_${safe} from "${externalSpecToModuleUrl(pkg, baseDir, root)}";`)
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

    // ESM-interop unwrap: when the CJS module marks itself as `__esModule` and
    // exposes a `default` (typical for tsc/babel-compiled ESM emitted as CJS),
    // rolldown's `export default require_xxx()` would expose the entire CJS
    // namespace object instead of the inner `.default` — so `import X from "pkg/sub"`
    // hands the consumer `{ __esModule: true, default: X }` rather than `X`,
    // which breaks `<X />` in React with "Element type is invalid ... got: object".
    // Mirror Node's `import()` interop and unwrap to `__cjsMod.default`.
    const hasEsmInterop = cjsExports.__esModule === true && 'default' in cjsExports

    if (!hasEsmInterop && namedKeys.length === 0) return code

    // 把末尾的 "export default require_xxx();" 改写为带具名 export 的形式
    return code.replace(
      /^export default (\w+\(\));?\s*$/m,
      (_, call) => [
        `const __cjsMod = ${call};`,
        hasEsmInterop ? `export default __cjsMod.default;` : `export default __cjsMod;`,
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
function rewriteImports(
  code: string,
  config: ResolvedConfig,
  filePath: string,
  importedUrls?: Set<string>,
  moduleGraph?: ModuleGraph,
): string {
  const resolveSpec = createModuleSpecifierResolver(config, filePath)
  const transformSpec = (spec: string): string => {
    const resolved = removeTimestampQuery(resolveSpec(spec))
    importedUrls?.add(resolved)
    const timestamp = moduleGraph?.getModuleByUrl(resolved)?.lastHMRTimestamp ?? 0
    return timestamp > 0 ? appendTimestampQuery(resolved, timestamp) : resolved
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

function createModuleSpecifierResolver(
  config: ResolvedConfig,
  filePath: string,
): (specifier: string) => string {
  const root = config.root
  const fileDir = path.dirname(filePath)
  const aliasEntries = Object.entries(config.resolve.alias).sort(
    ([a], [b]) => b.length - a.length,
  )
  const toServableUrl = (abs: string): string | null => {
    if (isUnderRoot(abs, root)) {
      return '/' + path.relative(root, abs).replace(/\\/g, '/')
    }
    // Workspace / file: packages live outside root after realpath. Serve via
    // `/@fs/<abs>` (Vite-compatible) when the path is under a linked package.
    // Always use `/@fs/` so Windows drive paths become `/@fs/C:/...`, not `/@fsC:/...`.
    for (const pkgRoot of getLinkedPackageRoots(root)) {
      if (abs === pkgRoot || abs.startsWith(pkgRoot + path.sep)) {
        const normalized = abs.replace(/\\/g, '/')
        return '/@fs/' + (normalized.startsWith('/') ? normalized.slice(1) : normalized)
      }
    }
    return null
  }

  return (specifier: string): string => {
    // 解析时剥离 ?query / #hash（如 svg?url、json?import），回写时再附加到结果 URL
    const suffixMatch = specifier.match(/[?#].*$/)
    const suffix = suffixMatch ? suffixMatch[0] : ''
    const baseSpec = suffix ? specifier.slice(0, -suffix.length) : specifier

    // 1) alias —— 必须排在 bare 分支前，否则 `@/x` 会被当成 npm 包发到 /@modules/
    for (const [key, value] of aliasEntries) {
      if (baseSpec === key || baseSpec.startsWith(key + '/')) {
        const aliasBase = resolveAliasTarget(value, root)
        const sub = baseSpec.slice(key.length).replace(/^\//, '')
        const target = sub ? path.join(aliasBase, sub) : aliasBase
        const resolved = tryResolveDiskPath(target)
        const url = resolved ? toServableUrl(resolved) : null
        return url ? url + suffix : specifier
      }
    }

    // 2) 相对路径
    if (baseSpec.startsWith('./') || baseSpec.startsWith('../')) {
      const resolved = tryResolveDiskPath(path.resolve(fileDir, baseSpec))
      const url = resolved ? toServableUrl(resolved) : null
      return url ? url + suffix : specifier
    }

    // 3) 项目内绝对路径
    if (baseSpec.startsWith('/') && !baseSpec.startsWith('/@')) {
      const resolved = tryResolveDiskPath(path.join(root, baseSpec.replace(/^\//, '')))
      const url = resolved ? toServableUrl(resolved) : null
      return url ? url + suffix : specifier
    }

    // 4) 已改写的内部 URL 原样保留；其余 bare specifier 交给包中间件。
    if (baseSpec.startsWith('/')) return specifier
    return `/@modules/${specifier}`
  }
}

interface HotAcceptAnalysis {
  code: string
  acceptedUrls: Set<string>
  isSelfAccepting: boolean
}

/**
 * 解析并规范化 import.meta.hot.accept() 的第一参数。
 * HMR API 只允许字符串字面量或字面量数组，因此无需引入完整 AST。
 */
function rewriteHotAcceptDeps(
  code: string,
  config: ResolvedConfig,
  filePath: string,
): HotAcceptAnalysis {
  const acceptedUrls = new Set<string>()
  const edits: Array<{ start: number; end: number; value: string }> = []
  const resolveSpec = createModuleSpecifierResolver(config, filePath)
  const acceptRE = /(?:\bimport\.meta\.hot|\b__nasti_hot__)(?:(?:\?\.)|\.)accept\s*\(/g
  const searchableCode = maskStringsAndComments(code)
  let isSelfAccepting = false
  let match: RegExpExecArray | null

  while ((match = acceptRE.exec(searchableCode))) {
    let cursor = match.index + match[0].length
    const skipTrivia = (): void => {
      while (cursor < code.length) {
        if (/\s/.test(code[cursor])) {
          cursor++
          continue
        }
        if (code[cursor] === '/' && code[cursor + 1] === '/') {
          cursor += 2
          while (cursor < code.length && code[cursor] !== '\n') cursor++
          continue
        }
        if (code[cursor] === '/' && code[cursor + 1] === '*') {
          cursor += 2
          while (cursor < code.length && !(code[cursor] === '*' && code[cursor + 1] === '/')) cursor++
          cursor += 2
          continue
        }
        break
      }
    }
    skipTrivia()
    const first = code[cursor]

    if (!first || first === ')' || (first !== '[' && first !== "'" && first !== '"' && first !== '`')) {
      isSelfAccepting = true
      continue
    }

    const readLiteral = (): void => {
      const quote = code[cursor]
      if (quote !== "'" && quote !== '"' && quote !== '`') return
      const start = cursor
      cursor++
      let raw = ''
      while (cursor < code.length) {
        const char = code[cursor]
        if (char === '\\') {
          raw += code[cursor + 1] ?? ''
          cursor += 2
          continue
        }
        if (char === quote) {
          cursor++
          const resolved = removeTimestampQuery(resolveSpec(raw))
          acceptedUrls.add(resolved)
          edits.push({ start, end: cursor, value: JSON.stringify(resolved) })
          return
        }
        if (quote === '`' && char === '$' && code[cursor + 1] === '{') return
        raw += char
        cursor++
      }
    }

    if (first === '[') {
      cursor++
      while (cursor < code.length) {
        skipTrivia()
        if (code[cursor] === ',') {
          cursor++
          skipTrivia()
        }
        if (code[cursor] === ']') break
        const before = cursor
        readLiteral()
        if (cursor === before) break
      }
    } else {
      readLiteral()
    }
  }

  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    code = code.slice(0, edit.start) + edit.value + code.slice(edit.end)
  }
  return { code, acceptedUrls, isSelfAccepting }
}

/** 用等长空格遮蔽字符串、模板字面量和注释，避免把文档文本误识别为 HMR 调用。 */
function maskStringsAndComments(code: string): string {
  // split('') 保持 UTF-16 索引与 RegExp match.index 对齐（展开运算会合并代理对）。
  const masked = code.split('')
  let state:
    | 'code'
    | 'single'
    | 'double'
    | 'template'
    | 'regex'
    | 'regex-class'
    | 'line-comment'
    | 'block-comment' = 'code'

  const isRegexStart = (index: number): boolean => {
    let previous = index - 1
    while (previous >= 0 && /\s/.test(code[previous])) previous--
    return previous < 0 || '=(:,!&|?{};[]+-*%^~<>'.includes(code[previous])
  }

  for (let i = 0; i < code.length; i++) {
    const char = code[i]
    const next = code[i + 1]
    if (state === 'code') {
      if (char === "'") state = 'single'
      else if (char === '"') state = 'double'
      else if (char === '`') state = 'template'
      else if (char === '/' && next === '/') state = 'line-comment'
      else if (char === '/' && next === '*') state = 'block-comment'
      else if (char === '/' && isRegexStart(i)) state = 'regex'
      else continue
      masked[i] = ' '
      continue
    }

    if (state === 'line-comment') {
      if (char === '\n') {
        state = 'code'
      } else {
        masked[i] = ' '
      }
      continue
    }
    if (state === 'block-comment') {
      masked[i] = char === '\n' ? '\n' : ' '
      if (char === '*' && next === '/') {
        masked[i + 1] = ' '
        i++
        state = 'code'
      }
      continue
    }
    if (state === 'regex' || state === 'regex-class') {
      masked[i] = char === '\n' ? '\n' : ' '
      if (char === '\\') {
        if (i + 1 < code.length) masked[++i] = ' '
      } else if (state === 'regex' && char === '[') {
        state = 'regex-class'
      } else if (state === 'regex-class' && char === ']') {
        state = 'regex'
      } else if (state === 'regex' && char === '/') {
        state = 'code'
      }
      continue
    }

    masked[i] = char === '\n' ? '\n' : ' '
    if (char === '\\') {
      if (i + 1 < code.length) masked[++i] = ' '
      continue
    }
    if (
      (state === 'single' && char === "'") ||
      (state === 'double' && char === '"') ||
      (state === 'template' && char === '`')
    ) {
      state = 'code'
    }
  }
  return masked.join('')
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

function appendTimestampQuery(url: string, timestamp: number): string {
  const hashIndex = url.indexOf('#')
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : ''
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url
  return `${withoutHash}${withoutHash.includes('?') ? '&' : '?'}t=${timestamp}${hash}`
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
 * 把 bundle 中被 external 化的 bare specifier 解析为浏览器可加载的 URL。
 *
 * 关键：相对「正在打包的包自身的真实目录」解析（而非项目根）。pnpm 严格布局下，
 * 传递依赖不会被提升到顶层 node_modules（只有直接依赖以 symlink 形式出现在那里），
 * 真实文件在 `.pnpm/<pkg>@<ver>/node_modules/` 内，其依赖是同目录下的兄弟包。
 * 从项目根向上走只能找到直接依赖 → 传递依赖（如 react-router 的 @tanstack/router-core）
 * 必然 404。改为从 importer 包的真实目录向上走即可命中。
 *
 * URL 去重（关键，关系到 React 等对实例唯一性敏感的库能否工作）：用户源码里的裸 import
 * 被 rewriteImports 改写成裸 `/@modules/<spec>`，并由 dev server 从项目根解析。若从 importer
 * 真实目录解析与从项目根解析命中**同一真实文件**（npm/yarn 扁平布局，或依赖已被提升到顶层
 * node_modules），就必须同样发裸 URL —— 浏览器按 URL 字符串去重，带 `?id=` 会被当成另一个
 * 模块重复实例化。否则 app 的 `/@modules/react` 与 react-dom 外部化得到的
 * `/@modules/react?id=...` 会变成两份 React → 二者 dispatcher 不互通 → useEffect 读到 null →
 * "Invalid hook call. Hooks can only be called inside of the body of a function component"。
 *
 * 仅当项目根解析不到、或解析到的是**不同文件**（pnpm 未提升的传递依赖、多版本并存）时，
 * 才把 importer 相对解析到的绝对路径编码进 `?id=`，dev server 据此直接打包该文件，无需再次
 * 从 root 解析（见 transformRequest 中的 `/@modules/...?id=` 分支）。
 */
function externalSpecToModuleUrl(spec: string, baseDir: string, root: string): string {
  const resolved = resolveNodeModule(baseDir, spec)
  if (!resolved) return `/@modules/${spec}`
  const rootResolved = resolveNodeModule(root, spec)
  if (rootResolved && rootResolved === resolved) return `/@modules/${spec}`
  return `/@modules/${spec}?id=${encodeURIComponent(resolved)}`
}

/**
 * ESM-aware node_modules 解析：支持 package.json exports 字段的 import/browser/module/default 条件，
 * 兼容 ESM-only 包（如只有 "import" 条件而无 "require" 的包）。
 * createRequire 使用 CJS 解析逻辑，遇到 ESM-only exports 会抛异常，因此不能用于此场景。
 *
 * **返回真实路径**（解析 symlink）：pnpm 把直接依赖以 symlink 放在顶层 node_modules，
 * 真实文件在 `.pnpm/.../node_modules/` 下。后续打包阶段用 `dirname(entryFile)` 向上找
 * 传递依赖，只有从真实路径出发才能命中那些未被提升的兄弟包。
 */
function resolveNodeModule(baseDir: string, moduleName: string): string | null {
  const resolved = resolveNodeModuleEntry(baseDir, moduleName)
  if (!resolved) return null
  try {
    return fs.realpathSync(resolved)
  } catch {
    return resolved
  }
}

function resolveNodeModuleEntry(root: string, moduleName: string): string | null {
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
  if (entry === undefined) {
    // 顶层条件对象（如 `{"import": "./x.mjs", "require": "./x.cjs"}`）是 "." 入口的
    // 语法糖：当对象没有任何以 "." 开头的子路径键时，整个对象就是 "." 的条件映射，
    // 交给 resolveExportValue 走 ESM_CONDITIONS 解析，而不是误判为「无此导出」返回 null
    // （否则只能回落到 module/main，exports-only 的双格式包会解析失败）。
    if (
      key === '.' &&
      typeof exports === 'object' &&
      !Object.keys(exports).some((k) => k.startsWith('.'))
    ) {
      return resolveExportValue(exports, pkgDir)
    }
    return null
  }
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
  // 去除 query / hash，避免污染文件系统路径解析
  const cleanUrl = url.split(/[?#]/)[0]

  // /@modules/ 前缀 → node_modules 预构建
  if (cleanUrl.startsWith('/@modules/')) {
    const moduleName = cleanUrl.slice('/@modules/'.length)
    return resolveNodeModule(root, moduleName)
  }

  // /@fs/<abs>：workspace / file: 包在 root 外的源文件（Vite 兼容）
  if (cleanUrl.startsWith('/@fs/')) {
    let abs = cleanUrl.slice('/@fs/'.length)
    // URL 里是 POSIX 分隔符；Windows 盘符为 `C:/...`，Unix 需补回前导 `/`
    if (process.platform === 'win32') {
      abs = abs.replace(/\//g, path.sep)
    } else if (!abs.startsWith('/')) {
      abs = '/' + abs
    }
    try {
      const real = fs.realpathSync(abs)
      if (fs.statSync(real).isFile() && isAllowedDevModulePath(real, root)) return real
    } catch {
      return null
    }
    return null
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

function isModuleRequest(
  url: string,
  destination?: string | string[],
): boolean {
  const cleanUrl = url.split(/[?#]/)[0]
  if (/\.(ts|tsx|jsx|js|mjs|vue|css|json)$/.test(cleanUrl)) return true
  if (cleanUrl.startsWith('/@modules/')) return true
  if (cleanUrl.startsWith('/@fs/')) return true
  if (isAssetFile(cleanUrl)) {
    const qIdx = url.indexOf('?')
    const hIdx = url.indexOf('#')
    const queryEnd = hIdx === -1 ? url.length : hIdx
    const query = qIdx === -1 || qIdx > queryEnd ? '' : url.slice(qIdx + 1, queryEnd)
    const isExplicitAssetModule = /(?:^|&)(?:url|raw)(?:&|$)/.test(query)
    return isExplicitAssetModule || destination === 'script'
  }
  // 无扩展名路径可能是省略扩展名的模块导入（如 /src/App）
  if (!path.extname(cleanUrl)) return true
  return false
}

function getHmrClientCode(): string {
  return `
// Nasti HMR Client
const socketProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
const socket = new WebSocket(socketProtocol + '://' + location.host, 'nasti-hmr');
const hotModulesMap = new Map();
const disposeMap = new Map();
const pruneMap = new Map();
const dataMap = new Map();
const customListenersMap = new Map();
let updateQueue = [];
let pendingUpdateQueue = false;

socket.addEventListener('message', async ({ data }) => {
  const payload = JSON.parse(data);
  // 默认浏览器 client 只消费自己的 HMR 消息；native/worker 环境通过各自的
  // HotChannel 或 app-level HMR 协调器处理同一 transport 上的命名消息。
  if (payload.environment && payload.environment !== 'client') return;
  switch (payload.type) {
    case 'connected':
      console.debug('[nasti] connected.');
      clearErrorOverlay();
      break;
    case 'update':
      try {
        // CSS 在 unbundled 模式下也是会注入 <style> 的 JS 模块，和普通 JS
        // 一样重新 import 才能执行 dispose/accept 并保持页面状态。
        await Promise.all(payload.updates.map(queueUpdate));
        clearErrorOverlay();
        console.debug('[nasti] HMR update complete.');
      } catch (err) {
        console.error('[nasti] HMR update failed:', err);
        showErrorOverlay(err);
      }
      break;
    case 'full-reload':
      console.log('[nasti] full reload');
      location.reload();
      break;
    case 'prune':
      await Promise.all(payload.paths.map(async (path) => {
        const data = dataMap.get(path);
        const dispose = disposeMap.get(path);
        const prune = pruneMap.get(path);
        if (dispose) await dispose(data);
        if (prune) await prune(data);
        hotModulesMap.delete(path);
        disposeMap.delete(path);
        pruneMap.delete(path);
        dataMap.delete(path);
        clearCustomListeners(path);
      }));
      break;
    case 'custom': {
      const listenersByOwner = customListenersMap.get(payload.event);
      if (!listenersByOwner) break;
      const results = await Promise.allSettled(
        [...listenersByOwner.values()]
          .flatMap((listeners) => [...listeners])
          .map((listener) => Promise.resolve().then(() => listener(payload.data)))
      );
      for (const result of results) {
        if (result.status === 'rejected') {
          console.error('[nasti] custom HMR event listener failed:', result.reason);
        }
      }
      break;
    }
    case 'error':
      console.error('[nasti] error:', payload.err.message);
      showErrorOverlay(payload.err);
      break;
  }
});

// 服务重启后旧模块图已失效，重连时整页刷新是必要兜底；正常 update 不再刷新。
let reconnectTimer = 0;
socket.addEventListener('close', () => {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => location.reload(), 1000);
});

/**
 * 同一批更新先全部拉取，再按服务端消息顺序执行 accept 回调，避免 HTTP 往返速度
 * 改变模块应用顺序。这与 Vite HMRClient 的 fetch/apply 两阶段一致。
 */
async function queueUpdate(update) {
  updateQueue.push(fetchUpdate(update));
  if (pendingUpdateQueue) return;

  pendingUpdateQueue = true;
  await Promise.resolve();
  pendingUpdateQueue = false;
  const loading = updateQueue;
  updateQueue = [];
  const applyUpdates = await Promise.all(loading);
  for (const apply of applyUpdates) {
    if (apply) apply();
  }
}

async function fetchUpdate(update) {
  const mod = hotModulesMap.get(update.path);
  // 尚未在当前页面加载的动态模块不需要更新。
  if (!mod) return;

  // 必须在重新 import 前确定旧回调；新模块执行 createHotContext 时会清空并注册新回调。
  const qualifiedCallbacks = mod.callbacks.filter(({ deps }) =>
    deps.includes(update.acceptedPath)
  );
  const isSelfUpdate = update.path === update.acceptedPath;
  if (!isSelfUpdate && qualifiedCallbacks.length === 0) return;

  const dispose = disposeMap.get(update.acceptedPath);
  if (dispose) await dispose(dataMap.get(update.acceptedPath));
  const newMod = await import(appendTimestampQuery(update.acceptedPath, update.timestamp));

  return () => {
    for (const { deps, fn } of qualifiedCallbacks) {
      fn(deps.map((dep) => dep === update.acceptedPath ? newMod : undefined));
    }
    const detail = isSelfUpdate
      ? update.path
      : update.acceptedPath + ' via ' + update.path;
    console.debug('[nasti] hot updated:', detail);
  };
}

function appendTimestampQuery(url, timestamp) {
  const hashIndex = url.indexOf('#');
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  return withoutHash + (withoutHash.includes('?') ? '&' : '?') + 't=' + timestamp + hash;
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

export function createHotContext(ownerPath) {
  if (!dataMap.has(ownerPath)) dataMap.set(ownerPath, {});

  // 模块重新执行时丢弃旧 accept 回调，但保留同一个 hot.data 对象。
  const existing = hotModulesMap.get(ownerPath);
  if (existing) existing.callbacks = [];
  clearCustomListeners(ownerPath);

  const acceptDeps = (deps, callback = () => {}) => {
    const mod = hotModulesMap.get(ownerPath) || { id: ownerPath, callbacks: [] };
    mod.callbacks.push({ deps, fn: callback });
    hotModulesMap.set(ownerPath, mod);
  };

  return {
    accept(deps, callback) {
      if (typeof deps === 'function' || deps === undefined) {
        acceptDeps([ownerPath], ([mod]) => deps?.(mod));
      } else if (typeof deps === 'string') {
        acceptDeps([deps], ([mod]) => callback?.(mod));
      } else if (Array.isArray(deps)) {
        acceptDeps(deps, callback);
      } else {
        throw new Error('invalid hot.accept() usage');
      }
    },
    prune(callback) {
      pruneMap.set(ownerPath, callback);
    },
    dispose(callback) {
      disposeMap.set(ownerPath, callback);
    },
    on(event, callback) {
      let listenersByOwner = customListenersMap.get(event);
      if (!listenersByOwner) {
        listenersByOwner = new Map();
        customListenersMap.set(event, listenersByOwner);
      }
      let listeners = listenersByOwner.get(ownerPath);
      if (!listeners) {
        listeners = new Set();
        listenersByOwner.set(ownerPath, listeners);
      }
      listeners.add(callback);
    },
    off(event, callback) {
      const listenersByOwner = customListenersMap.get(event);
      const listeners = listenersByOwner?.get(ownerPath);
      listeners?.delete(callback);
      if (listeners?.size === 0) listenersByOwner.delete(ownerPath);
      if (listenersByOwner?.size === 0) customListenersMap.delete(event);
    },
    invalidate() {
      location.reload();
    },
    data: dataMap.get(ownerPath),
  };
}

function clearCustomListeners(ownerPath) {
  for (const [event, listenersByOwner] of customListenersMap) {
    listenersByOwner.delete(ownerPath);
    if (listenersByOwner.size === 0) customListenersMap.delete(event);
  }
}
`
}
