import fs from 'node:fs'
import path from 'node:path'
import { parseSync } from 'oxc-parser'
import type {
  AppBuildOutput,
  EnvironmentBuildResult,
  NastiConfig,
  NastiPlugin,
  ReactFileFilter,
  ResolvedConfig,
} from '../types.js'
import { matchesReactFilter } from '../core/transformer.js'

const SERVER_RUNTIME_ID = 'virtual:nasti-rsc/server-runtime'
const CLIENT_RUNTIME_ID = 'virtual:nasti-rsc/client-runtime'
const RESOLVED_SERVER_RUNTIME_ID = `\0${SERVER_RUNTIME_ID}`
const RESOLVED_CLIENT_RUNTIME_ID = `\0${CLIENT_RUNTIME_ID}`

export interface RscPluginOptions {
  /** Vite RSC 风格的三环境入口简写。 */
  entries?: Partial<Record<'client' | 'ssr' | 'rsc', string | string[]>>
  /** 自定义环境名；默认 client / ssr / rsc。 */
  environment?: Partial<Record<'client' | 'ssr' | 'rsc', string>>
  /** 扫描 client/server directive 的源码目录；默认扫描 app 与 src。 */
  scanDirectories?: string[]
  include?: ReactFileFilter
  exclude?: ReactFileFilter
  /** 可检查的引用清单；false 可关闭写出。 @default 'rsc-manifest.json' */
  manifestFile?: string | false
}

export interface RscManifestReference {
  id: string
  name: string
  chunks: string[]
}

export interface RscManifest {
  version: 1
  environments: { client: string; ssr: string; rsc: string }
  clientReferences: Record<string, RscManifestReference>
  serverReferences: Record<string, RscManifestReference>
}

interface ExportReference {
  exported: string
  local?: string
  reexported: boolean
}

interface ScannedModule {
  useClient: boolean
  useServer: boolean
  exports: ExportReference[]
}

/**
 * React Server Components 的低层生成器。
 *
 * 它只在显式安装时启用：RSC 环境中的 `"use client"` 模块会变成 client
 * reference proxy，文件级 `"use server"` 导出会在 RSC 图注册、在 client/SSR
 * 图生成 server reference proxy，并在 buildApp 收尾阶段写出稳定清单。
 */
export function rsc(options: RscPluginOptions = {}): NastiPlugin {
  const names = {
    client: options.environment?.client ?? 'client',
    ssr: options.environment?.ssr ?? 'ssr',
    rsc: options.environment?.rsc ?? 'rsc',
  }
  const clientReferences = new Map<string, Set<string>>()
  const serverReferences = new Map<string, Set<string>>()
  let resolvedConfig: ResolvedConfig | undefined

  return {
    name: 'nasti:rsc',
    enforce: 'post',

    config(config, env) {
      const root = path.resolve(config.root ?? '.')
      const include = options.include ?? config.react?.include ?? /\.[tj]sx?$/
      const exclude = options.exclude ?? config.react?.exclude ?? /node_modules/
      const discoveredClients = env.command === 'build'
        ? discoverDirectiveModules(root, options.scanDirectories, include, exclude)
        : []
      for (const item of discoveredClients) {
        if (item.module.useClient) {
          clientReferences.set(
            item.id,
            new Set(item.module.exports.map((entry) => entry.exported)),
          )
        }
        if (item.module.useServer) {
          serverReferences.set(
            item.id,
            new Set(item.module.exports.map((entry) => entry.exported)),
          )
        }
      }

      const environments = { ...(config.environments ?? {}) }
      if (names.client !== 'client') {
        environments.client = {
          ...(environments.client ?? {}),
          buildEnabled: false,
        }
      }
      const client = { ...(environments[names.client] ?? {}) }
      const clientSeeds = collectClientSeeds(root, config, client, options.entries?.client)
      const generatedClientEntries = discoveredClients
        .filter((item) => item.module.useClient)
        .map((item) => item.id)
      client.consumer = 'client'
      client.entry = uniqueEntries([...clientSeeds, ...generatedClientEntries])
      environments[names.client] = client

      const rscEnvironment = { ...(environments[names.rsc] ?? {}) }
      rscEnvironment.consumer = 'server'
      const rscEntries = normalizeEntries(options.entries?.rsc)
      if (rscEntries.length > 0) rscEnvironment.entry = rscEntries
      environments[names.rsc] = rscEnvironment

      const ssrEntries = normalizeEntries(options.entries?.ssr)
      if (ssrEntries.length > 0 || environments[names.ssr]) {
        environments[names.ssr] = {
          ...(environments[names.ssr] ?? {}),
          consumer: 'server',
          ...(ssrEntries.length > 0 ? { entry: ssrEntries } : {}),
        }
      }

      return { environments }
    },

    configEnvironment(name, environment) {
      if (name !== names.rsc) return
      const conditions = environment.resolve?.conditions ?? ['node', 'import', 'module', 'default']
      return {
        consumer: 'server',
        resolve: {
          ...environment.resolve,
          conditions: ['react-server', ...conditions.filter((item) => item !== 'react-server')],
        },
      }
    },

    configResolved(config) {
      if (config.framework !== 'react') {
        throw new Error('[nasti:rsc] the RSC generator requires framework: "react"')
      }
      resolvedConfig = config
    },

    resolveId(source) {
      if (source === SERVER_RUNTIME_ID) return RESOLVED_SERVER_RUNTIME_ID
      if (source === CLIENT_RUNTIME_ID) return RESOLVED_CLIENT_RUNTIME_ID
      return null
    },

    load(id) {
      if (id === RESOLVED_SERVER_RUNTIME_ID) return createServerRuntimeModule()
      if (id === RESOLVED_CLIENT_RUNTIME_ID) {
        const browser = this.environment?.name === names.client
        return createClientRuntimeModule(browser)
      }
      return null
    },

    transform(code, id) {
      if (!resolvedConfig || !isSourceModule(id, resolvedConfig, options)) return null
      const cleanId = cleanModuleId(id)
      const module = scanModule(cleanId, code)
      if (!module) return null
      if (module.useClient && module.useServer) {
        throw new Error(`[nasti:rsc] ${displayId(resolvedConfig.root, cleanId)} cannot contain both "use client" and "use server"`)
      }

      const moduleId = referenceModuleId(resolvedConfig.root, cleanId)
      if (module.useClient) {
        clientReferences.set(cleanId, new Set(module.exports.map((entry) => entry.exported)))
        if (this.environment?.name === names.rsc) {
          return {
            code: createClientReferenceProxy(moduleId, module.exports),
            map: { mappings: '' },
          }
        }
      }

      if (module.useServer) {
        serverReferences.set(cleanId, new Set(module.exports.map((entry) => entry.exported)))
        if (this.environment?.name === names.rsc) {
          return {
            code: registerServerReferences(code, moduleId, module.exports, cleanId),
            map: { mappings: '' },
          }
        }
        if (
          this.environment?.consumer === 'client' ||
          this.environment?.name === names.client ||
          this.environment?.name === names.ssr
        ) {
          return {
            code: createServerReferenceProxy(moduleId, module.exports),
            map: { mappings: '' },
          }
        }
      }
      return null
    },

    afterBuildApp(results, _api, context) {
      if (options.manifestFile === false) return
      const manifest = createManifest(
        names,
        resolvedConfig?.root ?? '',
        results,
        clientReferences,
        serverReferences,
      )
      const output: AppBuildOutput = {
        type: 'asset',
        fileName: options.manifestFile ?? 'rsc-manifest.json',
        source: JSON.stringify(manifest, null, 2) + '\n',
      }
      context.emitFile(output)
    },
  }
}

function scanModule(filename: string, code: string): ScannedModule | null {
  if (!code.includes('use client') && !code.includes('use server')) return null
  const parsed = parseSync(filename, code)
  if (parsed.errors.length > 0) return null
  const directives = new Set(
    parsed.program.body
      .filter((node) => node.type === 'ExpressionStatement' && typeof node.directive === 'string')
      .map((node) => (node as { directive: string }).directive),
  )
  const useClient = directives.has('use client')
  const useServer = directives.has('use server')
  if (!useClient && !useServer) return null

  const exports: ExportReference[] = []
  for (const statement of parsed.module.staticExports) {
    for (const entry of statement.entries) {
      if (entry.isType) continue
      const exported = entry.exportName.kind === 'Default'
        ? 'default'
        : entry.exportName.name
      if (!exported) {
        throw new Error(
          `[nasti:rsc] ${filename} uses export * inside an RSC directive module; ` +
            'replace it with explicit named exports so reference identities are stable',
        )
      }
      exports.push({
        exported,
        local: entry.localName.kind === 'Name' ? entry.localName.name ?? undefined : undefined,
        reexported: entry.moduleRequest !== null,
      })
    }
  }
  return { useClient, useServer, exports: dedupeExports(exports) }
}

function createClientReferenceProxy(moduleId: string, exports: ExportReference[]): string {
  const lines = [
    `import { registerClientReference as __nasti_register_client__ } from ${JSON.stringify(SERVER_RUNTIME_ID)};`,
  ]
  exports.forEach((entry, index) => {
    const local = `__nasti_client_reference_${index}__`
    const message = `Cannot call client export ${moduleId}#${entry.exported} from the RSC server graph.`
    lines.push(
      `const ${local} = __nasti_register_client__(function () { throw new Error(${JSON.stringify(message)}); }, ${JSON.stringify(moduleId)}, ${JSON.stringify(entry.exported)});`,
      exportLocal(local, entry.exported),
    )
  })
  return lines.join('\n') + '\n'
}

function registerServerReferences(
  code: string,
  moduleId: string,
  exports: ExportReference[],
  filename: string,
): string {
  const registrations: string[] = []
  for (const entry of exports) {
    if (entry.reexported || !entry.local) {
      throw new Error(
        `[nasti:rsc] ${filename} must use named local bindings for "use server" exports; ` +
          `${entry.exported} cannot be registered safely`,
      )
    }
    registrations.push(
      `__nasti_register_server__(${entry.local}, ${JSON.stringify(moduleId)}, ${JSON.stringify(entry.exported)});`,
    )
  }
  return [
    code,
    `import { registerServerReference as __nasti_register_server__ } from ${JSON.stringify(SERVER_RUNTIME_ID)};`,
    ...registrations,
    '',
  ].join('\n')
}

function createServerReferenceProxy(moduleId: string, exports: ExportReference[]): string {
  const lines = [
    `import { createServerReference as __nasti_create_server__ } from ${JSON.stringify(CLIENT_RUNTIME_ID)};`,
  ]
  exports.forEach((entry, index) => {
    const local = `__nasti_server_reference_${index}__`
    lines.push(
      `const ${local} = __nasti_create_server__(${JSON.stringify(moduleId)}, ${JSON.stringify(entry.exported)});`,
      exportLocal(local, entry.exported),
    )
  })
  return lines.join('\n') + '\n'
}

function exportLocal(local: string, exported: string): string {
  if (exported === 'default') return `export default ${local};`
  const name = /^[A-Za-z_$][\w$]*$/.test(exported) ? exported : JSON.stringify(exported)
  return `export { ${local} as ${name} };`
}

function createServerRuntimeModule(): string {
  return [
    `export { registerClientReference, registerServerReference } from "react-server-dom-webpack/server.edge";`,
    '',
  ].join('\n')
}

function createClientRuntimeModule(browser: boolean): string {
  const source = browser
    ? 'react-server-dom-webpack/client.browser'
    : 'react-server-dom-webpack/client.edge'
  return `
import { createServerReference as __createServerReference } from ${JSON.stringify(source)};
const __callServer = (id, args) => {
  const handler = globalThis[Symbol.for("nasti.rsc.callServer")];
  if (typeof handler !== "function") {
    throw new Error("No RSC callServer handler is installed. Set globalThis[Symbol.for('nasti.rsc.callServer')].");
  }
  return handler(id, args);
};
export function createServerReference(moduleId, name) {
  return __createServerReference(moduleId + "#" + name, __callServer, undefined, undefined, name);
}
`.trimStart()
}

function createManifest(
  names: { client: string; ssr: string; rsc: string },
  root: string,
  results: Record<string, EnvironmentBuildResult>,
  clients: Map<string, Set<string>>,
  servers: Map<string, Set<string>>,
): RscManifest {
  return {
    version: 1,
    environments: names,
    clientReferences: manifestReferences(root, results[names.client], clients),
    serverReferences: manifestReferences(root, results[names.rsc], servers),
  }
}

function manifestReferences(
  root: string,
  result: EnvironmentBuildResult | undefined,
  references: Map<string, Set<string>>,
): Record<string, RscManifestReference> {
  const output: Record<string, RscManifestReference> = {}
  for (const [id, names] of [...references].sort(([a], [b]) => a.localeCompare(b))) {
    const chunks = Object.values(result?.chunks ?? {})
      .filter((chunk) => chunk.moduleIds.some((moduleId) => cleanModuleId(moduleId) === id))
      .map((chunk) => chunk.fileName)
      .sort()
    for (const name of [...names].sort()) {
      const moduleId = referenceModuleId(root, id)
      output[`${moduleId}#${name}`] = { id: moduleId, name, chunks }
    }
  }
  return output
}

function discoverDirectiveModules(
  root: string,
  scanDirectories: string[] | undefined,
  include: ReactFileFilter,
  exclude: ReactFileFilter,
): Array<{ id: string; module: ScannedModule }> {
  const requested = scanDirectories ?? ['app', 'src']
  const roots = requested
    .map((directory) => path.resolve(root, directory))
    .filter((directory) => fs.existsSync(directory))
  if (roots.length === 0) roots.push(root)
  const output: Array<{ id: string; module: ScannedModule }> = []
  for (const directory of roots) walk(directory)
  return output

  function walk(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.nasti') continue
      const id = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(id)
        continue
      }
      if (!entry.isFile() || !matchesReactFilter(id, include, exclude)) continue
      const module = scanModule(id, fs.readFileSync(id, 'utf-8'))
      if (module) output.push({ id, module })
    }
  }
}

function collectClientSeeds(
  root: string,
  config: NastiConfig,
  client: { entry?: string | string[]; html?: string },
  configured: string | string[] | undefined,
): string[] {
  const explicit = [
    ...normalizeEntries(client.entry),
    ...normalizeEntries(configured),
  ]
  if (explicit.length > 0) return explicit

  const htmlFile = path.resolve(root, client.html ?? 'index.html')
  if (fs.existsSync(htmlFile)) {
    const html = fs.readFileSync(htmlFile, 'utf-8')
    const htmlDir = path.dirname(htmlFile)
    const entries = [...html.matchAll(/<script[^>]+src=["']([^"']+)["'][^>]*>/gi)]
      .map((match) => match[1]?.split(/[?#]/, 1)[0])
      .filter((entry): entry is string => !!entry && !entry.startsWith('http'))
      .map((entry) => entry.startsWith('/')
        ? path.resolve(root, entry.slice(1))
        : path.resolve(htmlDir, entry))
    if (entries.length > 0) return entries
  }

  for (const entry of ['src/main.ts', 'src/main.tsx', 'src/main.js', 'src/index.ts', 'src/index.tsx', 'src/index.js']) {
    if (fs.existsSync(path.resolve(root, entry))) return [entry]
  }
  return []
}

function normalizeEntries(entries: string | string[] | undefined): string[] {
  return entries == null ? [] : Array.isArray(entries) ? entries : [entries]
}

function uniqueEntries(entries: string[]): string[] {
  return [...new Set(entries)]
}

function isSourceModule(id: string, config: ResolvedConfig, options: RscPluginOptions): boolean {
  const cleanId = cleanModuleId(id)
  if (cleanId.startsWith('\0')) return false
  const include = options.include ?? config.react.include
  const exclude = options.exclude ?? config.react.exclude
  return matchesReactFilter(cleanId, include, exclude)
}

function cleanModuleId(id: string): string {
  return id.split(/[?#]/, 1)[0]
}

function referenceModuleId(root: string, id: string): string {
  if (!root || !path.isAbsolute(id)) return id.replaceAll(path.sep, '/')
  const relative = path.relative(root, id).replaceAll(path.sep, '/')
  return relative.startsWith('../') ? id.replaceAll(path.sep, '/') : `/${relative}`
}

function displayId(root: string, id: string): string {
  return referenceModuleId(root, id)
}

function dedupeExports(exports: ExportReference[]): ExportReference[] {
  return [...new Map(exports.map((entry) => [entry.exported, entry])).values()]
}
