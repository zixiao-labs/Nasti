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
  EnvironmentInstance,
} from '../types.js'
import { orderPlugins } from './plugin-api.js'

export class PluginContainer {
  private plugins: NastiPlugin[]
  private config: ResolvedConfig
  private ctx: PluginContext
  private emittedFiles: Map<string, { fileName: string; source: string | Uint8Array }> = new Map()
  /** Environment API：容器所属环境（未传时为 undefined，行为同 1.x client） */
  readonly environment?: EnvironmentInstance

  constructor(config: ResolvedConfig, environment?: EnvironmentInstance) {
    this.config = config
    this.environment = environment
    // 按 enforce 分组，处理 pre/post 显式依赖并执行稳定拓扑排序
    this.plugins = orderPlugins(config.plugins)
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
      environment: container.environment,
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
    // ssr 标志由环境 consumer 派生（1.x 写死 false；client 环境行为不变）
    const ssr = this.environment?.consumer === 'server'
    for (const plugin of this.plugins) {
      if (!plugin.resolveId) continue
      const result = await plugin.resolveId.call(
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
