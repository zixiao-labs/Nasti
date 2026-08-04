// Monaco Editor 支持插件 - 仿照 vite-plugin-monaco-editor
//
// 解决两个核心问题：
//   1. Monaco Editor 的 Web Worker 是独立入口，必须单独打包，
//      并通过 self.MonacoEnvironment.getWorkerUrl 告诉 Monaco 去哪里加载
//   2. monaco-editor 包含 2000+ 文件，若按 ESM 逐文件交给 dev server 转译，
//      并发 HTTP + fs 读取会在 macOS 等低 fd 限制环境下触发 EMFILE。
//      本插件将 Worker 预先打包为单文件并从磁盘缓存直接流式返回，
//      同时把 monaco-editor 目录显式从 watcher 排除，避免 HMR 链式打爆 fd。
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { NastiPlugin, ResolvedConfig, DevServer, HtmlTagDescriptor } from '../types.js'

export type MonacoEditorLanguageWorker =
  | 'editorWorkerService'
  | 'css'
  | 'html'
  | 'json'
  | 'typescript'

export interface MonacoCustomWorker {
  label: string
  entry: string
}

export interface MonacoEditorPluginOptions {
  /** 启用的 Monaco 语言 Worker，默认启用全部 */
  languageWorkers?: MonacoEditorLanguageWorker[]
  /** 额外自定义 Worker（如 monaco-graphql/esm/graphql.worker） */
  customWorkers?: MonacoCustomWorker[]
  /** Worker 在 URL 上的公共路径，默认 'monacoeditorwork'。可填 CDN 绝对 URL */
  publicPath?: string
  /** 是否将 Monaco API 暴露到 window.monaco（兼容 0.22 之前的 globalAPI 模式） */
  globalAPI?: boolean
  /** publicPath 是 CDN 时仍强制本地打包 Worker 产物 */
  forceBuildCDN?: boolean
  /** 自定义生产构建下 Worker 产物目录（绝对路径） */
  customDistPath?: (root: string, outDir: string, base: string) => string
}

const DEFAULT_WORKERS: Record<MonacoEditorLanguageWorker, string> = {
  editorWorkerService: 'monaco-editor/esm/vs/editor/editor.worker',
  css: 'monaco-editor/esm/vs/language/css/css.worker',
  html: 'monaco-editor/esm/vs/language/html/html.worker',
  json: 'monaco-editor/esm/vs/language/json/json.worker',
  typescript: 'monaco-editor/esm/vs/language/typescript/ts.worker',
}

const DEFAULT_PUBLIC_PATH = 'monacoeditorwork'

function isCDN(p: string): boolean {
  return /^((https?:)?\/\/|file:)/.test(p)
}

/** 规范化 publicPath：CDN 原样保留，本地路径保证以 / 开头、不以 / 结尾 */
function normalizePublicPath(p: string): string {
  if (isCDN(p)) return p.replace(/\/+$/, '')
  const withLead = p.startsWith('/') ? p : '/' + p
  return withLead.replace(/\/+$/, '') || '/'
}

/** 读取 monaco-editor 版本号作为缓存命名，版本变更自动失效旧产物 */
function readMonacoVersion(root: string): string {
  try {
    const require = createRequire(path.resolve(root, 'package.json'))
    const pkgJsonPath = require.resolve('monaco-editor/package.json', { paths: [root] })
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'))
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

export function monacoEditorPlugin(options: MonacoEditorPluginOptions = {}): NastiPlugin {
  const languageWorkers =
    options.languageWorkers ?? (Object.keys(DEFAULT_WORKERS) as MonacoEditorLanguageWorker[])
  const customWorkers = options.customWorkers ?? []
  const publicPath = normalizePublicPath(options.publicPath ?? DEFAULT_PUBLIC_PATH)
  const globalAPI = !!options.globalAPI
  const forceBuildCDN = !!options.forceBuildCDN

  const workers: MonacoCustomWorker[] = [
    ...languageWorkers.map((label) => ({ label, entry: DEFAULT_WORKERS[label] })),
    ...customWorkers,
  ]

  let resolvedConfig: ResolvedConfig
  let cacheDir = ''
  // label → 构建 Promise，做并发去重，防止启动瞬间多次请求同一 Worker 时重复打包
  const building = new Map<string, Promise<string>>()

  async function buildWorker(worker: MonacoCustomWorker): Promise<string> {
    const cacheFile = path.join(cacheDir, `${worker.label}.worker.js`)
    if (fs.existsSync(cacheFile)) return cacheFile
    const existing = building.get(worker.label)
    if (existing) return existing

    const task = (async () => {
      const { rolldown } = await import('rolldown')
      const require = createRequire(path.resolve(resolvedConfig.root, 'package.json'))
      let entry: string
      try {
        entry = require.resolve(worker.entry, { paths: [resolvedConfig.root] })
      } catch {
        // 某些 Worker 入口无扩展名，补 .js 再试（如 editor.worker）
        entry = require.resolve(worker.entry + '.js', { paths: [resolvedConfig.root] })
      }

      fs.mkdirSync(cacheDir, { recursive: true })

      const bundle = await rolldown({
        input: entry,
        platform: 'browser',
      } as any)

      await bundle.write({
        file: cacheFile,
        format: 'iife',
        sourcemap: false,
        minify: true,
        codeSplitting: false,
      } as any)
      await bundle.close()

      return cacheFile
    })()

    building.set(worker.label, task)
    try {
      return await task
    } finally {
      building.delete(worker.label)
    }
  }

  function runtimeInitScript(): string {
    // Normalize local worker URL prefix: join base + publicPath, avoid double slashes
    let normalizedPrefix = publicPath
    if (!isCDN(publicPath)) {
      const base = resolvedConfig.base.replace(/\/+$/, '') || ''
      const pub = publicPath.replace(/^\/+/, '')
      normalizedPrefix = base ? `${base}/${pub}` : `/${pub}`
    }

    const map: Record<string, string> = {}
    for (const w of workers) {
      map[w.label] = `${normalizedPrefix}/${w.label}.worker.js`
    }
    return `;(function () {
  var map = ${JSON.stringify(map)};
  function getWorkerUrl(_moduleId, label) {
    var url = map[label] || map['editorWorkerService'];
    if (/^(https?:)?\\/\\//.test(url)) {
      // 跨域 Worker 需用 Blob + importScripts 绕过同源限制
      var blob = new Blob(
        ['importScripts(' + JSON.stringify(url) + ');'],
        { type: 'application/javascript' }
      );
      return URL.createObjectURL(blob);
    }
    return url;
  }
  self.MonacoEnvironment = self.MonacoEnvironment || {};
  if (!self.MonacoEnvironment.getWorker && !self.MonacoEnvironment.getWorkerUrl) {
    self.MonacoEnvironment.getWorkerUrl = getWorkerUrl;
  }
})();`
  }

  return {
    name: 'nasti:monaco-editor',
    enforce: 'pre',

    configResolved(config) {
      resolvedConfig = config
      // 用 monaco 版本号作为缓存桶，换版本自动重新打包，老缓存不污染
      const version = readMonacoVersion(config.root)
      const key = crypto.createHash('sha1').update(version + '|' + publicPath).digest('hex').slice(0, 8)
      cacheDir = path.resolve(config.root, 'node_modules/.nasti/monaco', key)
    },

    async configureServer(server: DevServer) {
      const shouldBuild = !isCDN(publicPath) || forceBuildCDN

      // 显式把 monaco-editor 从 chokidar watcher 中剔除。node_modules 虽已在默认
      // ignored 列表，但 HMR EMFILE 多次报告源于 Monaco 的深层符号链接/嵌套 node_modules
      // 绕过了默认规则，这里做 defense-in-depth。pnpm 下 node_modules/monaco-editor
      // 是指向 .pnpm store 的 symlink，unwatch 需要用 realpath 才能命中实际被 watch 的路径。
      const watcher: any = (server as any).watcher
      let monacoDir = path.resolve(resolvedConfig.root, 'node_modules/monaco-editor')
      try {
        monacoDir = fs.realpathSync(monacoDir)
      } catch {
        /* not installed */
      }
      try {
        watcher?.unwatch?.(monacoDir)
      } catch {
        /* ignore */
      }

      if (!shouldBuild) return

      // 预热：后台异步打包全部 Worker，避免首次打开页面时阻塞第一次 fetch
      void Promise.all(
        workers.map((w) =>
          buildWorker(w).catch((e: Error) => {
            console.warn(
              `[nasti:monaco-editor] worker build failed for "${w.label}": ${e.message}`,
            )
          }),
        ),
      )

      // Normalize dev middleware prefix to match runtime injection
      const base = resolvedConfig.base.replace(/\/+$/, '') || ''
      const pub = publicPath.replace(/^\/+/, '')
      const prefix = (base ? `${base}/${pub}` : `/${pub}`) + '/'
      server.middlewares.use(
        async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
          if (req.method !== 'GET') return next()
          const url = (req.url ?? '').split('?')[0]
          if (!url.startsWith(prefix)) return next()

          const name = url.slice(prefix.length).replace(/\.worker\.js$/, '')
          const worker = workers.find((w) => w.label === name)
          if (!worker) return next()

          try {
            const file = await buildWorker(worker)
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
            // 产物由版本号 + 打包结果决定，dev 期间可安全长缓存
            res.setHeader('Cache-Control', 'public, max-age=604800, immutable')
            fs.createReadStream(file).pipe(res)
          } catch (e: any) {
            res.statusCode = 500
            res.end(`Monaco worker build failed: ${e.message}`)
          }
        },
      )
    },

    transformIndexHtml(html) {
      const tags: HtmlTagDescriptor[] = [
        {
          tag: 'script',
          children: runtimeInitScript(),
          injectTo: 'head-prepend',
        },
      ]
      if (globalAPI) {
        // 需要 window.monaco 全局 API 时，用 ESM 入口再挂一次
        tags.push({
          tag: 'script',
          attrs: { type: 'module' },
          children:
            `import * as monaco from 'monaco-editor';\n` +
            `self.monaco = monaco;`,
          injectTo: 'head',
        })
      }
      return { html, tags }
    },

    // 生产构建：把所有 Worker 预打包并拷到 outDir/<publicPath>/ 下
    async buildStart() {
      if (resolvedConfig.command !== 'build') return
      if (isCDN(publicPath) && !forceBuildCDN) return

      const outDir = options.customDistPath
        ? options.customDistPath(
            resolvedConfig.root,
            resolvedConfig.build.outDir,
            resolvedConfig.base,
          )
        : isCDN(publicPath)
          ? path.resolve(resolvedConfig.root, resolvedConfig.build.outDir, 'monaco')
          : path.resolve(
              resolvedConfig.root,
              resolvedConfig.build.outDir,
              publicPath.replace(/^\//, ''),
            )
      fs.mkdirSync(outDir, { recursive: true })

      for (const worker of workers) {
        try {
          const cacheFile = await buildWorker(worker)
          fs.copyFileSync(cacheFile, path.join(outDir, `${worker.label}.worker.js`))
        } catch (e: any) {
          throw new Error(
            `[nasti:monaco-editor] worker build failed for "${worker.label}": ${e.message}\n${e.stack || ''}`,
          )
        }
      }
    },
  }
}
