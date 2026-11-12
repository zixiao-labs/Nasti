import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { EnvironmentBuildOutput, EnvironmentServeResult, NastiPlugin, ResolvedConfig } from '../types.js'
import { resolveProjectImport } from '../core/project-import.js'

const ASTRO_VERSION = '7.4.11'
const MARKER = 'nasti-astro.json'

export interface AstroOptions {
  /** Astro owns routes, integrations, adapters and Vite configuration in this file. */
  configFile?: string | false
}

async function resolveAstro(root: string) {
  const [major, minor, patch] = process.versions.node.split('.').map(Number)
  if (major < 22 || major === 22 && (minor < 23 || minor === 23 && patch < 4)) {
    throw new Error('[nasti:astro] Astro 7.4.11 requires Node >=22.23.4. Ordinary Nasti projects retain their existing Node support.')
  }
  const pkg = JSON.parse(await fs.readFile(new URL(resolveProjectImport(root, 'astro/package.json')), 'utf8'))
  if (pkg.version !== ASTRO_VERSION) {
    throw new Error(`[nasti:astro] Expected astro@${ASTRO_VERSION}, received ${pkg.version}. ` +
      'The experimental programmatic API must be revalidated before upgrading.')
  }
  return resolveProjectImport(root, 'astro')
}

// Astro's prerender output and process-wide NODE_ENV depend on cwd. A separate
// process per operation keeps application dependencies/caches isolated without
// process.chdir(), global env mutation, or concurrent-site runtime collisions.
const RUNNER = `
let server;
async function close() {
  try { await server?.stop(); process.exit(0); }
  catch (error) { console.error(error); process.exit(1); }
}
process.on('message', (message) => { if (message === 'close') void close(); });
process.on('disconnect', () => { void close(); });
try {
  const [entry, command, serialized] = process.argv.slice(1);
  const api = await import(entry);
  const result = await api[command](JSON.parse(serialized));
  server = result;
  const data = command === 'dev'
    ? { address: result.address, resolvedUrls: result.resolvedUrls }
    : command === 'preview' ? { port: result.port, host: result.host } : {};
  await new Promise((resolve, reject) => process.send(data, (error) => error ? reject(error) : resolve()));
  if (command === 'build') process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
`

async function runAstro(command: 'build' | 'dev' | 'preview', root: string, options: Record<string, unknown>) {
  const entry = await resolveAstro(root)
  const child = spawn(process.execPath, ['--input-type=module', '--eval', RUNNER, entry, command, JSON.stringify(options)], {
    cwd: root,
    env: { ...process.env, NODE_ENV: command === 'dev' ? 'development' : 'production' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  let stopping = false
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => code === 0 && (command === 'build' || stopping) ? resolve()
      : reject(new Error(`[nasti:astro] ${command} exited with ${signal ?? `code ${code}`}. See Astro's diagnostics above.`)))
  })
  // Observe startup rejection here; the owning service observes later exits.
  const ready = new Promise<any>((resolve, reject) => {
    child.once('message', resolve)
    void closed.then(() => reject(new Error(`[nasti:astro] ${command} exited before becoming ready.`)), reject)
  })
  const data = await ready
  if (command === 'build') await closed
  return {
    ...data,
    closed: () => closed,
    async stop() {
      if (!stopping && child.connected) {
        stopping = true
        child.send('close')
      }
      await closed
    },
  }
}

function inlineConfig(config: ResolvedConfig, options: AstroOptions) {
  return {
    ...options,
    root: config.root,
    outDir: path.resolve(config.root, config.build.outDir),
    cacheDir: path.join(config.root, '.astro'),
    base: config.base,
    mode: config.mode,
    logLevel: config.logLevel,
  }
}

async function collectOutput(directory: string, prefix = ''): Promise<EnvironmentBuildOutput[]> {
  const output: EnvironmentBuildOutput[] = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const fileName = prefix + entry.name
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) output.push(...await collectOutput(file, fileName + '/'))
    else if (entry.isFile()) output.push({ type: 'asset', fileName, source: await fs.readFile(file) })
  }
  return output
}

/**
 * Whole-site Astro integration using the existing external Environment Driver.
 * Astro owns its compiler, Vite graph, islands, routing, adapters and file watcher;
 * Nasti owns invocation, output metadata and cleanup, not Astro's transform hooks.
 */
export function astro(options: AstroOptions = {}): NastiPlugin {
  return {
    name: 'nasti:astro',
    config(config) {
      if (config.framework && !['auto', 'astro'].includes(config.framework)) {
        throw new Error('[nasti:astro] astro() requires framework: "astro" or "auto".')
      }
      const client = config.environments?.client
      if (client?.driver && client.driver !== 'astro') {
        throw new Error('[nasti:astro] The client environment already has another driver.')
      }
      return {
        framework: 'astro',
        environments: {
          ...config.environments,
          client: { ...client, driver: 'astro' },
        },
      }
    },
    configResolved(config) {
      if (config.target === 'electron' || config.experimental.bundledDev) {
        throw new Error('[nasti:astro] Astro owns the web pipeline; Electron and bundledDev are not supported.')
      }
    },
    createEnvironmentDriver(environment) {
      if (environment.name !== 'client' || environment.options.driver !== 'astro') return
      let devServer: { stop(): Promise<void> } | undefined
      return {
        name: 'astro',
        async build({ config }) {
          await runAstro('build', config.root, inlineConfig(config, options))
          const outDir = path.resolve(config.root, config.build.outDir)
          await fs.writeFile(path.join(outDir, MARKER), JSON.stringify({ version: 1, base: config.base, ...options }))
          const output = await collectOutput(outDir)
          return {
            output,
            entries: Object.fromEntries(output.filter((file) => file.fileName.endsWith('.html'))
              .map((file) => [file.fileName, file.fileName])),
            publicPath: config.base,
            manifest: { framework: 'astro', engine: 'astro' },
          }
        },
        async serve({ config }) {
          const server = await runAstro('dev', config.root, {
            ...inlineConfig(config, options),
            server: { host: config.server.host, port: 0, open: false },
          })
          devServer = server
          const address = server.address
          const wildcardHost = ['0.0.0.0', '::'].includes(address.address)
          const host = wildcardHost ? 'localhost'
            : address.family === 'IPv6' ? `[${address.address}]` : address.address
          const origin = `http://${host}:${address.port}`
          // Keep Astro's WebSocket origin intact instead of partially proxying
          // HTTP while silently breaking Vite HMR or island module loading.
          const service: EnvironmentServeResult = {
            localUrls: server.resolvedUrls?.local ?? [origin + config.base],
            networkUrls: server.resolvedUrls?.network ?? [],
            middleware(request, response) {
              if (devServer !== server) {
                response.statusCode = 503
                response.end('Astro development server is not running.')
                return
              }
              const localAddress = wildcardHost ? request.socket.localAddress : undefined
              const destination = localAddress
                ? `http://${localAddress.includes(':') ? `[${localAddress}]` : localAddress}:${address.port}` : origin
              response.writeHead(307, { Location: destination + (request.url?.startsWith('/') ? request.url : '/') })
              response.end()
            },
          }
          void server.closed().catch((error: Error) => {
            devServer = undefined
            service.localUrls = []
            service.networkUrls = []
            config.logger.error(error.message, { error })
            environment.hot.send({ type: 'error', err: { message: error.message, stack: error.stack } })
          })
          return service
        },
        async close() {
          const server = devServer
          devServer = undefined
          await server?.stop()
        },
      }
    },
  }
}

/** Preview static or adapter-backed output with Astro, never expose SSR files via sirv. */
export async function createAstroPreview(
  root: string,
  outDir: string,
  server: { port?: number; host?: string | boolean } = {},
): Promise<{ port: number; host?: string; base: string; stop(): Promise<void>; closed(): Promise<void> }> {
  const marker = JSON.parse(await fs.readFile(path.join(outDir, MARKER), 'utf8'))
  if (marker.version !== 1) throw new Error('[nasti:astro] Unsupported build metadata. Rebuild the site.')
  const preview = await runAstro('preview', path.resolve(root), {
    root: path.resolve(root),
    outDir: path.resolve(outDir),
    cacheDir: path.resolve(root, '.astro'),
    base: marker.base,
    configFile: marker.configFile,
    server,
  })
  return Object.assign(preview, { base: marker.base ?? '/' })
}
