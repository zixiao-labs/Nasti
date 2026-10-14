// RunnableEnvironment - SSR dev 执行（NASTI_2.0_PLAN.md §2.4）
//
// 模块经 rolldown/experimental 的 moduleRunnerTransform（✓核实导出）转成
// runner 可执行形态（__vite_ssr_import__ / __vite_ssr_exports__ 约定，与
// Vite module runner 同构），由 NastiModuleRunner 求值。
//
// RPC 桥走 HotChannel.invoke 契约：runner 回调 fetchModule →（环境管线
// resolve→load→transform→runnerTransform）→ 求值；getBuiltins 提供外部化
// 清单。Phase 2 是进程内直调（in-memory channel）；网络 transport（edge/
// worker）接入时带 _skipFsCheck —— 接口已一次定全，无需重构。
//
// `ssrLoadModule` 是 Vite back-compat shim：server.ssrLoadModule(url) →
// runner.import(url)。
import path from 'node:path'
import fs from 'node:fs'
import { builtinModules } from 'node:module'
import { pathToFileURL } from 'node:url'
import { moduleResolve } from 'import-meta-resolve'
import type { ResolvedConfig, HotChannelInvokeHandlers, ModuleNode } from '../types.js'
import type { NastiEnvironment } from '../core/environment.js'
import { transformCode, transformReactCode, shouldTransform } from '../core/transformer.js'
import { loadEnv, buildEnvDefine, ssrDefineOverrides, replaceEnvInCode } from '../core/env.js'
import { createDebugger } from '../core/debug.js'
import { createSsrExternal, NODE_BUILTINS } from '../core/ssr-external.js'
import { removeTimestampQuery } from '../core/url.js'

const debug = createDebugger('nasti:ssr')

/** Undo Vite's module-ID transport wrapper, not URI/query encoding. */
function unwrapModuleId(id: string): string {
  return id.startsWith('/@id/')
    ? id.slice('/@id/'.length).replace('__x00__', '\0')
    : id
}

interface FetchedModule {
  id: string
  code: string
  map?: unknown
  invalidationVersion: number
}

interface ModuleCacheEntry {
  id: string
  exports: Record<string, unknown>
  promise: Promise<Record<string, unknown>>
  resolve: (exports: Record<string, unknown>) => void
  reject: (error: unknown) => void
  bodyDone: boolean
  settled: boolean
  failure?: { error: unknown }
  // Persistent static edges use generation identity, never module IDs.
  dependencies: Set<ModuleCacheEntry>
  invalidationVersion?: number
}

export class NastiModuleRunner {
  private environment: NastiEnvironment
  private config: ResolvedConfig
  private cache = new Map<string, ModuleCacheEntry>()
  private evaluating = new Set<ModuleCacheEntry>()
  private evaluationWaiters = new Set<() => void>()
  private pendingTransforms = new Map<
    string,
    { version: number; promise: Promise<FetchedModule> }
  >()
  private envDefine: Record<string, string>
  private externalImportParent: URL
  private externalImportConditions: Set<string>
  private shouldExternalize: ReturnType<typeof createSsrExternal>

  constructor(environment: NastiEnvironment) {
    this.environment = environment
    this.config = environment.config
    this.envDefine = buildEnvDefine(
      loadEnv(this.config.mode, this.config.root, this.config.envPrefix),
      this.config.mode,
      ssrDefineOverrides(environment.consumer),
    )
    this.externalImportParent = pathToFileURL(path.join(this.config.root, 'package.json'))
    this.shouldExternalize = createSsrExternal(
      environment.options.resolve,
      environment.options.build.rolldownOptions.external,
    )
    // External modules are executed with native `import()`, so `require` must
    // never participate in conditional-export matching. Keep environment-specific
    // conditions (for example `react-server`) while guaranteeing Node ESM semantics.
    this.externalImportConditions = new Set([
      ...environment.options.resolve.conditions.filter((condition) => condition !== 'require'),
      'node',
      'import',
    ])

    // invoke 桥：fetchModule / getBuiltins 注册到该环境的 HotChannel
    const handlers: HotChannelInvokeHandlers = {
      fetchModule: async (id, importer) => this.fetchModule(id, importer),
      getBuiltins: () => [/^node:/, ...builtinModules],
    }
    environment.hot.setInvokeHandler?.(handlers)
  }

  /** 入口：加载并执行一个模块（url 为根相对或绝对路径） */
  async import(rawUrl: string): Promise<Record<string, unknown>> {
    const resolved = await this.resolveModule(this.resolveToId(rawUrl))
    if (resolved.external) return this.importExternal(resolved.id)
    await this.ensureModule(resolved.id, removeTimestampQuery(rawUrl))
    return this.instantiate(resolved.id)
  }

  /** Server transforms are runner-ready code, never browser import/HMR rewrites. */
  async transformRequest(rawUrl: string): Promise<{ code: string; map?: unknown } | null> {
    const resolved = await this.resolveModule(this.resolveToId(rawUrl))
    if (resolved.external) return null
    await this.ensureModule(resolved.id, removeTimestampQuery(rawUrl))
    const fetched = await this.fetchResolvedModule(resolved.id)
    return { code: fetched.code, map: fetched.map }
  }

  private invalidateStaleEvaluations(): void {
    for (const [id, entry] of this.cache) {
      const mod = this.environment.moduleGraph.getModuleById(id)
      if (
        entry.invalidationVersion !== undefined &&
        entry.invalidationVersion !== mod?.invalidationVersion
      ) {
        // Importers retain evaluated exports. Any invalidated dependency makes
        // the whole evaluation cache stale, even when graph invalidation was
        // requested directly by a plugin rather than by the watcher.
        this.cache.clear()
        return
      }
    }
  }

  /** 文件变更时按文件失效（含其所属的虚拟子模块） */
  invalidateFile(file: string): void {
    for (const key of [...this.cache.keys()]) {
      if (key === file || key.startsWith(file + '?')) {
        this.cache.delete(key)
      }
    }
  }

  invalidateAll(): void {
    this.cache.clear()
    this.pendingTransforms.clear()
  }

  private resolveToId(rawUrl: string): string {
    if (rawUrl.startsWith('/@id/')) return removeTimestampQuery(unwrapModuleId(rawUrl))
    rawUrl = removeTimestampQuery(rawUrl)
    if (rawUrl.startsWith('\0') || rawUrl.startsWith('virtual:')) return rawUrl
    for (const alias of Object.keys(this.environment.options.resolve.alias)) {
      if (rawUrl === alias || rawUrl.startsWith(alias + '/')) return rawUrl
    }
    if (path.isAbsolute(rawUrl) && fs.existsSync(rawUrl.split('?')[0])) return rawUrl
    const clean = rawUrl.replace(/^\//, '')
    return path.resolve(this.config.root, clean)
  }

  private async resolveModule(id: string, importer?: string): Promise<{ id: string; external?: boolean }> {
    id = removeTimestampQuery(unwrapModuleId(id))
    if (this.shouldExternalize(id, importer, false)) return { id, external: true }
    const resolved = await this.environment.pluginContainer!.resolveId(id, importer)
    if (resolved && typeof resolved !== 'string' && resolved.external) {
      return { id: removeTimestampQuery(resolved.id), external: true }
    }
    const resolvedId = removeTimestampQuery(resolved
      ? typeof resolved === 'string' ? resolved : resolved.id
      : id.startsWith('.') && importer
        ? path.resolve(path.dirname(importer.split('?')[0]), id)
        : id)
    if (this.shouldExternalize(resolvedId, importer, true)) {
      return { id: resolvedId, external: true }
    }
    return { id: this.completeExtension(resolvedId) }
  }

  private async ensureModule(id: string, requestUrl?: string): Promise<ModuleNode> {
    let url = id
    if (path.isAbsolute(id.split('?')[0])) {
      const relative = path.relative(this.config.root, id.split('?')[0])
      if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) {
        const query = id.includes('?') ? id.slice(id.indexOf('?')) : ''
        url = '/' + relative.replace(/\\/g, '/') + query
      }
    }
    const graph = this.environment.moduleGraph
    const mod = await graph.ensureEntryFromUrl(url, id)
    if (requestUrl && requestUrl !== url) await graph.ensureEntryFromUrl(requestUrl, id)
    // Keep query identities separate while indexing all file-backed variants
    // under the same physical file. Virtual IDs do not represent watched files.
    if (path.isAbsolute(id.split('?')[0])) graph.registerModule(mod, id.split('?')[0])
    return mod
  }

  /**
   * fetchModule（invoke 契约方法）：环境管线产出 runner 可执行代码。
   * resolve（插件 resolveId → 文件系统）→ load/读盘 → 插件 transform →
   * oxc（TS/JSX）→ moduleRunnerTransform。
   */
  async fetchModule(id: string, importer?: string): Promise<FetchedModule | { externalize: string }> {
    const resolved = await this.resolveModule(id, importer)
    if (resolved.external) return { externalize: resolved.id }
    return this.fetchResolvedModule(resolved.id)
  }

  private async fetchResolvedModule(id: string): Promise<FetchedModule> {
    // Resolution/externalization belongs to the importing edge. Re-resolving a
    // canonical ID without its importer can reverse an external callback's
    // decision and bypass the server transform pipeline.
    const mod = await this.ensureModule(id)
    const cached = mod.transformResult
    if (cached && typeof cached !== 'string') {
      return {
        id: mod.id,
        code: cached.code,
        map: cached.map,
        invalidationVersion: mod.invalidationVersion,
      }
    }
    const version = mod.invalidationVersion
    const pending = this.pendingTransforms.get(mod.id)
    if (pending?.version === version) return pending.promise
    const promise = this.transformModule(mod, version)
    const current = { version, promise }
    this.pendingTransforms.set(mod.id, current)
    try {
      return await promise
    } finally {
      if (this.pendingTransforms.get(mod.id) === current) this.pendingTransforms.delete(mod.id)
    }
  }

  private async transformModule(mod: ModuleNode, version: number): Promise<FetchedModule> {
    const container = this.environment.pluginContainer!
    const resolvedId = mod.id
    const cleanId = resolvedId.split('?')[0]
    let code: string
    const loaded = await container.load(resolvedId)
    if (loaded != null) {
      code = typeof loaded === 'string' ? loaded : loaded.code
    } else if (fs.existsSync(cleanId)) {
      code = fs.readFileSync(cleanId, 'utf-8')
    } else {
      throw new Error(`[nasti:ssr] cannot load module: ${resolvedId}`)
    }

    const transformed = await container.transform(code, resolvedId)
    if (transformed != null) {
      code = typeof transformed === 'string' ? transformed : transformed.code
    }

    if (this.config.framework === 'react') {
      const result = await transformReactCode(cleanId, code, {
        react: this.config.react,
        consumer: this.environment.consumer,
        development: true,
        sourcemap: false,
        target: this.environment.options.build.target,
        onWarning: (message) => this.config.logger.warn(`[nasti:react] ${message}`),
      })
      if (result) {
        code = result.code
      } else if (shouldTransform(cleanId)) {
        const fallback = transformCode(cleanId, code, {
          sourcemap: false,
          jsxRuntime: this.config.react.jsxRuntime,
          jsxImportSource: this.config.react.jsxImportSource,
          target: this.environment.options.build.target,
        })
        code = fallback.code
      }
    } else if (shouldTransform(cleanId)) {
      const result = transformCode(cleanId, code, {
        sourcemap: false,
        target: this.environment.options.build.target,
        jsxRuntime: 'automatic',
        jsxImportSource: 'vue',
      })
      code = result.code
    }

    code = replaceEnvInCode(code, this.envDefine)

    // 实验 API 守卫：module runner 契约无 semver 保证，精确锁定 Rolldown
    // 版本并在运行时给出明确的兼容错误。
    let moduleRunnerTransform: typeof import('rolldown/experimental').moduleRunnerTransform
    try {
      ;({ moduleRunnerTransform } = await import('rolldown/experimental'))
    } catch (err: any) {
      throw new Error(
        `[nasti:ssr] rolldown/experimental moduleRunnerTransform unavailable ` +
          `(installed rolldown incompatible?): ${err.message}`,
      )
    }
    // OXC selects the parser from a real extension, not a module ID. Preserve
    // query/virtual identity in the runner, but feed transformed JS a valid name.
    const transformId = /\.[cm]?[jt]sx?$/.test(cleanId) ? cleanId : cleanId + '.js'
    const runnerResult = await moduleRunnerTransform(transformId, code)
    if (runnerResult.errors?.length) {
      throw new Error(
        `[nasti:ssr] cannot transform module "${resolvedId}": ` +
          runnerResult.errors.map((error) => error.message).join('\n'),
      )
    }
    debug?.(`fetchModule ${resolvedId} (${runnerResult.deps?.length ?? 0} deps)`)
    const importedUrls = new Set<string>()
    for (const specifier of [...runnerResult.deps, ...runnerResult.dynamicDeps]) {
      const dependency = await this.resolveModule(specifier, resolvedId)
      if (dependency.external) continue
      const dependencyNode = await this.ensureModule(dependency.id)
      importedUrls.add(dependencyNode.url)
    }
    const graph = this.environment.moduleGraph
    const updated = await graph.updateModuleInfo(mod, importedUrls, new Set(), false, version)
    const result = { code: runnerResult.code, map: runnerResult.map }
    if (updated !== null && mod.invalidationVersion === version) mod.transformResult = result
    return { id: resolvedId, ...result, invalidationVersion: version }
  }

  private completeExtension(id: string): string {
    const clean = id.split('?')[0]
    const query = id.includes('?') ? id.slice(id.indexOf('?')) : ''
    if (fs.existsSync(clean) && fs.statSync(clean).isFile()) return id
    // TS ESM 约定：`./shared.js` 指向 shared.ts/.tsx 源文件
    const jsMatch = clean.match(/^(.*)\.([mc]?)jsx?$/)
    if (jsMatch) {
      for (const tsExt of [`.${jsMatch[2]}ts`, `.${jsMatch[2]}tsx`]) {
        if (fs.existsSync(jsMatch[1] + tsExt)) return jsMatch[1] + tsExt + query
      }
    }
    for (const ext of this.environment.options.resolve.extensions) {
      if (fs.existsSync(clean + ext)) return clean + ext + query
    }
    // /dir → /dir/index.*
    for (const ext of this.environment.options.resolve.extensions) {
      const indexPath = path.join(clean, `index${ext}`)
      if (fs.existsSync(indexPath)) return indexPath + query
    }
    return id
  }

  private async instantiate(id: string, importer?: ModuleCacheEntry): Promise<Record<string, unknown>> {
    // Dynamic imports can be called through previously returned exports without
    // another top-level import(). They must observe graph invalidation too.
    this.invalidateStaleEvaluations()
    const cached = this.cache.get(id)
    if (cached) return this.waitForEvaluation(cached, importer)

    const entry: ModuleCacheEntry = {
      id,
      exports: {},
      promise: undefined!,
      resolve: undefined!,
      reject: undefined!,
      bodyDone: false,
      settled: false,
      dependencies: new Set(),
      invalidationVersion: this.environment.moduleGraph.getModuleById(id)?.invalidationVersion,
    }
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve
      entry.reject = reject
    })
    // A cycle-closing internal import may never consume this public promise.
    void entry.promise.catch(() => {})
    this.cache.set(id, entry)
    this.evaluating.add(entry)
    void this.evaluate(id, entry).then(() => {
      entry.bodyDone = true
      this.advanceEvaluations()
    }, (error) => {
      entry.failure = { error }
      this.advanceEvaluations()
    })
    return this.waitForEvaluation(entry, importer)
  }

  private reachable(entry: ModuleCacheEntry): Set<ModuleCacheEntry> {
    const seen = new Set<ModuleCacheEntry>()
    const pending = [entry]
    while (pending.length) {
      const current = pending.pop()!
      if (seen.has(current)) continue
      seen.add(current)
      pending.push(...current.dependencies)
    }
    return seen
  }

  private advanceEvaluations(): void {
    // Mutual reachability defines a static SCC. Its public completion requires
    // all bodies in the SCC and all outgoing dependency groups to complete.
    // Retaining edges also propagates failure to bodies that finished earlier.
    for (const entry of this.evaluating) {
      const dependencies = this.reachable(entry)
      const failure = [...dependencies].find((dependency) => dependency.failure)?.failure
      if (failure) {
        entry.failure = failure
        entry.settled = true
        if (this.cache.get(entry.id) === entry) this.cache.delete(entry.id)
        entry.reject(failure.error)
      } else if ([...dependencies].every((dependency) => dependency.bodyDone)) {
        entry.settled = true
        entry.resolve(entry.exports)
      }
      if (entry.settled) {
        this.evaluating.delete(entry)
        // Settled entries summarize their dependency group with success/failure.
        // Cached namespaces need not retain the evaluation graph indefinitely.
        entry.dependencies.clear()
      }
    }
    for (const notify of [...this.evaluationWaiters]) notify()
  }

  private async waitForEvaluation(
    entry: ModuleCacheEntry,
    importer?: ModuleCacheEntry,
  ): Promise<Record<string, unknown>> {
    if (!importer) return entry.promise
    if (importer.failure) throw importer.failure.error
    const closesCycle = this.reachable(entry).has(importer)
    importer.dependencies.add(entry)
    this.advanceEvaluations()
    if (closesCycle && !entry.failure) return entry.exports
    return new Promise((resolve, reject) => {
      const notify = () => {
        if (entry.failure) {
          this.evaluationWaiters.delete(notify)
          reject(entry.failure.error)
        } else if (entry.settled || (entry.bodyDone && this.reachable(entry).has(importer))) {
          this.evaluationWaiters.delete(notify)
          resolve(entry.exports)
        }
      }
      this.evaluationWaiters.add(notify)
      notify()
    })
  }

  private async evaluate(id: string, entry: ModuleCacheEntry): Promise<void> {
    // instantiate receives an already-resolved, non-external canonical ID.
    const fetched = await this.fetchResolvedModule(id)
    entry.invalidationVersion = fetched.invalidationVersion

    const ssrImport = async (dep: string, dynamic = false) => {
      const resolved = await this.resolveModule(dep, fetched.id)
      if (resolved.external) return this.importExternal(resolved.id, fetched.id)
      // Non-literal dynamic imports are discovered during evaluation. Never let
      // an old in-flight evaluation overwrite a newer transform's graph.
      const graph = this.environment.moduleGraph
      const importer = graph.getModuleById(fetched.id)!
      const dependency = await this.ensureModule(resolved.id)
      if (importer.invalidationVersion === fetched.invalidationVersion) {
        importer.importedModules.add(dependency)
        dependency.importers.add(importer)
      }
      return this.instantiate(resolved.id, dynamic ? undefined : entry)
    }

    const ssrExportAll = (sourceModule: Record<string, unknown>) => {
      for (const key of Object.keys(sourceModule)) {
        if (key !== 'default' && !(key in entry.exports)) {
          Object.defineProperty(entry.exports, key, {
            enumerable: true,
            configurable: true,
            get: () => sourceModule[key],
          })
        }
      }
    }

    const importMeta = {
      url: pathToFileURL(fetched.id.split('?')[0]).href,
      env: { SSR: true, MODE: this.config.mode, DEV: this.config.mode !== 'production', PROD: this.config.mode === 'production' },
      hot: undefined,
    }

    const fn = new AsyncFunction(
      '__vite_ssr_exports__',
      '__vite_ssr_import__',
      '__vite_ssr_dynamic_import__',
      '__vite_ssr_exportAll__',
      '__vite_ssr_import_meta__',
      `"use strict";${fetched.code}\n//# sourceURL=${fetched.id}`,
    )
    await fn(entry.exports, (dep: string) => ssrImport(dep), (dep: string) => ssrImport(dep, true), ssrExportAll, importMeta)
  }

  private async importExternal(spec: string, importer?: string): Promise<Record<string, unknown>> {
    try {
      return await import(
        spec.startsWith('node:') || !path.isAbsolute(spec)
          ? this.resolveExternalSpecifier(spec, importer)
          : pathToFileURL(spec).href
      )
    } catch (err: any) {
      throw new Error(`[nasti:ssr] failed to import external "${spec}": ${err.message}`)
    }
  }

  /** Resolve external edges from their importing file, not from Nasti or the app root. */
  private resolveExternalSpecifier(spec: string, importer?: string): string {
    if (spec.startsWith('node:')) return spec
    if (NODE_BUILTINS.has(spec)) return `node:${spec}`
    // Virtual modules have no filesystem package scope. They retain the root
    // fallback, while transformed workspace/node_modules files need their own
    // dependency scope (including nested versions in non-hoisted installations).
    const parent = importer && path.isAbsolute(importer.split('?')[0])
      ? pathToFileURL(importer.split('?')[0])
      : this.externalImportParent
    return moduleResolve(
      spec,
      parent,
      this.externalImportConditions,
      false,
    ).href
  }
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...fnArgs: unknown[]) => Promise<void>

/** 为 server consumer 环境创建 module runner（Vite RunnableEnvironment 的精简版） */
export function createModuleRunner(environment: NastiEnvironment): NastiModuleRunner {
  if (environment.consumer !== 'server') {
    throw new Error(
      `[nasti] module runner requires a server-consumer environment (got "${environment.name}" / ${environment.consumer})`,
    )
  }
  return new NastiModuleRunner(environment)
}
