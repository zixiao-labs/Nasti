// 完整打包模式 / Full Bundle Mode（NASTI_2.0_PLAN.md §2.5，opt-in）
//
// `experimental.bundledDev`（CLI `--bundle`）把 unbundled 的 transform+sirv
// 管线换成长驻 Rolldown DevEngine：整体打包 client 环境，产物存内存 Map
//（**非 memfs**，避免 native / WASM binding 行为差异），经
// memory-files 中间件服务；HMR 由 onHmrUpdates 的 Patch/FullReload 驱动。
//
// 客户端运行时：**复用 rolldown 内置的 DefaultDevRuntime**（不传
// devMode.implement 会替换整个 runtime 模块，包括
// __toESM 等 scope-hoist helper，自带成本远高于收益）。服务端讲它的协议：
//   server→client: {type:'connected'} / {type:'hmr:update', path, url} /
//                  {type:'hmr:reload'}
//   client→server: {type:'hmr:invalidate', moduleId}
//   ws 连接带 ?clientId=<uuid>（runtime 生成，多 tab 各自独立）
//
// 懒编译端点：DevEngine 的 lazy stub 使用 `/@vite/lazy?id=&clientId=`
//（Vite 专属约定）—— 按已安装版本编码，同时也接受 /@nasti/lazy。
//
// React Fast Refresh：复用 rolldown 原生 `viteReactRefreshWrapperPlugin`
//（计划 §2.5 ✓核实）。契约（由版本锁定与 smoke test 保护）：
//   1. wrapper 在插件 transform 阶段看到 **已含 `$RefreshReg$(` 的代码**才激活
//      → refresh 注册转换必须在它之前的 JS 插件里完成（input 级 transform.jsx
//      在插件链之后才跑，wrapper 看不到）—— createBundledOxcRefreshPlugin。
//   2. wrapper 产出 `import * as RefreshRuntime from "/@react-refresh"` 并调用
//      registerExportsForReactRefresh / validateRefreshBoundaryAndEnqueueUpdate
//      （plugin-react 扩展 API，react-refresh 本体没有）→ 由
//      createReactRefreshRuntimePlugin 在 **bundle 内**提供该虚拟模块。
//   3. wrapper 校验 `window.$RefreshReg$` → preamble 以 bundle 内虚拟模块的
//      形式注入为各入口的**第一个 import**（不能走 HTML 内联 script——那会经
//      unbundled 中间件加载出第二个 runtime 实例，refresh 注册表分裂失效）。
//
// 仅 client 环境（同 Vite FullBundleDevEnvironment）；unbundled 保持默认。
import path from 'node:path'
import crypto from 'node:crypto'
import { WebSocketServer as WsServer, type WebSocket } from 'ws'
import pc from 'picocolors'
import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http'
import type { BindingClientHmrUpdate } from 'rolldown/experimental'
import type { ResolvedConfig } from '../../types.js'
import type { NastiEnvironment } from '../../core/environment.js'
import {
  getRolldownOptions,
  replaceEntryScript,
  resolveClientEntries,
  toRolldownPlugins,
} from '../../build/index.js'
import { readHtmlFile, processHtml } from '../../plugins/html.js'
import { transformCode } from '../../core/transformer.js'
import { getReactRefreshRuntimeEsm } from '../middleware.js'
import { createDebugger } from '../../core/debug.js'

const debug = createDebugger('nasti:bundled')

const MIME_TYPES: Record<string, string> = {
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm',
}

/** 内存产物存储（普通 Map，Vite MemoryFiles 同款做法） */
class MemoryFiles {
  private files = new Map<string, { content: string | Uint8Array; etag: string }>()

  set(fileName: string, content: string | Uint8Array): void {
    const etag = `"${crypto.createHash('sha1').update(content).digest('base64').slice(0, 27)}"`
    this.files.set(fileName, { content, etag })
  }

  get(fileName: string) {
    return this.files.get(fileName)
  }

  clear(): void {
    this.files.clear()
  }
}

export interface BundledDevOptions {
  config: ResolvedConfig
  clientEnv: NastiEnvironment
  httpServer: HttpServer
}

export interface BundledDevServer {
  /** connect 中间件：内存产物 + index.html + 懒编译端点 */
  middleware: (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void
  close: () => Promise<void>
}

export async function createBundledDevServer(opts: BundledDevOptions): Promise<BundledDevServer> {
  const { config, clientEnv, httpServer } = opts
  const logger = config.logger

  // 实验 API 守卫：dev/DevEngine 无 semver 保护，导入失败给出明确指引
  let devFn: typeof import('rolldown/experimental').dev
  let refreshWrapperFn:
    | typeof import('rolldown/experimental').viteReactRefreshWrapperPlugin
    | null = null
  try {
    const experimental = await import('rolldown/experimental')
    devFn = experimental.dev
    if (typeof devFn !== 'function') throw new Error('dev() export missing')
    // wrapper 缺失只降级 Fast Refresh（HMR 退化为整页刷新），不阻塞 bundled dev
    if (typeof experimental.viteReactRefreshWrapperPlugin === 'function') {
      refreshWrapperFn = experimental.viteReactRefreshWrapperPlugin
    }
  } catch (err: any) {
    throw new Error(
      `[nasti] experimental.bundledDev requires rolldown's experimental dev() API ` +
        `(locked version is incompatible; got: ${err.message}). ` +
        `Remove --bundle / experimental.bundledDev to use the default unbundled dev server.`,
    )
  }

  const html = await readHtmlFile(config.root, config.environments.client?.html)
  const entryPoints = resolveClientEntries(config, html)
  if (entryPoints.length === 0) {
    throw new Error('No entry point found. Add a <script> tag to index.html or create src/main.ts')
  }

  const memoryFiles = new MemoryFiles()
  const patches = new MemoryFiles()
  /** entry facadeModuleId（绝对路径）→ 内存产物 fileName（assets/main.js） */
  const entryFileNames = new Map<string, string>()
  const bundledClients = new Map<string, WebSocket>()

  // 复用多环境 builder 的 per-env 选项装配（含插件转发表 / define / resolve）
  // React Fast Refresh 三件套（条件与 unbundled 中间件一致：framework !== 'vue'）：
  //   refresh runtime 虚拟模块 + 入口 preamble → OXC refresh 注册转换 →
  //   Nasti 插件 → 原生 wrapper（必须在 OXC 之后才能看到 $RefreshReg$ 调用）
  const useReactRefresh = config.framework !== 'vue' && refreshWrapperFn != null
  const rolldownPlugins = [
    ...(useReactRefresh
      ? [
          createReactRefreshRuntimePlugin(entryPoints),
          createBundledOxcRefreshPlugin(),
        ]
      : []),
    ...stripCatchAllLoad(toRolldownPlugins(clientEnv.plugins, clientEnv)),
    ...(useReactRefresh
      ? [
          refreshWrapperFn!({
            cwd: config.root,
            include: [/\.[jt]sx(\?.*)?$/],
            exclude: [/node_modules/],
            jsxImportSource: 'react',
            reactRefreshHost: '',
          }),
        ]
      : []),
  ]
  const { inputOptions, outputOptions } = getRolldownOptions(clientEnv, entryPoints, rolldownPlugins)

  let fullReloadTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleFullReload = () => {
    if (fullReloadTimer) clearTimeout(fullReloadTimer)
    fullReloadTimer = setTimeout(() => {
      logger.info(pc.green('page reload ') + pc.dim('(bundled)'), { timestamp: true })
      broadcast({ type: 'hmr:reload' })
    }, 30)
  }
  const broadcast = (payload: unknown) => {
    const data = JSON.stringify(payload)
    for (const ws of bundledClients.values()) {
      if (ws.readyState === 1) ws.send(data)
    }
  }
  const sendTo = (clientId: string, payload: unknown) => {
    const ws = bundledClients.get(clientId)
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload))
  }

  // HMR 由 DevEngine 内置 watcher 独占驱动（onHmrUpdates）。
  // DevEngine 1.2+ 由内置 watcher 驱动，手动 invalidate API 已移除。
  async function processUpdates(
    updates: BindingClientHmrUpdate[],
    changedFiles: string[],
  ): Promise<void> {
    let needsLatestOutput = false
    for (const { clientId, update } of updates) {
      if (update.type === 'Noop') continue
      if (update.type === 'FullReload') {
        debug?.(`full reload for ${clientId}: ${update.reason ?? ''}`)
        needsLatestOutput = true
        continue
      }
      // Patch：存内存 + 通知该 client 拉取。浏览器完成 patch 求值后刷新页面，
      // 与 unbundled 客户端保持一致；尾部 export {} 同时用于 XSSI 加固。
      const patchPath = `__nasti_patch/${update.filename}`
      patches.set(
        patchPath,
        update.code + '\n;globalThis.location?.reload();\n;export {}',
      )
      if (update.sourcemap && update.sourcemapFilename) {
        patches.set(`__nasti_patch/${update.sourcemapFilename}`, update.sourcemap)
      }
      const url = `/${patchPath}`
      logger.info(
        pc.green('hmr update ') +
          pc.dim(changedFiles.map((f) => path.relative(config.root, f)).join(', ')),
        { timestamp: true },
      )
      sendTo(clientId, { type: 'hmr:update', path: url, url })
    }
    if (needsLatestOutput) {
      await engine.ensureLatestBuildOutput()
      scheduleFullReload()
    }
  }

  const engine = await devFn(
    {
      ...inputOptions,
      cwd: config.root,
      // Rolldown bug 规避：inlineConst 与 dev patch 机制冲突（vitejs/vite#21843）
      optimization: { ...(inputOptions as any).optimization, inlineConst: false },
      experimental: {
        ...(inputOptions as any).experimental,
        devMode: {
          lazy: true,
          // 默认 DevRuntime 把 ws 地址烤进 bundle：指向 Nasti dev server 本身
          //（端口被占自动 +1 时 HMR ws 会失联 —— 已知限制，产物仍可服务）
          host: config.server.host === true ? 'localhost' : (config.server.host as string) || 'localhost',
          port: config.server.port,
        },
      },
    } as any,
    {
      ...outputOptions,
      entryFileNames: 'assets/[name].js',
      chunkFileNames: 'assets/[name]-[hash].js',
      minify: false,
      sourcemap: true,
    },
    {
      watch: { skipWrite: true },
      rebuildStrategy: 'never',
      onOutput(result) {
        if (result instanceof Error) {
          logger.error(pc.red(`[bundled] build error: ${result.message}`), { error: result })
          return
        }
        for (const file of result.output) {
          const content = file.type === 'chunk' ? file.code : (file as any).source
          if (content != null) memoryFiles.set(file.fileName, content)
          if (file.type === 'chunk' && (file as any).isEntry && (file as any).facadeModuleId) {
            entryFileNames.set((file as any).facadeModuleId, file.fileName)
          }
          // sourcemap 同步进内存
          if (file.type === 'chunk' && (file as any).map) {
            memoryFiles.set(`${file.fileName}.map`, JSON.stringify((file as any).map))
          }
        }
        debug?.(`bundle output refreshed (${result.output.length} files)`)
      },
      onAdditionalAssets(result) {
        for (const file of result.output) {
          const content = file.type === 'chunk' ? file.code : (file as any).source
          if (content != null) memoryFiles.set(file.fileName, content)
        }
      },
      async onHmrUpdates(result) {
        if (result instanceof Error) {
          logger.error(pc.red(`[bundled] hmr error: ${result.message}`), { error: result })
          broadcast({ type: 'error', err: { message: result.message, stack: result.stack } })
          return
        }
        const { updates, changedFiles } = result
        debug?.(
          `onHmrUpdates(engine watcher): ${changedFiles.length} changed, ${updates.length} updates`,
        )
        if (changedFiles.length === 0) return
        await processUpdates(updates, changedFiles)
      },
    },
  )

  await engine.run()
  await engine.ensureCurrentBuildFinish()
  logger.info(pc.dim(`  bundled dev engine ready (${entryPoints.length} entries, in-memory)`))

  // ── 打包模式专用 ws（默认 DevRuntime 不带子协议，带 ?clientId= 查询）────
  const wss = new WsServer({ noServer: true })
  httpServer.on('upgrade', (req, socket, head) => {
    if (req.headers['sec-websocket-protocol'] === 'nasti-hmr') return // unbundled 客户端
    const url = new URL(req.url ?? '/', 'http://localhost')
    const clientId = url.searchParams.get('clientId')
    if (!clientId) return
    wss.handleUpgrade(req, socket, head, (ws) => {
      bundledClients.set(clientId, ws)
      debug?.(`bundled client connected: ${clientId}`)
      void engine
        .registerClient(clientId)
        .then(async () => {
          // 入口响应在 runtime 建立 WS 前已经完成；连接后补记初始 payload。
          for (const fileName of entryFileNames.values()) {
            await engine.notifyPayloadDelivered(fileName)
          }
          ws.send(JSON.stringify({ type: 'connected' }))
        })
        .catch((err: any) => {
          debug?.(`registerClient failed for ${clientId}: ${err?.message ?? err}`)
          ws.close()
        })
      ws.on('message', async (raw) => {
        try {
          const msg = JSON.parse(String(raw))
          if (msg.type === 'hmr:invalidate') {
            // import.meta.hot.invalidate：保守处理为整页刷新
            scheduleFullReload()
          }
        } catch (err: any) {
          debug?.(`bundled ws message error: ${err.message}`)
        }
      })
      ws.on('close', () => {
        bundledClients.delete(clientId)
        engine
          .removeClient(clientId)
          .catch((err: any) => debug?.(`removeClient failed for ${clientId}: ${err?.message ?? err}`))
      })
    })
  })

  // ── 中间件：懒编译端点 + 内存产物 + index.html ─────────────────────────
  const middleware: BundledDevServer['middleware'] = (req, res, next) => {
    void (async () => {
      const rawUrl = req.url ?? '/'
      const url = new URL(rawUrl, 'http://localhost')
      const pathname = decodeURIComponent(url.pathname)

      // 懒编译（DevEngine stub 使用 /@vite/lazy；/@nasti/lazy 同义）
      if (pathname === '/@vite/lazy' || pathname === '/@nasti/lazy') {
        const id = url.searchParams.get('id')
        const clientId = url.searchParams.get('clientId')
        if (!id || !clientId) {
          res.statusCode = 400
          res.end('// [nasti] lazy endpoint requires id & clientId')
          return
        }
        const output = await engine.compileEntry(id, clientId)
        if (output.sourcemap && output.sourcemapFilename) {
          memoryFiles.set(output.sourcemapFilename, output.sourcemap)
        }
        res.once('finish', () => {
          void engine
            .notifyPayloadDelivered(output.filename)
            .catch((err: any) =>
              debug?.(`notifyPayloadDelivered failed: ${err?.message ?? err}`),
            )
        })
        res.setHeader('Content-Type', 'application/javascript')
        res.setHeader('Cache-Control', 'no-store')
        res.end(output.code + '\n;export {}')
        return
      }

      // HMR patch
      const patchHit = patches.get(pathname.replace(/^\//, ''))
      if (patchHit) {
        res.setHeader('Content-Type', 'application/javascript')
        res.setHeader('Cache-Control', 'no-store')
        res.end(patchHit.content)
        return
      }

      // 内存产物（ETag/304）
      const fileName = pathname.replace(/^\//, '')
      const hit = memoryFiles.get(fileName)
      if (hit) {
        if (req.headers['if-none-match'] === hit.etag) {
          res.statusCode = 304
          res.end()
          return
        }
        res.setHeader('ETag', hit.etag)
        res.setHeader('Content-Type', MIME_TYPES[path.extname(fileName)] ?? 'application/octet-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.once('finish', () => {
          void engine
            .notifyPayloadDelivered(fileName)
            .catch((err: any) =>
              debug?.(`notifyPayloadDelivered failed: ${err?.message ?? err}`),
            )
        })
        res.end(hit.content)
        return
      }

      // index.html：注入 React preamble（unbundled 同款）+ 入口改写到内存产物
      if (pathname === '/' || pathname.endsWith('.html')) {
        const rawHtml = await readHtmlFile(config.root, config.environments.client?.html)
        if (rawHtml) {
          res.setHeader('Content-Type', 'text/html')
          res.setHeader('Cache-Control', 'no-store')
          res.end(await renderBundledIndexHtml(rawHtml, config, entryFileNames))
          return
        }
      }

      next()
    })().catch((err) => {
      config.logger.error(pc.red(`[bundled] ${err.message}`), { error: err })
      res.statusCode = 500
      res.end(`[nasti bundled] ${err.message}`)
    })
  }

  return {
    middleware,
    async close() {
      if (fullReloadTimer) clearTimeout(fullReloadTimer)
      wss.close()
      await engine.close()
    },
  }
}

// ── React Fast Refresh（bundled 模式三件套）────────────────────────────────

/**
 * 剥掉 nasti:resolve 的文件 load 钩子（仅 bundled 模式）。
 *
 * DevEngine 的文件监听只注册**原生加载过**的模块路径 —— 模块一旦由
 * 插件 load 提供内容，就不进 watch 列表。nasti:resolve 目前只包装 JSON，
 * 但 Rolldown 原生加载已经覆盖这一能力；为确保这些文件仍由 DevEngine
 * 原生读取和监听，bundled 模式下继续剥掉该钩子。
 * 同理：用户插件的 catch-all load 也会让对应文件失去 HMR —— 文档已注记。
 */
function stripCatchAllLoad(plugins: unknown[]): unknown[] {
  return plugins.map((p: any) =>
    p?.name === 'nasti:resolve' ? { ...p, load: undefined } : p,
  )
}

/** 入口 preamble 的虚拟模块 specifier（resolveId 映射到 \0 前缀 id） */
const PREAMBLE_SPEC = 'nasti:react-preamble'
const RESOLVED_PREAMBLE_ID = '\0nasti:react-preamble'
const REFRESH_RUNTIME_URL = '/@react-refresh'

/**
 * 安装 Fast Refresh 全局钩子的 preamble —— 作为 bundle 内模块（而非 HTML 内联
 * script）注入为入口的第一个 import：与 wrapper 产出的 import 共享**同一个**
 * runtime 实例（HTML 路径会经 unbundled 中间件加载出第二个实例，注册表分裂），
 * 且 scope-hoist 后先于 react-dom 执行（renderer 必须注册到已安装的 hook 上）。
 */
const BUNDLED_PREAMBLE_CODE = `
import __rt from ${JSON.stringify(REFRESH_RUNTIME_URL)};
__rt.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
`

/**
 * 原生 wrapper 的运行时契约扩展（plugin-react refresh-runtime 的同款辅助 API，
 * react-refresh 本体没有）：registerExportsForReactRefresh /
 * validateRefreshBoundaryAndEnqueueUpdate / __hmr_import。
 * 实现基于 getReactRefreshRuntimeEsm 已 re-export 的公共 API。
 */
const WRAPPER_RUNTIME_HELPERS = `
// ── viteReactRefreshWrapperPlugin 运行时契约（@vitejs/plugin-react 同款）──
function __isPlainObject(obj) {
  return Object.prototype.toString.call(obj) === '[object Object]' &&
    (obj.constructor === Object || obj.constructor === undefined);
}
function __isCompoundComponent(type) {
  if (!__isPlainObject(type)) return false;
  for (const key in type) {
    if (!isLikelyComponentType(type[key])) return false;
  }
  return true;
}
export function registerExportsForReactRefresh(filename, moduleExports) {
  for (const key in moduleExports) {
    if (key === '__esModule') continue;
    const exportValue = moduleExports[key];
    if (isLikelyComponentType(exportValue)) {
      register(exportValue, filename + ' export ' + key);
    } else if (__isCompoundComponent(exportValue)) {
      for (const subKey in exportValue) {
        register(exportValue[subKey], filename + ' export ' + key + '-' + subKey);
      }
    }
  }
}
let __enqueueTimer;
const __hooks = [];
window.__registerBeforePerformReactRefresh = (cb) => { __hooks.push(cb); };
function __enqueueUpdate() {
  clearTimeout(__enqueueTimer);
  __enqueueTimer = setTimeout(async () => {
    if (__hooks.length) await Promise.all(__hooks.map((cb) => cb()));
    performReactRefresh();
  }, 16);
}
function __predicateOnExport(ignoredExports, moduleExports, predicate) {
  for (const key in moduleExports) {
    if (ignoredExports.includes(key)) continue;
    if (!predicate(key, moduleExports[key])) return key;
  }
  return true;
}
export function validateRefreshBoundaryAndEnqueueUpdate(id, prevExports, nextExports) {
  const ignoredExports = window.__getReactRefreshIgnoredExports?.({ id }) ?? [];
  if (__predicateOnExport(ignoredExports, prevExports, (key) => key in nextExports) !== true) {
    return 'Could not Fast Refresh (export removed)';
  }
  if (__predicateOnExport(ignoredExports, nextExports, (key) => key in prevExports) !== true) {
    return 'Could not Fast Refresh (new export)';
  }
  let hasExports = false;
  const allExportsAreComponentsOrUnchanged = __predicateOnExport(
    ignoredExports,
    nextExports,
    (key, value) => {
      hasExports = true;
      if (isLikelyComponentType(value)) return true;
      if (__isCompoundComponent(value)) return true;
      return prevExports[key] === nextExports[key];
    },
  );
  if (hasExports && allExportsAreComponentsOrUnchanged === true) {
    __enqueueUpdate();
  } else {
    return 'Could not Fast Refresh ("' + allExportsAreComponentsOrUnchanged + '" export is incompatible)';
  }
}
export const __hmr_import = (module) => import(/* @vite-ignore */ module);
`

/**
 * bundle 内的 refresh runtime 虚拟模块 + 入口 preamble 注入。
 * `/@react-refresh` 保留**字面 id**（不映射 \0 前缀）：原生 wrapper 插件自带
 * 该 id 的 resolveId（原样返回且先于一切 JS resolveId 执行，版本 smoke test 验证），
 * 因此只能在 load 阶段按字面 id 提供内容 —— 与 @vitejs/plugin-react 的
 * `load: { filter: exactRegex('/@react-refresh') }` 同款做法。
 */
function createReactRefreshRuntimePlugin(entryPoints: string[]) {
  const entryIds = new Set(entryPoints.map((p) => path.resolve(p)))
  return {
    name: 'nasti:bundled-react-refresh',
    resolveId(source: string) {
      // wrapper 不在场时（理论上不会，防御）也保证 preamble 的 import 可解析
      if (source === REFRESH_RUNTIME_URL) return REFRESH_RUNTIME_URL
      if (source === PREAMBLE_SPEC) return RESOLVED_PREAMBLE_ID
      return null
    },
    load(id: string) {
      if (id === REFRESH_RUNTIME_URL) {
        return { code: getReactRefreshRuntimeEsm() + WRAPPER_RUNTIME_HELPERS, moduleType: 'js' }
      }
      if (id === RESOLVED_PREAMBLE_ID) {
        return { code: BUNDLED_PREAMBLE_CODE, moduleType: 'js' }
      }
      return null
    },
    transform(code: string, id: string) {
      if (!entryIds.has(path.resolve(id.split('?')[0]))) return null
      return { code: `import ${JSON.stringify(PREAMBLE_SPEC)};\n${code}`, map: null }
    },
  }
}

/**
 * .jsx/.tsx 的 OXC refresh 注册转换（$RefreshReg$/$RefreshSig$ 插入）。
 * 必须以 JS 插件形式跑在 wrapper **之前** —— input 级 `transform.jsx` 在插件链
 * 之后才执行，wrapper 的内容过滤（`$RefreshReg$(`）会看不到而静默跳过
 *（版本 smoke test 验证）。node_modules 交给 rolldown 原生转换。
 */
function createBundledOxcRefreshPlugin() {
  return {
    name: 'nasti:bundled-oxc-refresh',
    transform(code: string, id: string) {
      const clean = id.split('?')[0]
      if (!/\.[jt]sx$/.test(clean) || clean.includes('/node_modules/')) return null
      const result = transformCode(clean, code, {
        sourcemap: true,
        jsxRuntime: 'automatic',
        jsxImportSource: 'react',
        reactRefresh: true,
      })
      return { code: result.code, map: result.map ? JSON.parse(result.map) : undefined }
    },
  }
}

/** index.html：入口 script src 改写到内存产物 + 用户插件 transformIndexHtml。
 *  跳过内置 nasti:html（它注入的 /@nasti/client 与 HTML preamble 都是
 *  unbundled 专属 —— bundled 的 HMR 客户端与 preamble 已在 bundle 内）。 */
async function renderBundledIndexHtml(
  html: string,
  config: ResolvedConfig,
  entryFileNames: Map<string, string>,
): Promise<string> {
  let processed = html
  for (const plugin of config.plugins) {
    if (!plugin.transformIndexHtml || plugin.name === 'nasti:html') continue
    const result = await plugin.transformIndexHtml(processed)
    if (typeof result === 'string') {
      processed = result
    } else if (result && 'html' in result) {
      processed = processHtml(result.html, result.tags)
    } else if (Array.isArray(result)) {
      processed = processHtml(processed, result)
    }
  }
  // 入口 script src → 内存产物 URL
  for (const [facadeModuleId, fileName] of entryFileNames) {
    processed = replaceEntryScript(
      processed,
      facadeModuleId,
      fileName,
      config,
      config.environments.client?.html ?? 'index.html',
      '/',
    )
  }
  return processed
}
