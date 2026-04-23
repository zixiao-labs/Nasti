// Nasti CLI - 命令行入口
import { cac } from 'cac'
import pc from 'picocolors'

const cli = cac('nasti')

// nasti dev
cli
  .command('[root]', 'Start dev server')
  .alias('dev')
  .option('--port <port>', 'Port number', { default: 3000 })
  .option('--host [host]', 'Hostname')
  .option('--open [path]', 'Open browser on startup')
  .option('--mode <mode>', 'Set env mode')
  .action(async (root: string | undefined, options: any) => {
    try {
      const { createServer } = await import('./server/index.js')
      const server = await createServer({
        root: root ?? '.',
        mode: options.mode ?? 'development',
        server: {
          port: options.port,
          host: options.host,
          open: options.open,
        },
      })
      await server.listen()
    } catch (err: any) {
      console.error(pc.red(`\n  Error starting dev server:\n  ${err.message}\n`))
      if (err.stack) console.error(pc.dim(err.stack))
      process.exit(1)
    }
  })

// nasti build
cli
  .command('build [root]', 'Build for production')
  .option('--outDir <dir>', 'Output directory', { default: 'dist' })
  .option('--sourcemap', 'Generate source map')
  .option('--minify', 'Minify output', { default: true })
  .option('--mode <mode>', 'Set env mode')
  .option('--target <target>', 'Build target: web | electron', { default: 'web' })
  .action(async (root: string | undefined, options: any) => {
    try {
      const target = options.target
      if (target !== 'web' && target !== 'electron') {
        throw new Error(`Invalid --target "${target}". Expected "web" or "electron".`)
      }
      const inline = {
        root: root ?? '.',
        mode: options.mode ?? 'production',
        target,
        build: {
          outDir: options.outDir,
          sourcemap: options.sourcemap,
          minify: options.minify,
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
      console.error(pc.red(`\n  Build failed:\n  ${err.message}\n`))
      if (err.stack) console.error(pc.dim(err.stack))
      process.exit(1)
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
    try {
      const { startElectronDev } = await import('./server/electron-dev.js')
      await startElectronDev({
        root: root ?? '.',
        mode: options.mode ?? 'development',
        target: 'electron',
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
      console.error(pc.red(`\n  Electron dev failed:\n  ${err.message}\n`))
      if (err.stack) console.error(pc.dim(err.stack))
      process.exit(1)
    }
  })

// nasti electron-build - Electron 生产构建
cli
  .command('electron-build [root]', 'Build Electron app for production')
  .option('--outDir <dir>', 'Output directory', { default: 'dist' })
  .option('--sourcemap', 'Generate source map')
  .option('--minify', 'Minify output', { default: true })
  .option('--mode <mode>', 'Set env mode')
  .action(async (root: string | undefined, options: any) => {
    try {
      const { buildElectron } = await import('./build/electron.js')
      await buildElectron({
        root: root ?? '.',
        mode: options.mode ?? 'production',
        target: 'electron',
        build: {
          outDir: options.outDir,
          sourcemap: options.sourcemap,
          minify: options.minify,
        },
      })
    } catch (err: any) {
      console.error(pc.red(`\n  Electron build failed:\n  ${err.message}\n`))
      if (err.stack) console.error(pc.dim(err.stack))
      process.exit(1)
    }
  })

// nasti react-native - React Native / Expo 打包
cli
  .command('react-native [root]', 'Bundle for React Native / Expo')
  .alias('rn')
  .option('--platform <platform>', 'Target platform: ios | android', { default: 'android' })
  .option('--entry <file>', 'Entry file (default: index.ts or index.js)')
  .option('--outDir <dir>', 'Output directory', { default: 'dist' })
  .option('--sourcemap', 'Generate source map')
  .option('--minify', 'Minify output', { default: false })
  .option('--mode <mode>', 'Set env mode')
  .action(async (root: string | undefined, options: any) => {
    try {
      const platform = options.platform
      if (platform !== 'ios' && platform !== 'android') {
        throw new Error(`Invalid --platform "${platform}". Expected "ios" or "android".`)
      }
      const { buildReactNative } = await import('./build/react-native.js')
      await buildReactNative({
        root: root ?? '.',
        mode: options.mode ?? 'production',
        target: 'react-native',
        reactNative: {
          platform,
          ...(options.entry ? { entry: options.entry } : {}),
        },
        build: {
          outDir: options.outDir,
          sourcemap: options.sourcemap,
          minify: options.minify,
        },
      })
    } catch (err: any) {
      console.error(pc.red(`\n  React Native build failed:\n  ${err.message}\n`))
      if (err.stack) console.error(pc.dim(err.stack))
      process.exit(1)
    }
  })

// nasti preview
cli
  .command('preview [root]', 'Preview production build')
  .option('--port <port>', 'Port number', { default: 4173 })
  .option('--host [host]', 'Hostname')
  .option('--outDir <dir>', 'Output directory to serve', { default: 'dist' })
  .action(async (root: string | undefined, options: any) => {
    try {
      const http = await import('node:http')
      const path = await import('node:path')
      const sirv = (await import('sirv')).default
      const connect = (await import('connect')).default

      const resolvedRoot = path.resolve(root ?? '.')
      const outDir = path.resolve(resolvedRoot, options.outDir)

      const app = connect()
      app.use(sirv(outDir, { single: true, etag: true, gzip: true, brotli: true }))

      const port = options.port
      const host = options.host === true ? '0.0.0.0' : (options.host ?? 'localhost')

      http.createServer(app).listen(port, host, () => {
        console.log()
        console.log(pc.cyan('  🔍 nasti preview'))
        console.log()
        console.log(`  ${pc.green('➜')} Local: ${pc.cyan(`http://localhost:${port}`)}`)
        console.log()
      })
    } catch (err: any) {
      console.error(pc.red(`\n  Preview failed:\n  ${err.message}\n`))
      process.exit(1)
    }
  })

cli.help()
cli.version(__NASTI_VERSION__)

cli.parse()
