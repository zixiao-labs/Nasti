// Nasti CLI - 命令行入口
import { cac } from 'cac'
import pc from 'picocolors'
import { createLogger, type LogLevel, type Logger } from './core/logger.js'
import type { MinifyOption, NastiMinifyOptions } from './types.js'

const cli = cac('nasti')

interface GlobalCLIOptions {
  logLevel?: LogLevel
  clearScreen?: boolean
  debug?: boolean | string
  filter?: string
  verbose?: boolean
}

/**
 * 处理全局调试选项（须在动态 import 任何核心模块之前调用，
 * core/debug.ts 在模块加载时读取 DEBUG / NASTI_DEBUG_FILTER）。
 */
function setupDebug(options: GlobalCLIOptions): void {
  if (options.debug || options.verbose) {
    const namespaces =
      typeof options.debug === 'string'
        ? options.debug
            .split(',')
            .map((s) => (s.includes(':') ? s : `nasti:${s}`))
            .join(',')
        : 'nasti:*'
    process.env.DEBUG = process.env.DEBUG
      ? `${process.env.DEBUG},${namespaces}`
      : namespaces
  }
  if (options.filter) {
    process.env.NASTI_DEBUG_FILTER = options.filter
  }
}

function createCliLogger(options: GlobalCLIOptions): Logger {
  return createLogger(options.logLevel ?? 'info', {
    allowClearScreen: options.clearScreen !== false,
  })
}

interface MinifyCLIOptions {
  minify?: boolean
  keepNames?: boolean
  mangleProps?: string
}

/**
 * 把压缩相关的 CLI flag 归一为 `build.minify`。
 *
 * 返回 `undefined` 表示「命令行未表态」—— 此时**不能**往 inline config 里塞值，
 * 否则会覆盖掉 nasti.config.ts 里的 `build.minify`（inline 优先级高于文件配置）。
 * 默认值由 config/defaults.ts 的 `minify: true` 提供。
 *
 * 注意不能只看 `options.minify`：cac 给否定式选项（`--no-minify`）自动补了
 * `default: true`，未传任何 flag 时它同样是 `true`，与显式 `--minify` 无法区分。
 * 故显式性一律以 argv 为准。
 */
function resolveCliMinify(
  options: MinifyCLIOptions,
  argv: readonly string[] = process.argv,
): MinifyOption | undefined {
  if (options.minify === false) return false
  if (!options.keepNames && !options.mangleProps) {
    return argv.includes('--minify') ? true : undefined
  }
  const minify: NastiMinifyOptions = {}
  // keepNames 同时覆盖 function 与 class —— CLI 只提供粗粒度开关，
  // 需要分别控制请用配置文件的 mangle.keepNames.{function,class}。
  if (options.keepNames) minify.mangle = { keepNames: true }
  // mangleProps 与 mangle 平级：它独立于标识符重命名之外单独处理属性名。
  if (options.mangleProps) minify.mangleProps = { include: new RegExp(options.mangleProps) }
  return minify
}

function logCliError(logger: Logger, prefix: string, err: unknown): never {
  // 归一为真正的 Error —— 抛出值可能是 string/null/对象，直接读 .message
  // 会崩，且 hasErrorLogged 的 WeakSet 只接受对象
  const error = err instanceof Error ? err : new Error(typeof err === 'string' ? err : String(err))
  // hasErrorLogged 去重：内部已经 logger.error 过的错误不重复打印堆栈
  if (!logger.hasErrorLogged(error)) {
    logger.error(pc.red(`\n  ${prefix}:\n  ${error.message}\n`), { error })
    if (error.stack) logger.error(pc.dim(error.stack))
  }
  process.exit(1)
}

// 全局选项（对所有命令生效）
cli
  .option('--logLevel <level>', 'Log level: info | warn | error | silent')
  .option('--clearScreen', 'Allow/disable clear screen when logging', { default: true })
  .option('-d, --debug [namespaces]', 'Show debug logs (e.g. -d build,hmr)')
  .option('-f, --filter <filter>', 'Filter debug logs by content')
  .option('--verbose', 'Shorthand for --debug (all nasti:* namespaces)')

// nasti dev
cli
  .command('[root]', 'Start dev server')
  .alias('dev')
  .option('--port <port>', 'Port number', { default: 3000 })
  .option('--host [host]', 'Hostname')
  .option('--open [path]', 'Open browser on startup')
  .option('--mode <mode>', 'Set env mode')
  .option('--bundle', 'Experimental: serve a full in-memory bundle via the Rolldown dev engine')
  .action(async (root: string | undefined, options: any) => {
    setupDebug(options)
    const logger = createCliLogger(options)
    try {
      const { createServer } = await import('./server/index.js')
      const server = await createServer({
        root: root ?? '.',
        mode: options.mode ?? 'development',
        logLevel: options.logLevel,
        clearScreen: options.clearScreen,
        customLogger: logger,
        ...(options.bundle ? { experimental: { bundledDev: true } } : {}),
        server: {
          port: options.port,
          host: options.host,
          open: options.open,
        },
      })
      await server.listen()
    } catch (err: any) {
      logCliError(logger, 'Error starting dev server', err)
    }
  })

// nasti build
cli
  .command('build [root]', 'Build for production')
  .option('--outDir <dir>', 'Output directory', { default: 'dist' })
  .option('--sourcemap', 'Generate source map')
  .option('--minify', 'Enable minification (override config)')
  .option('--no-minify', 'Disable minification')
  .option('--keep-names', 'Preserve function and class names through minification')
  .option('--mangle-props <regex>', 'Minify property names matching this regex (e.g. "^_")')
  .option('--mode <mode>', 'Set env mode')
  .option('--target <target>', 'Build target: web | electron', { default: 'web' })
  .action(async (root: string | undefined, options: any) => {
    setupDebug(options)
    const logger = createCliLogger(options)
    try {
      const target = options.target
      if (target !== 'web' && target !== 'electron') {
        throw new Error(`Invalid --target "${target}". Expected "web" or "electron".`)
      }
      const inline = {
        root: root ?? '.',
        mode: options.mode ?? 'production',
        target,
        logLevel: options.logLevel,
        clearScreen: options.clearScreen,
        customLogger: logger,
        build: {
          outDir: options.outDir,
          sourcemap: options.sourcemap,
          minify: resolveCliMinify(options),
        },
      }
      if (target === 'electron') {
        const { buildElectron } = await import('./build/electron.js')
        await buildElectron(inline)
      } else {
        const { build } = await import('./build/index.js')
        await build(inline)
      }
    } catch (err: any) {
      logCliError(logger, 'Build failed', err)
    }
  })

// nasti electron - 启动 Electron 开发模式
cli
  .command('electron [root]', 'Start Electron dev mode (requires electron ^41)')
  .alias('electron-dev')
  .option('--port <port>', 'Renderer dev server port', { default: 3000 })
  .option('--host [host]', 'Hostname')
  .option('--mode <mode>', 'Set env mode')
  .option('--no-spawn', 'Compile main/preload but do not spawn Electron')
  .option('--no-restart', 'Disable auto-restart on main/preload changes')
  .action(async (root: string | undefined, options: any) => {
    setupDebug(options)
    const logger = createCliLogger(options)
    try {
      const { startElectronDev } = await import('./server/electron-dev.js')
      await startElectronDev({
        root: root ?? '.',
        mode: options.mode ?? 'development',
        target: 'electron',
        logLevel: options.logLevel,
        clearScreen: options.clearScreen,
        customLogger: logger,
        server: {
          port: options.port,
          host: options.host,
        },
        electron: {
          autoRestart: options.restart !== false,
        },
        noSpawn: options.spawn === false,
      })
    } catch (err: any) {
      logCliError(logger, 'Electron dev failed', err)
    }
  })

// nasti electron-build - Electron 生产构建
cli
  .command('electron-build [root]', 'Build Electron app for production')
  .option('--outDir <dir>', 'Output directory', { default: 'dist' })
  .option('--sourcemap', 'Generate source map')
  .option('--minify', 'Enable minification (override config)')
  .option('--no-minify', 'Disable minification')
  .option('--keep-names', 'Preserve function and class names through minification')
  .option('--mangle-props <regex>', 'Minify property names matching this regex (e.g. "^_")')
  .option('--mode <mode>', 'Set env mode')
  .action(async (root: string | undefined, options: any) => {
    setupDebug(options)
    const logger = createCliLogger(options)
    try {
      const { buildElectron } = await import('./build/electron.js')
      await buildElectron({
        root: root ?? '.',
        mode: options.mode ?? 'production',
        target: 'electron',
        logLevel: options.logLevel,
        clearScreen: options.clearScreen,
        customLogger: logger,
        build: {
          outDir: options.outDir,
          sourcemap: options.sourcemap,
          minify: resolveCliMinify(options),
        },
      })
    } catch (err: any) {
      logCliError(logger, 'Electron build failed', err)
    }
  })

// nasti preview
cli
  .command('preview [root]', 'Preview production build')
  .option('--port <port>', 'Port number', { default: 4173 })
  .option('--host [host]', 'Hostname')
  .option('--outDir <dir>', 'Output directory to serve', { default: 'dist' })
  .action(async (root: string | undefined, options: any) => {
    setupDebug(options)
    const logger = createCliLogger(options)
    try {
      const http = await import('node:http')
      const path = await import('node:path')
      const os = await import('node:os')
      const sirv = (await import('sirv')).default
      const connect = (await import('connect')).default
      const { printServerUrls } = await import('./core/logger.js')

      const resolvedRoot = path.resolve(root ?? '.')
      const outDir = path.resolve(resolvedRoot, options.outDir)

      const app = connect()
      app.use(sirv(outDir, { single: true, etag: true, gzip: true, brotli: true }))

      const port = options.port
      const host = options.host === true ? '0.0.0.0' : (options.host ?? 'localhost')

      http.createServer(app).listen(port, host, () => {
        logger.info(`\n  ${pc.cyan(pc.bold('NASTI'))} ${pc.cyan(`v${__NASTI_VERSION__}`)}  ${pc.dim('preview')}\n`)
        printServerUrls(
          {
            local: [`http://localhost:${port}/`],
            // 0.0.0.0 本身不可访问：枚举真实网卡的非内网 IPv4 地址
            network:
              host === '0.0.0.0'
                ? Object.values(os.networkInterfaces())
                    .flat()
                    .filter((i) => i && i.family === 'IPv4' && !i.internal)
                    .map((i) => `http://${i!.address}:${port}/`)
                : [],
          },
          logger.info,
        )
        logger.info('')
      })
    } catch (err: any) {
      logCliError(logger, 'Preview failed', err)
    }
  })

cli.help()
cli.version(__NASTI_VERSION__)

cli.parse()
