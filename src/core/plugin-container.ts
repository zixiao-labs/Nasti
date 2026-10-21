// Vite 兼容插件容器
// 管理插件生命周期，实现 resolveId → load → transform 管道

import path from 'node:path'
import type {
  NastiPlugin,
  ResolvedConfig,
  PluginContext,
  ResolveIdResult,
  LoadResult,
  TransformResult,
  ModuleInfo,
  ModuleNode,
  EnvironmentInstance,
} from '../types.js'
import { orderPlugins } from './plugin-api.js'
import { getOrderedPluginHooks, pluginHookFilterMatches } from './plugin-hooks.js'

export class PluginContainer {
  private plugins: NastiPlugin[]
  private config: ResolvedConfig
  private ctx: PluginContext
  private emittedFiles: Map<string, { fileName: string; source: string | Uint8Array }> = new Map()
  private watchDependencies = {
    load: new Map<string, Set<string>>(),
    transform: new Map<string, Set<string>>(),
    bundle: new Map<string, Set<string>>(),
  }
  private watchedFiles = new Set<string>()
  private watchFileHandler?: (file: string) => void
  /** Environment API：容器所属环境（未传时为 undefined，行为同 1.x client） */
  readonly environment?: EnvironmentInstance

  constructor(config: ResolvedConfig, environment?: EnvironmentInstance) {
    this.config = config
    this.environment = environment
    // 按 enforce 分组，处理 pre/post 显式依赖并执行稳定拓扑排序
    this.plugins = orderPlugins(config.plugins)
    this.ctx = this.createContext()
  }

  private createContext(dependencies?: Set<string>): PluginContext {
    const container = this
    return {
      async resolve(source: string, importer?: string) {
        return container.resolveId(source, importer)
      },
      addWatchFile(fileName) {
        const file = path.resolve(container.config.root, fileName)
        dependencies?.add(file)
        container.watchedFiles.add(file)
        container.watchFileHandler?.(file)
      },
      emitFile(file) {
        const fileName = file.fileName ?? file.name ?? `asset-${container.emittedFiles.size}`
        const id = `emitted:${fileName}`
        container.emittedFiles.set(id, {
          fileName,
          source: file.source ?? '',
        })
        return id
      },
      getModuleInfo(_id): ModuleInfo | null {
        return null
      },
      environment: container.environment,
    }
  }

  /** Attach the server watcher, including files registered before it was ready. */
  setWatchFileHandler(handler: (file: string) => void): void {
    this.watchFileHandler = handler
    for (const file of this.watchedFiles) handler(file)
  }

  private async withModuleContext<T>(
    id: string,
    hook: 'load' | 'transform',
    run: (ctx: PluginContext) => Promise<T>,
  ): Promise<T> {
    // Per-invocation contexts keep concurrent shader transforms isolated. Replace
    // each hook's dependencies so removed imports stop invalidating the module.
    const dependencies = new Set<string>()
    const previous = this.watchDependencies[hook].get(id)
    this.watchDependencies[hook].set(id, dependencies)
    try {
      return await run(this.createContext(dependencies))
    } catch (error) {
      // Retain the last successful inputs on failure so recreating a deleted
      // shader can recover the entry without restarting the dev server.
      for (const file of previous ?? []) dependencies.add(file)
      throw error
    }
  }

  getModulesByWatchFile(file: string): Set<ModuleNode> {
    const modules = new Set<ModuleNode>()
    const graph = this.environment?.moduleGraph
    if (!graph) return modules
    file = path.resolve(file)
    for (const dependencies of Object.values(this.watchDependencies)) {
      for (const [id, files] of dependencies) {
        if (!files.has(file)) continue
        const mod = graph.getModuleById(id)
        if (mod) modules.add(mod)
        // Browser module IDs are URLs, while hooks receive filesystem paths.
        for (const owner of graph.getModulesByFile(id.split(/[?#]/, 1)[0]) ?? []) {
          modules.add(owner)
        }
      }
    }
    return modules
  }

  /** On-demand dependency bundles also own their inlined and plugin-watched inputs. */
  setModuleWatchFiles(id: string, files: string[]): void {
    const dependencies = new Set<string>()
    this.watchDependencies.bundle.set(id, dependencies)
    const ctx = this.createContext(dependencies)
    for (const file of files) ctx.addWatchFile(file)
  }

  /** 返回所有通过 emitFile() 输出的文件 */
  getEmittedFiles(): Array<{ fileName: string; source: string | Uint8Array }> {
    return Array.from(this.emittedFiles.values())
  }

  async buildStart(): Promise<void> {
    for (const { hook } of getOrderedPluginHooks(this.plugins, 'buildStart')) {
      await hook.handler.call(this.ctx)
    }
  }

  async buildEnd(error?: Error): Promise<void> {
    for (const { hook } of getOrderedPluginHooks(this.plugins, 'buildEnd')) {
      await hook.handler.call(this.ctx, error)
    }
  }

  async resolveId(
    source: string,
    importer?: string,
    options: { isEntry?: boolean } = {},
  ): Promise<ResolveIdResult> {
    // ssr 标志由环境 consumer 派生（1.x 写死 false；client 环境行为不变）
    const ssr = this.environment?.consumer === 'server'
    for (const { hook } of getOrderedPluginHooks(this.plugins, 'resolveId')) {
      if (!pluginHookFilterMatches(hook.filter, { id: source, importerId: importer, cwd: this.config.root })) continue
      const result = await hook.handler.call(
        this.ctx,
        source,
        importer ?? undefined,
        { isEntry: options.isEntry ?? false, ssr },
      )
      if (result != null) return result
    }
    return null
  }

  async load(id: string): Promise<LoadResult> {
    return this.withModuleContext(id, 'load', async (ctx) => {
      for (const { hook } of getOrderedPluginHooks(this.plugins, 'load')) {
        if (!pluginHookFilterMatches(hook.filter, { id, cwd: this.config.root })) continue
        const result = await hook.handler.call(ctx, id)
        if (result != null) return result
      }
      return null
    })
  }

  async transform(code: string, id: string, moduleType?: string): Promise<TransformResult> {
    return this.withModuleContext(id, 'transform', async (ctx) => {
      let currentCode = code
      let currentModuleType = moduleType ?? inferModuleType(id)
      let lastResult: Exclude<TransformResult, string | null | undefined> | undefined
      for (const { hook } of getOrderedPluginHooks(this.plugins, 'transform')) {
        if (!pluginHookFilterMatches(hook.filter, { id, code: currentCode, moduleType: currentModuleType, cwd: this.config.root })) {
          continue
        }
        const result = await hook.handler.call(ctx, currentCode, id)
        if (result == null) continue
        if (typeof result === 'string') {
          currentCode = result
          lastResult = undefined
        } else {
          currentCode = result.code
          currentModuleType = result.moduleType ?? currentModuleType
          lastResult = result
        }
      }
      return currentCode === code
        ? null
        : {
            ...lastResult,
            code: currentCode,
          }
    })
  }

  /** 完整的模块处理管道: resolveId → load → transform */
  async processModule(
    source: string,
    importer?: string,
  ): Promise<{ id: string; code: string } | null> {
    // 1. resolveId
    const resolveResult = await this.resolveId(source, importer, {
      isEntry: !importer,
    })
    if (resolveResult == null) return null
    const id = typeof resolveResult === 'string' ? resolveResult : resolveResult.id

    // 2. load
    const loadResult = await this.load(id)
    if (loadResult == null) return null
    const loadedCode = typeof loadResult === 'string' ? loadResult : loadResult.code
    const moduleType = typeof loadResult === 'string' ? undefined : loadResult.moduleType

    // 3. transform
    const transformResult = await this.transform(loadedCode, id, moduleType)
    const finalCode = transformResult == null
      ? loadedCode
      : typeof transformResult === 'string'
        ? transformResult
        : transformResult.code

    return { id, code: finalCode }
  }

  getPlugins(): NastiPlugin[] {
    return this.plugins
  }
}

function inferModuleType(id: string): string {
  const cleanId = id.split(/[?#]/, 1)[0].toLowerCase()
  if (cleanId.endsWith('.tsx')) return 'tsx'
  if (cleanId.endsWith('.jsx')) return 'jsx'
  if (/\.(?:ts|mts|cts)$/.test(cleanId)) return 'ts'
  if (cleanId.endsWith('.json')) return 'json'
  return 'js'
}
