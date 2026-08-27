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
import { builtinModules, createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { ResolvedConfig, HotChannelInvokeHandlers } from '../types.js'
import type { NastiEnvironment } from '../core/environment.js'
import { transformCode, transformReactCode, shouldTransform } from '../core/transformer.js'
import { loadEnv, buildEnvDefine, ssrDefineOverrides, replaceEnvInCode } from '../core/env.js'
import { createDebugger } from '../core/debug.js'

const debug = createDebugger('nasti:ssr')

const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])

interface FetchedModule {
  id: string
  code: string
}

interface ModuleCacheEntry {
  exports: Record<string, unknown>
  promise: Promise<Record<string, unknown>> | null
}

export class NastiModuleRunner {
  private environment: NastiEnvironment
  private config: ResolvedConfig
  private cache = new Map<string, ModuleCacheEntry>()
  private envDefine: Record<string, string>
  private require: NodeJS.Require

  constructor(environment: NastiEnvironment) {
    this.environment = environment
    this.config = environment.config
    this.envDefine = buildEnvDefine(
      loadEnv(this.config.mode, this.config.root, this.config.envPrefix),
      this.config.mode,
      ssrDefineOverrides(environment.consumer),
    )
    this.require = createRequire(path.join(this.config.root, 'package.json'))

    // invoke 桥：fetchModule / getBuiltins 注册到该环境的 HotChannel
    const handlers: HotChannelInvokeHandlers = {
      fetchModule: async (id, importer) => this.fetchModule(id, importer),
      getBuiltins: () => [/^node:/, ...builtinModules],
    }
    environment.hot.setInvokeHandler?.(handlers)
  }

  /** 入口：加载并执行一个模块（url 为根相对或绝对路径） */
  async import(rawUrl: string): Promise<Record<string, unknown>> {
    const id = this.resolveToId(rawUrl)
    return this.instantiate(id)
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
  }

  private resolveToId(rawUrl: string): string {
    if (path.isAbsolute(rawUrl) && fs.existsSync(rawUrl.split('?')[0])) return rawUrl
    const clean = rawUrl.replace(/^\//, '')
    return path.resolve(this.config.root, clean)
  }

  /**
   * fetchModule（invoke 契约方法）：环境管线产出 runner 可执行代码。
   * resolve（插件 resolveId → 文件系统）→ load/读盘 → 插件 transform →
   * oxc（TS/JSX）→ moduleRunnerTransform。
   */
  async fetchModule(id: string, importer?: string): Promise<FetchedModule | { externalize: string }> {
    // 外部化：node 内建与 bare specifier 由 node 原生解析
    if (NODE_BUILTINS.has(id)) return { externalize: id }
    if (!id.startsWith('.') && !path.isAbsolute(id) && !id.startsWith('\0')) {
      return { externalize: id }
    }

    const container = this.environment.pluginContainer!
    let resolvedId = id
    if (id.startsWith('.') && importer) {
      const resolved = await container.resolveId(id, importer)
      resolvedId = resolved
        ? typeof resolved === 'string' ? resolved : resolved.id
        : path.resolve(path.dirname(importer.split('?')[0]), id)
    }
    // 扩展名补全（./App → ./App.tsx 等）
    resolvedId = this.completeExtension(resolvedId)

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
      if (result) code = result.code
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
    const runnerResult = await moduleRunnerTransform(resolvedId, code)
    debug?.(`fetchModule ${resolvedId} (${runnerResult.deps?.length ?? 0} deps)`)
    return { id: resolvedId, code: runnerResult.code }
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
    for (const ext of this.config.resolve.extensions) {
      if (fs.existsSync(clean + ext)) return clean + ext + query
    }
    // /dir → /dir/index.*
    for (const ext of this.config.resolve.extensions) {
      const indexPath = path.join(clean, `index${ext}`)
      if (fs.existsSync(indexPath)) return indexPath
    }
    return id
  }

  private async instantiate(id: string): Promise<Record<string, unknown>> {
    const cached = this.cache.get(id)
    if (cached) return cached.promise ?? Promise.resolve(cached.exports)

    const entry: ModuleCacheEntry = { exports: {}, promise: null }
    this.cache.set(id, entry)
    entry.promise = this.evaluate(id, entry).then(() => {
      entry.promise = null
      return entry.exports
    }).catch((err) => {
      this.cache.delete(id)
      throw err
    })
    return entry.promise
  }

  private async evaluate(id: string, entry: ModuleCacheEntry): Promise<void> {
    // 经 invoke 桥取模块（与未来网络 transport 同一路径）
    const fetched = await this.fetchModule(id)

    if ('externalize' in fetched) {
      const spec = fetched.externalize
      const mod = await this.importExternal(spec)
      entry.exports = mod
      return
    }

    const ssrImport = async (dep: string) => {
      if (NODE_BUILTINS.has(dep) || (!dep.startsWith('.') && !path.isAbsolute(dep) && !dep.startsWith('\0'))) {
        return this.importExternal(dep)
      }
      const depId = dep.startsWith('.')
        ? this.completeExtension(path.resolve(path.dirname(fetched.id.split('?')[0]), dep))
        : this.completeExtension(dep)
      return this.instantiate(depId)
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
    await fn(entry.exports, ssrImport, ssrImport, ssrExportAll, importMeta)
  }

  private async importExternal(spec: string): Promise<Record<string, unknown>> {
    try {
      return await import(
        spec.startsWith('node:') || !path.isAbsolute(spec)
          ? this.resolveExternalSpecifier(spec)
          : pathToFileURL(spec).href
      )
    } catch (err: any) {
      throw new Error(`[nasti:ssr] failed to import external "${spec}": ${err.message}`)
    }
  }

  /** bare specifier → 项目 node_modules 的绝对 URL（避免相对 Nasti 自身解析） */
  private resolveExternalSpecifier(spec: string): string {
    if (spec.startsWith('node:')) return spec
    if (NODE_BUILTINS.has(spec)) return `node:${spec}`
    try {
      return pathToFileURL(this.require.resolve(spec)).href
    } catch {
      return spec
    }
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
