// Vite 兼容插件容器
// 管理插件生命周期，实现 resolveId → load → transform 管道

import type {
  NastiPlugin,
  ResolvedConfig,
  PluginContext,
  ResolveIdResult,
  LoadResult,
  TransformResult,
  ModuleInfo,
} from '../types.js'

export class PluginContainer {
  private plugins: NastiPlugin[]
  private config: ResolvedConfig
  private ctx: PluginContext
  private emittedFiles: Map<string, { fileName: string; source: string | Uint8Array }> = new Map()

  constructor(config: ResolvedConfig) {
    this.config = config
    // 按 enforce 排序: pre → normal → post
    this.plugins = sortPlugins(config.plugins)
    this.ctx = this.createContext()
  }

  private createContext(): PluginContext {
    const container = this
    return {
      async resolve(source: string, importer?: string) {
        return container.resolveId(source, importer)
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
    }
  }

  /** 返回所有通过 emitFile() 输出的文件 */
  getEmittedFiles(): Array<{ fileName: string; source: string | Uint8Array }> {
    return Array.from(this.emittedFiles.values())
  }

  async buildStart(): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.buildStart) {
        await plugin.buildStart.call(this.ctx)
      }
    }
  }

  async buildEnd(error?: Error): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.buildEnd) {
        await plugin.buildEnd.call(this.ctx, error)
      }
    }
  }

  async resolveId(
    source: string,
    importer?: string,
    options: { isEntry?: boolean } = {},
  ): Promise<ResolveIdResult> {
    for (const plugin of this.plugins) {
      if (!plugin.resolveId) continue
      const result = await plugin.resolveId.call(
        this.ctx,
        source,
        importer ?? undefined,
        { isEntry: options.isEntry ?? false, ssr: false },
      )
      if (result != null) return result
    }
    return null
  }

  async load(id: string): Promise<LoadResult> {
    for (const plugin of this.plugins) {
      if (!plugin.load) continue
      const result = await plugin.load.call(this.ctx, id)
      if (result != null) return result
    }
    return null
  }

  async transform(code: string, id: string): Promise<TransformResult> {
    let currentCode = code
    for (const plugin of this.plugins) {
      if (!plugin.transform) continue
      const result = await plugin.transform.call(this.ctx, currentCode, id)
      if (result == null) continue
      if (typeof result === 'string') {
        currentCode = result
      } else {
        currentCode = result.code
      }
    }
    return currentCode === code ? null : { code: currentCode }
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

    // 3. transform
    const transformResult = await this.transform(loadedCode, id)
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

function sortPlugins(plugins: NastiPlugin[]): NastiPlugin[] {
  const pre: NastiPlugin[] = []
  const normal: NastiPlugin[] = []
  const post: NastiPlugin[] = []

  for (const plugin of plugins) {
    if (plugin.enforce === 'pre') pre.push(plugin)
    else if (plugin.enforce === 'post') post.push(plugin)
    else normal.push(plugin)
  }

  return [...pre, ...normal, ...post]
}
