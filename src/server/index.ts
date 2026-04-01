// Dev Server 主逻辑
import http from 'node:http'
import path from 'node:path'
import connect from 'connect'
import sirv from 'sirv'
import { watch } from 'chokidar'
import pc from 'picocolors'
import type { NastiConfig, ResolvedConfig, DevServer } from '../types.js'
import { resolveConfig } from '../config/index.js'
import { PluginContainer } from '../core/plugin-container.js'
import { ModuleGraph } from '../core/module-graph.js'
import { createWebSocketServer } from './ws.js'
import { transformMiddleware } from './middleware.js'
import { handleFileChange } from './hmr.js'
import { resolvePlugin } from '../plugins/resolve.js'
import { cssPlugin } from '../plugins/css.js'
import { assetsPlugin } from '../plugins/assets.js'
import { htmlPlugin } from '../plugins/html.js'

export async function createServer(inlineConfig: NastiConfig = {}): Promise<DevServer> {
  const config = await resolveConfig(inlineConfig, 'serve')

  // 组装内置插件 + 用户插件
  const allPlugins = [
    resolvePlugin(config),
    cssPlugin(config),
    assetsPlugin(config),
    htmlPlugin(config),
    ...config.plugins,
  ]
  const configWithPlugins: ResolvedConfig = { ...config, plugins: allPlugins }

  const moduleGraph = new ModuleGraph()
  const pluginContainer = new PluginContainer(configWithPlugins)

  // HTTP 服务
  const app = connect()

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

  const httpServer = http.createServer(app)
  const ws = createWebSocketServer(httpServer)

  // 文件监听
  const watcher = watch(config.root, {
    ignored: [
      '**/node_modules/**',
      '**/.git/**',
      `**/${config.build.outDir}/**`,
    ],
    ignoreInitial: true,
  })

  // 先声明 server 变量，再赋值
  let server: DevServer

  watcher.on('change', (file: string) => {
    handleFileChange(file, server)
  })

  watcher.on('add', (file: string) => {
    handleFileChange(file, server)
  })

  // 执行插件的 configureServer 钩子
  const postMiddlewares: Array<() => void> = []
  for (const plugin of allPlugins) {
    if (plugin.configureServer) {
      const result = await plugin.configureServer(server! as any)
      if (typeof result === 'function') {
        postMiddlewares.push(result)
      }
    }
  }

  server = {
    config: configWithPlugins,
    middlewares: app,
    moduleGraph: moduleGraph as any,
    watcher,
    ws,

    async listen(port?: number) {
      const finalPort = port ?? config.server.port
      const host = config.server.host === true ? '0.0.0.0' : (config.server.host as string)

      await pluginContainer.buildStart()

      return new Promise((resolve, reject) => {
        httpServer.listen(finalPort, host, () => {
          const localUrl = `http://localhost:${finalPort}`
          const networkUrl = host === '0.0.0.0' ? `http://${getNetworkAddress()}:${finalPort}` : null

          console.log()
          console.log(pc.cyan('  nasti dev server') + pc.dim(` v0.0.1`))
          console.log()
          console.log(`  ${pc.green('>')} Local:   ${pc.cyan(localUrl)}`)
          if (networkUrl) {
            console.log(`  ${pc.green('>')} Network: ${pc.cyan(networkUrl)}`)
          }
          console.log()

          resolve(server)
        })
        httpServer.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            console.log(pc.yellow(`Port ${finalPort} is in use, trying ${finalPort + 1}...`))
            httpServer.listen(finalPort + 1, host)
          } else {
            reject(err)
          }
        })
      })
    },

    async transformRequest(url: string) {
      const { transformRequest } = await import('./middleware.js')
      return transformRequest(url, { config: configWithPlugins, pluginContainer, moduleGraph })
    },

    async close() {
      await pluginContainer.buildEnd()
      watcher.close()
      ws.close()
      httpServer.close()
    },
  }

  return server
}

function getNetworkAddress(): string {
  const os = require('node:os')
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
