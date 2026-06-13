// NastiEnvironment - Environment API 主干（NASTI_2.0_PLAN.md §1.2）
//
// Vite 8 的分层是 PartialEnvironment→BaseEnvironment→Dev/BuildEnvironment；
// Nasti 当前单图单容器，收敛为一个精简类即可：每个环境自带 name/consumer/
// 过滤后的插件列表/PluginContainer/ModuleGraph/HotChannel。
//
// SSR、完整打包模式、多端/Electron 全部表达为 environment —— 这是其余
// 2.0 特性共同依赖的主干。Phase 1 仅 client 环境有完整运行时，行为与
// 1.x 逐字节一致（环境过滤默认全通过、容器构造仅多带 environment 引用）。
import type {
  EnvironmentInstance,
  HotChannel,
  NastiPlugin,
  ResolvedConfig,
  ResolvedEnvironmentOptions,
} from '../types.js'
import { PluginContainer } from './plugin-container.js'
import { ModuleGraph } from './module-graph.js'
import { createNoopHotChannel } from './hot-channel.js'
import { createDebugger } from './debug.js'

const debug = createDebugger('nasti:environment')

export interface NastiEnvironmentInit {
  hot?: HotChannel
  mode?: 'dev' | 'build'
  /** 环境的候选插件（init 时经 applyToEnvironment 过滤） */
  plugins?: NastiPlugin[]
}

export class NastiEnvironment implements EnvironmentInstance {
  readonly name: string
  readonly consumer: 'client' | 'server'
  readonly mode: 'dev' | 'build'
  readonly config: ResolvedConfig
  readonly options: ResolvedEnvironmentOptions
  readonly hot: HotChannel

  /** applyToEnvironment 过滤后的插件（init() 后可用） */
  plugins: NastiPlugin[] = []
  /** per-env 插件容器（init() 后可用；dev 管线使用） */
  pluginContainer: PluginContainer | null = null
  /** per-env 模块图（dev 管线使用） */
  moduleGraph: ModuleGraph

  private candidatePlugins: NastiPlugin[]
  private initialized = false

  constructor(name: string, config: ResolvedConfig, init: NastiEnvironmentInit = {}) {
    const options = config.environments[name]
    if (!options) {
      throw new Error(
        `[nasti] unknown environment "${name}" — declare it in config.environments`,
      )
    }
    this.name = name
    this.consumer = options.consumer
    this.mode = init.mode ?? (config.command === 'build' ? 'build' : 'dev')
    this.config = config
    this.options = options
    this.hot = init.hot ?? createNoopHotChannel()
    this.moduleGraph = new ModuleGraph()
    this.candidatePlugins = init.plugins ?? config.plugins
  }

  /** 过滤插件并建 per-env PluginContainer */
  async init(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    this.plugins = resolveEnvironmentPlugins(this, this.candidatePlugins)
    this.pluginContainer = new PluginContainer(
      { ...this.config, plugins: this.plugins },
      this,
    )
    debug?.(`env "${this.name}" initialized (${this.plugins.length} plugins)`)
  }

  async close(): Promise<void> {
    await this.hot.close?.()
  }
}

/** 按 applyToEnvironment 过滤环境插件（未声明 = 应用于所有环境） */
export function resolveEnvironmentPlugins(
  environment: EnvironmentInstance,
  plugins: NastiPlugin[],
): NastiPlugin[] {
  return plugins.filter((p) => {
    if (!p.applyToEnvironment) return true
    try {
      return p.applyToEnvironment(environment)
    } catch (err: any) {
      environment.config.logger.error(
        `[nasti] plugin "${p.name}" applyToEnvironment threw: ${err.message}`,
        { error: err },
      )
      return false
    }
  })
}
