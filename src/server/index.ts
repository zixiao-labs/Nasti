// Dev Server 主逻辑
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import connect from 'connect'
import sirv from 'sirv'
import { watch } from 'chokidar'
import pc from 'picocolors'
import type { NastiConfig, ResolvedConfig, DevServer } from '../types.js'
import { resolveConfig } from '../config/index.js'
import { NastiEnvironment } from '../core/environment.js'
import { createWsHotChannel } from '../core/hot-channel.js'
import { printServerUrls } from '../core/logger.js'
import { createWebSocketServer } from './ws.js'
import { transformMiddleware } from './middleware.js'
import { handleFileChange } from './hmr.js'
import { resolvePluginList } from '../plugins/builtins.js'

export async function createServer(inlineConfig: NastiConfig = {}): Promise<DevServer> {
  const startTime = performance.now()
  const config = await resolveConfig(inlineConfig, 'serve')
  const logger = config.logger

  // 组装内置插件 + 用户插件（per-env 统一拼装函数）
  const allPlugins = resolvePluginList(config, config.plugins)
  const configWithPlugins: ResolvedConfig = { ...config, plugins: allPlugins }

  // HTTP 服务
  const app = connect()
  const httpServer = http.createServer(app)
  const ws = createWebSocketServer(httpServer)

  // ── Environment API：client 环境承载 dev 运行时（per-env 容器/图/热通道）──
  // ssr 等其余环境：server consumer 的插件列表带 consumer 标记（css 无 DOM stub），
  // 容器在首次使用（ssrLoadModule）时初始化 —— 生命周期钩子默认 client 单次触发。
  const clientEnv = new NastiEnvironment('client', configWithPlugins, {
    hot: createWsHotChannel(ws),
    mode: 'dev',
    plugins: allPlugins,
  })
  await clientEnv.init()
  const environments: Record<string, NastiEnvironment> = { client: clientEnv }
  for (const name of Object.keys(config.environments)) {
    if (name === 'client') continue
    const consumer = config.environments[name].consumer
    const envPlugins = resolvePluginList(config, config.plugins, { consumer })
    environments[name] = new NastiEnvironment(name, { ...config, plugins: envPlugins }, {
      mode: 'dev',
      plugins: envPlugins,
    })
  }

  // SSR module runner（懒初始化：仅在 ssrLoadModule 首次调用时建容器/runner）
  let ssrRunner: import('./runnable-environment.js').NastiModuleRunner | null = null
  async function getSsrRunner() {
    if (ssrRunner) return ssrRunner
    const ssrEnv = environments.ssr
    if (!ssrEnv) {
      throw new Error('[nasti] no "ssr" environment configured (config.environments.ssr)')
    }
    await ssrEnv.init()
    const { createModuleRunner } = await import('./runnable-environment.js')
    ssrRunner = createModuleRunner(ssrEnv)
    return ssrRunner
  }

  const moduleGraph = clientEnv.moduleGraph
  const pluginContainer = clientEnv.pluginContainer!

  // ── 完整打包模式（opt-in，experimental.bundledDev / --bundle）──────────
  // DevEngine 整体打包 client 环境，产物从内存服务；中间件注册在
  // transformMiddleware 之前（接管 '/'、/assets/*、懒编译端点）。
  // unbundled 管线保持默认 —— 不开启时下面这段完全不执行。
  let bundledServer: import('./bundled/dev-engine.js').BundledDevServer | null = null
  if (config.experimental.bundledDev) {
    const { createBundledDevServer } = await import('./bundled/dev-engine.js')
    bundledServer = await createBundledDevServer({
      config: configWithPlugins,
      clientEnv,
      httpServer,
    })
    app.use(bundledServer.middleware)
  }

  // 转译中间件（处理 .ts, .tsx, .jsx, .css, .vue 等）
  app.use(transformMiddleware({
    config: configWithPlugins,
    pluginContainer,
    moduleGraph,
  }))

  // 静态文件服务（public 目录 + 项目根目录）
  const publicDir = path.resolve(config.root, 'public')
  app.use(sirv(publicDir, { dev: true, etag: true }))
  app.use(sirv(config.root, { dev: true, etag: true }))

  // 文件监听
  // chokidar v4 不再把 `ignored` 字符串当作 glob 处理，而是按字面值精确匹配
  // （见 chokidar/esm/index.js 的 createPattern），原先的 `**/node_modules/**`
  // 等模式根本不会命中任何路径，导致 watcher 递归进入 node_modules 并对每个
  // 子目录调用 fs.watch，在 macOS 上很快耗尽 fd 触发 EMFILE。改用函数 matcher
  // 显式判定相对段。
  const ignoredSegments = new Set(['node_modules', '.git', '.nasti'])
  const outDirAbs = path.resolve(config.root, config.build.outDir)
  const watcher = watch(config.root, {
    ignored: (filePath: string) => {
      if (filePath === config.root) return false
      if (filePath === outDirAbs || filePath.startsWith(outDirAbs + path.sep)) return true
      const rel = path.relative(config.root, filePath)
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false
      for (const seg of rel.split(path.sep)) {
        if (ignoredSegments.has(seg)) return true
      }
      return false
    },
    ignoreInitial: true,
  })

  // 先声明 server 变量，再赋值
  let server: DevServer

  watcher.on('change', (file: string) => {
    ssrRunner?.invalidateFile(file)
    handleFileChange(file, server)
  })

  watcher.on('add', (file: string) => {
    ssrRunner?.invalidateFile(file)
    handleFileChange(file, server)
  })

  server = {
    config: configWithPlugins,
    middlewares: app,
    moduleGraph: moduleGraph as any,
    watcher,
    ws,
    environments,

    async listen(port?: number) {
      const finalPort = port ?? config.server.port
      const host = config.server.host === true ? '0.0.0.0' : (config.server.host as string)

      await pluginContainer.buildStart()

      return new Promise((resolve, reject) => {
        let currentPort = finalPort

        const onListening = () => {
          const actualPort = (httpServer.address() as any)?.port ?? currentPort
          config.server.port = actualPort
          const localUrl = `http://localhost:${actualPort}/`
          const networkUrl = host === '0.0.0.0' ? `http://${getNetworkAddress()}:${actualPort}/` : null

          logger.clearScreen('info')
          const readyIn = Math.ceil(performance.now() - startTime)
          logger.info(
            `\n  ${pc.cyan(pc.bold('NASTI'))} ${pc.cyan(`v${__NASTI_VERSION__}`)}  ${pc.dim('ready in')} ${pc.bold(readyIn)} ${pc.dim('ms')}\n`,
          )
          printServerUrls(
            { local: [localUrl], network: networkUrl ? [networkUrl] : [] },
            logger.info,
          )
          logger.info('')

          resolve(server)
        }

        httpServer.on('listening', onListening)
        httpServer.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            currentPort++
            logger.info(pc.yellow(`Port ${currentPort - 1} is in use, trying ${currentPort}...`))
            httpServer.listen(currentPort, host)
          } else {
            reject(err)
          }
        })

        httpServer.listen(currentPort, host)
      })
    },

    async transformRequest(url: string) {
      const { transformRequest } = await import('./middleware.js')
      return transformRequest(url, { config: configWithPlugins, pluginContainer, moduleGraph })
    },

    async ssrLoadModule(url: string) {
      const runner = await getSsrRunner()
      return runner.import(url)
    },

    async close() {
      await pluginContainer.buildEnd()
      await bundledServer?.close()
      watcher.close()
      ws.close()
      httpServer.close()
    },
  }

  // 执行插件的 configureServer 钩子（此时 server 已完全初始化，
  // 插件可安全访问 server.middlewares / server.watcher 等）
  const postMiddlewares: Array<() => void> = []
  for (const plugin of allPlugins) {
    if (plugin.configureServer) {
      const result = await plugin.configureServer(server)
      if (typeof result === 'function') {
        postMiddlewares.push(result)
      }
    }
  }
  // 插件返回的函数会在内置中间件之后执行
  for (const run of postMiddlewares) run()

  return server
}

function getNetworkAddress(): string {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  return 'localhost'
}
