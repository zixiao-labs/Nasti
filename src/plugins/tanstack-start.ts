import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { isBuiltin } from 'node:module'
import type {
  DevServer, EnvironmentBuildOutput, EnvironmentInstance, NastiPlugin, ResolvedConfig,
} from '../types.js'
import { importStartCompiler, resolveProjectImport } from '../core/project-import.js'
import { setupPluginApi } from '../core/plugin-api.js'
import { detectFramework } from '../config/index.js'
import { tanstackRouter, type TanStackRouterOptions } from './tanstack-router.js'
import { dispatchFetch } from '../server/fetch-handler.js'
import sirv from 'sirv'

export interface TanStackStartOptions {
  framework?: 'react' | 'solid'
  srcDirectory?: string
  router?: Omit<TanStackRouterOptions, 'framework'>
  /** Entry overrides, relative to the app root. No index.html is needed. */
  entries?: { router?: string; start?: string; client?: string; server?: string }
  serverFns?: { base?: string }
}

const MANIFEST = 'tanstack-start-manifest:v'
const RESOLVER = '#tanstack-start-server-fn-resolver'
const ADAPTERS = '#tanstack-start-plugin-adapters'
const SPLIT = '?tss-serverfn-split'
const virtual = (id: string) => '\0nasti:start:' + id
const slash = (value: string) => value.replace(/\\/g, '/')
const quote = JSON.stringify

interface ServerFunction {
  functionName: string
  functionId: string
  filename: string
  extractedFilename: string
  isClientReferenced?: boolean
}
interface Compiler {
  compile(input: { code: string; id: string }): Promise<{ code: string; map?: unknown } | null>
  ingestModule(input: { code: string; id: string }): unknown
}
interface CompilerHost {
  createStartCompiler(options: Record<string, unknown>): Compiler
  mergeServerFnsById(current: Record<string, ServerFunction>, next: Record<string, ServerFunction>): void
  compileRoute(options: Record<string, unknown>): { code: string } | null
}
interface FetchEntry {
  fetch(request: Request): Response | Promise<Response>
}

/**
 * Native Start host. Compiler → OXC/Solid → Rolldown, never the Vite plugin.
 * Development uses the same complete two-environment build, with full reloads.
 */
export function tanstackStart(options: TanStackStartOptions = {}): NastiPlugin {
  const src = options.srcDirectory ?? 'src'
  const router = tanstackRouter({
    ...options.router,
    framework: options.framework,
    routesDirectory: options.router?.routesDirectory ?? `${src}/routes`,
    generatedRouteTree: options.router?.generatedRouteTree ?? `${src}/routeTree.gen.ts`,
  })
  let config: ResolvedConfig
  let host: CompilerHost
  let framework: 'react' | 'solid'
  let entries: Record<string, string>
  let manifest: unknown
  let functions: Record<string, ServerFunction> = {}
  const compilers = new WeakMap<EnvironmentInstance, Compiler>()
  let server: DevServer | undefined
  let generation = 0
  let closed = false
  let pending: Promise<FetchEntry> | undefined
  let pendingGeneration = -1
  let builds = Promise.resolve()
  const session = randomUUID()
  const assets = new Map<string, EnvironmentBuildOutput>()
  const changed = (file: string) => {
    const normalized = slash(file)
    if (normalized.includes('/.nasti/') || normalized.includes('/node_modules/') ||
        normalized.includes('/.git/') ||
        normalized === slash(path.resolve(config.root, options.router?.generatedRouteTree ?? `${src}/routeTree.gen.ts`)) ||
        normalized.startsWith(slash(path.resolve(config.root, config.build.outDir)) + '/')) return
    generation++
    server?.ws.send({ type: 'full-reload' })
  }
  const currentBuild = () => {
    if (pending && pendingGeneration === generation) return pending
    const version = generation
    pendingGeneration = version
    // The compiler manifest belongs to one build. Serialize generations so a
    // save during a request cannot mix client/server manifests from two builds.
    pending = builds.catch(() => {}).then(async () => {
      if (closed) throw new Error('[nasti:start] Server is closed.')
      const { buildResolvedConfig } = await import('../build/index.js')
      const dir = path.join(config.root, '.nasti/start/dev', session, String(version))
      const buildOptions = { ...config.build, outDir: path.join(dir, 'client'), minify: false }
      const buildConfig: ResolvedConfig = {
        ...config,
        command: 'build',
        build: buildOptions,
        environments: {
          client: { ...config.environments.client, build: buildOptions },
          ssr: {
            ...config.environments.ssr,
            build: { ...config.environments.ssr.build, outDir: path.join(dir, 'server') },
          },
        },
      }
      await setupPluginApi(buildConfig, buildConfig.plugins)
      const result = await buildResolvedConfig(buildConfig)
      for (const output of result.output) assets.set(config.base + output.fileName, output)
      const entry = result.environmentResults?.ssr.entries?.server
      if (!entry) throw new Error('[nasti:start] Missing server build entry.')
      const mod = await import(pathToFileURL(path.join(dir, 'server', entry)).href)
      if (typeof mod.default?.fetch !== 'function') {
        throw new Error('[nasti:start] Server entry must export default { fetch(request) }.')
      }
      return mod.default as FetchEntry
    })
    builds = pending.then(() => {}, () => {})
    const current = pending
    pending.catch(() => { if (pending === current) pending = undefined })
    return pending
  }
  return {
    name: 'nasti:tanstack-start',
    enforce: 'pre',
    post: ['nasti:resolve', 'nasti:solid'],
    config(input, env) {
      const out = input.build?.outDir ?? 'dist'
      const target = options.framework ?? (input.framework && input.framework !== 'auto'
        ? input.framework : detectFramework(path.resolve(input.root ?? '.')))
      if (!['react', 'solid'].includes(target)) {
        throw new Error('[nasti:start] Start requires framework: "react" or "solid".')
      }
      const base = input.base ?? '/'
      if (!base.startsWith('/') || base.startsWith('//') || !base.endsWith('/') || /[?#]/.test(base)) {
        throw new Error('[nasti:start] base must be an absolute URL pathname ending in "/".')
      }
      const fnBase = options.serverFns?.base ?? '_serverFn'
      if (!/^[\w/-]+$/.test(fnBase) || fnBase.split('/').includes('..')) {
        throw new Error('[nasti:start] serverFns.base must be a URL pathname.')
      }
      const define: Record<string, string> = {
        'process.env.NODE_ENV': quote(env.mode),
      }
      for (const [name, value] of Object.entries({
        TSS_SERVER_FN_BASE: base + fnBase.replace(/^\/+|\/+$/g, '') + '/',
        TSS_ROUTER_BASEPATH: base,
        TSS_DEV_SERVER: 'false',
        TSS_DEV_SSR_STYLES_ENABLED: 'false',
        TSS_INLINE_CSS_ENABLED: 'false',
      })) {
        define[`process.env.${name}`] = quote(value)
        define[`import.meta.env.${name}`] = quote(value)
      }
      return {
        framework: target,
        build: {
          ...input.build,
          outDir: path.join(out, 'client'),
          rolldownOptions: {
            ...input.build?.rolldownOptions,
            transform: {
              ...input.build?.rolldownOptions?.transform,
              define: { ...input.build?.rolldownOptions?.transform?.define, ...define },
            },
          },
        },
        environments: {
          ...input.environments,
          client: {
            ...input.environments?.client,
            entry: '.nasti/start/client.tsx',
            html: '.nasti/start/no-index.html',
          },
          ssr: {
            ...input.environments?.ssr,
            consumer: 'server',
            entry: '.nasti/start/server.ts',
            resolve: { ...input.environments?.ssr?.resolve, noExternal: true },
            build: {
              ...input.environments?.ssr?.build,
              outDir: path.join(out, 'server'),
              rolldownOptions: {
                ...input.environments?.ssr?.build?.rolldownOptions,
                output: {
                  ...input.environments?.ssr?.build?.rolldownOptions?.output,
                  entryFileNames: 'server.mjs',
                  chunkFileNames: 'chunks/[name]-[hash].mjs',
                },
              },
            },
          },
        },
      }
    },
    async configResolved(resolved) {
      config = resolved
      const [major, minor] = process.versions.node.split('.').map(Number)
      if (major < 22 || (major === 22 && minor < 12)) {
        throw new Error('[nasti:start] The pinned upstream Start compiler requires Node >=22.12.')
      }
      if (config.target !== 'web' || config.experimental.bundledDev ||
          config.environments.client.driver || config.environments.ssr.driver) {
        throw new Error('[nasti:start] Use native web environments without --bundle or external drivers.')
      }
      if (config.plugins.filter((p) => p.name === 'nasti:tanstack-start').length !== 1 ||
          config.plugins.some((p) => p.name === 'nasti:tanstack-router' || p.name.startsWith('nasti:rsc')) ||
          Object.keys(config.environments).some((name) => !['client', 'ssr'].includes(name)) ||
          !config.environments.client.buildEnabled || !config.environments.ssr.buildEnabled) {
        throw new Error('[nasti:start] Start owns the client/ssr pair and its Router plugin; do not combine with RSC, extra environments or another Router/Start plugin.')
      }
      framework = config.framework as 'react' | 'solid'
      host = await importStartCompiler(config.root)
      // A macro's original source can contain server bodies. Public client maps
      // must not embed those originals, even when build.sourcemap is enabled.
      config.build.rolldownOptions.output = {
        ...config.build.rolldownOptions.output,
        sourcemapExcludeSources: true,
      }
      await router.configResolved!(config)
      const directory = path.join(config.root, '.nasti/start')
      fs.mkdirSync(directory, { recursive: true })
      const findEntry = (name: string) => {
        for (const ext of ['.tsx', '.ts', '.jsx', '.js']) {
          const candidate = path.resolve(config.root, src, name + ext)
          if (fs.existsSync(candidate)) return candidate
        }
        return undefined
      }
      entries = {
        '#tanstack-router-entry': path.resolve(config.root, options.entries?.router ?? findEntry('router') ?? `${src}/router.tsx`),
        '#tanstack-start-entry': path.resolve(config.root, options.entries?.start ?? findEntry('start') ?? '.nasti/start/default-start.ts'),
      }
      fs.writeFileSync(path.join(directory, 'default-start.ts'), 'export const startInstance = undefined\n')
      const runtime = `@tanstack/${framework}-start`
      const clientEntry = options.entries?.client ?? findEntry('client')
      const defaultClient = framework === 'react'
        ? `import { createElement } from 'react'; import { hydrateRoot } from 'react-dom/client';
import { StartClient } from '${runtime}/client'; hydrateRoot(document, createElement(StartClient));`
        : `import { hydrate } from 'solid-js/web'; import { StartClient, hydrateStart } from '${runtime}/client';
hydrateStart().then(router => hydrate(() => <StartClient router={router} />, document));`
      fs.writeFileSync(path.join(directory, 'client.tsx'),
        (config.command === 'serve' ? 'import "/@nasti/client";\n' : '') +
        (clientEntry ? `import ${quote(slash(path.resolve(config.root, clientEntry)))};\n` : defaultClient))
      const serverEntry = options.entries?.server ?? findEntry('server')
      fs.writeFileSync(path.join(directory, 'server.ts'),
        `export { default } from ${quote(serverEntry
          ? slash(path.resolve(config.root, serverEntry))
          : fileURLToPath(resolveProjectImport(config.root, runtime + '/server-entry')))};\n`)
    },
    async buildStart() {
      if (this.environment?.name === 'client') {
        functions = {}
        manifest = undefined
        if (typeof router.buildStart === 'function') await router.buildStart.call(this)
      }
    },
    async resolveId(source, importer) {
      if (source === '/@nasti/client') return { id: source, external: true }
      if (entries[source]) return entries[source]
      if ([MANIFEST, RESOLVER, ADAPTERS].includes(source)) return virtual(source)
      if (this.environment?.consumer === 'client' &&
          (isBuiltin(source) || /\.server\.[cm]?[jt]sx?(?:\?|$)/.test(source) ||
            source.endsWith('/server-only') ||
            /^@tanstack\/(?:start-server-core(?:\/|$)|(?:react|solid)-start\/(?:server|server-rpc|ssr-rpc)(?:\/|$))/.test(source))) {
        throw new Error(`[nasti:start] Server-only import "${source}" in client module "${importer}".`)
      }
      if (source.endsWith(SPLIT)) {
        const filename = source.slice(0, -SPLIT.length)
        return path.isAbsolute(filename) ? source
          : path.resolve(importer ? path.dirname(importer) : config.root, filename) + SPLIT
      }
      return null
    },
    load(id) {
      if (id === virtual(ADAPTERS)) return 'export const pluginSerializationAdapters = []; export const hasPluginAdapters = false'
      if (id === virtual(MANIFEST)) {
        if (!manifest) throw new Error('[nasti:start] Client must be built before SSR.')
        return `export const tsrStartManifest = () => (${quote(manifest)})`
      }
      if (id === virtual(RESOLVER)) {
        if (this.environment?.consumer === 'client') {
          throw new Error('[nasti:start] Server function resolver is server-only.')
        }
        // Only statically discovered, client-reachable functions are callable.
        const imports = Object.entries(functions).filter(([, fn]) => fn.isClientReferenced)
          .map(([id, fn]) => `${quote(id)}: () => import(${quote(fn.extractedFilename)}).then(m => m[${quote(fn.functionName)}])`)
        return `const functions = {${imports.join(',')}};
export async function getServerFnById(id) {
  if (!Object.hasOwn(functions, id)) throw new Error('Unknown server function');
  return functions[id]();
}`
      }
      if (id.endsWith(SPLIT)) return fs.readFileSync(id.slice(0, -SPLIT.length), 'utf8')
      return null
    },
    transform: {
      order: 'pre',
      async handler(code, id) {
        const environment = this.environment!
        if (!/\.[cm]?[jt]sx?(?:\?|$)/.test(id) || id.startsWith('\0')) return null
        if (environment.consumer === 'client' && /\.server\.[cm]?[jt]sx?(?:\?|$)/.test(id)) {
          throw new Error(`[nasti:start] Server-only module reached the client graph: ${id}`)
        }
        // Use the upstream AST compiler/DCE for route-only server properties;
        // regex deletion could leave secrets or accidentally remove UI code.
        if (environment.consumer === 'client' && /\bcreate(?:File|Root)Route/.test(code)) {
          const route = host.compileRoute({
            code, filename: id.split('?')[0], id,
            targetFramework: framework,
            codeSplitGroupings: [],
            deleteNodes: new Set(['server', 'headers', 'ssr']),
            addHmr: false,
          })
          if (route) code = route.code
        }
        let compiler = compilers.get(environment)
        if (!compiler) {
          compiler = host.createStartCompiler({
            env: environment.consumer === 'client' ? 'client' : 'server',
            envName: environment.name,
            root: config.root,
            framework,
            providerEnvName: 'ssr',
            // Native dev is a complete bundle, so IDs/lookup are build-style.
            mode: 'build',
            getKnownServerFns: () => functions,
            onServerFnsById: (next: Record<string, ServerFunction>) => host.mergeServerFnsById(functions, next),
            warn: (message: string) => config.logger.warn(message),
            resolveId: async (source: string, importer?: string) => {
              const result = await this.resolve(source, importer)
              return typeof result === 'string' ? result : result?.external ? null : result?.id ?? null
            },
            loadModule: async (moduleId: string) => {
              const context = this as unknown as {
                load?: (options: { id: string }) => Promise<{ code?: string | null }>
              }
              if (context.load) {
                const loaded = await context.load({ id: moduleId })
                compiler!.ingestModule({ id: moduleId, code: loaded.code ?? '' })
                return
              }
              const filename = moduleId.split('?')[0]
              if (!fs.existsSync(filename)) throw new Error(`[nasti:start] Cannot inspect compiler input ${moduleId}`)
              compiler!.ingestModule({ id: moduleId, code: fs.readFileSync(filename, 'utf8') })
            },
          })
          compilers.set(environment, compiler)
        }
        return compiler.compile({ code, id })
      },
    },
    generateBundle(_output, bundle) {
      if (this.environment.name !== 'client') return
      const artifacts = Object.values(bundle ?? {}) as EnvironmentBuildOutput[]
      const entry = artifacts.find((item) => item.type === 'chunk' && item.isEntry)
      if (!entry) throw new Error('[nasti:start] Missing hydration entry.')
      manifest = {
        routes: {
          __root__: {
            preloads: [config.base + entry.fileName],
            scripts: [{ attrs: { type: 'module', src: config.base + entry.fileName } }],
            css: artifacts.filter((item) => item.fileName.endsWith('.css'))
              .map((item) => ({ href: config.base + item.fileName })),
          },
        },
      }
      this.emitFile({
        type: 'asset', fileName: 'nasti-start.json',
        source: quote({ version: 1, base: config.base }),
      })
    },
    configureServer(devServer) {
      server = devServer
      router.configureServer!(server)
      for (const event of ['add', 'change', 'unlink'] as const) server.watcher.on(event, changed)
      server.middlewares.use(sirv(path.join(config.root, 'public'), { dev: true }))
      // Do not expose raw server source through Nasti's generic source server.
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.url === '/@nasti/client') return next()
        void (async () => {
          const handler = await currentBuild()
          const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
          const asset = assets.get(pathname)
          if (asset) {
            const types: Record<string, string> = {
              '.js': 'application/javascript', '.mjs': 'application/javascript',
              '.css': 'text/css', '.json': 'application/json', '.map': 'application/json',
              '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
              '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
              '.wasm': 'application/wasm',
            }
            res.setHeader('Content-Type', types[path.extname(pathname)] ?? 'application/octet-stream')
            res.setHeader('Cache-Control', 'no-cache')
            res.end(req.method === 'HEAD' ? undefined : asset.type === 'chunk' ? asset.code : asset.source)
            return
          }
          await dispatchFetch(handler.fetch, req, res)
        })().catch((error) => {
          config.logger.error('[nasti:start] Request failed', { error })
          if (!res.headersSent) res.statusCode = 500
          res.end('Internal Server Error')
        })
      })
    },
    async closeServer() {
      closed = true
      for (const event of ['add', 'change', 'unlink'] as const) server?.watcher.off(event, changed)
      await builds
      await router.closeServer!()
      assets.clear()
      fs.rmSync(path.join(config.root, '.nasti/start/dev', session), { recursive: true, force: true })
    },
  }
}
