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
  .action(async (root: string | undefined, options: any) => {
    try {
      const { build } = await import('./build/index.js')
      await build({
        root: root ?? '.',
        mode: options.mode ?? 'production',
        build: {
          outDir: options.outDir,
          sourcemap: options.sourcemap,
          minify: options.minify,
        },
      })
    } catch (err: any) {
      console.error(pc.red(`\n  Build failed:\n  ${err.message}\n`))
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
cli.version('0.0.1')

cli.parse()
