import type {
  NastiPlugin,
  PluginApi,
  PluginApiKey,
  ResolvedConfig,
} from '../types.js'

const apiByConfig = new WeakMap<ResolvedConfig, PluginApi>()

/**
 * 按 enforce 与显式插件依赖稳定排序。
 *
 * `pre` 表示列出的插件必须先于当前插件，`post` 表示列出的插件必须后于
 * 当前插件。未安装的可选依赖会被忽略；依赖环会在配置阶段直接报错。
 */
export function orderPlugins(plugins: NastiPlugin[]): NastiPlugin[] {
  const baseline = plugins
    .map((plugin, index) => ({ plugin, index }))
    .sort((a, b) => enforceRank(a.plugin) - enforceRank(b.plugin) || a.index - b.index)
    .map(({ plugin }) => plugin)

  const indexesByName = new Map<string, number[]>()
  baseline.forEach((plugin, index) => {
    const indexes = indexesByName.get(plugin.name) ?? []
    indexes.push(index)
    indexesByName.set(plugin.name, indexes)
  })

  const edges = baseline.map(() => new Set<number>())
  const indegree = baseline.map(() => 0)
  const addEdge = (from: number, to: number) => {
    if (from === to || edges[from].has(to)) return
    edges[from].add(to)
    indegree[to]++
  }

  baseline.forEach((plugin, current) => {
    for (const dependency of plugin.pre ?? []) {
      for (const before of indexesByName.get(dependency) ?? []) addEdge(before, current)
    }
    for (const dependency of plugin.post ?? []) {
      for (const after of indexesByName.get(dependency) ?? []) addEdge(current, after)
    }
  })

  const ready = indegree
    .map((degree, index) => ({ degree, index }))
    .filter(({ degree }) => degree === 0)
    .map(({ index }) => index)
  const ordered: NastiPlugin[] = []

  while (ready.length > 0) {
    ready.sort((a, b) => a - b)
    const current = ready.shift()!
    ordered.push(baseline[current])
    for (const next of edges[current]) {
      indegree[next]--
      if (indegree[next] === 0) ready.push(next)
    }
  }

  if (ordered.length !== baseline.length) {
    const cyclic = baseline
      .filter((_, index) => indegree[index] > 0)
      .map((plugin) => plugin.name)
    throw new Error(
      `[nasti] circular plugin setup dependency: ${[...new Set(cyclic)].join(', ')}`,
    )
  }

  return ordered
}

/** 创建并注册一次配置解析周期内共享的插件 API。 */
export async function setupPluginApi(
  config: ResolvedConfig,
  plugins: NastiPlugin[],
): Promise<PluginApi> {
  const exposed = new Map<PluginApiKey, unknown>()
  const api: PluginApi = {
    config,
    logger: config.logger,
    expose<T>(key: PluginApiKey, value: T) {
      if (exposed.has(key) && exposed.get(key) !== value) {
        throw new Error(`[nasti] plugin API key already exposed: ${String(key)}`)
      }
      exposed.set(key, value)
    },
    useExposed<T>(key: PluginApiKey): T | undefined {
      return exposed.get(key) as T | undefined
    },
  }

  apiByConfig.set(config, api)
  for (const plugin of plugins) {
    await plugin.setup?.(api)
  }
  return api
}

export function getPluginApi(config: ResolvedConfig): PluginApi {
  const api = apiByConfig.get(config)
  if (!api) {
    throw new Error(
      '[nasti] internal: plugin API requested before setup; getPluginApi requires ' +
        'the original ResolvedConfig reference registered by setupPluginApi, not a shallow copy',
    )
  }
  return api
}

function enforceRank(plugin: NastiPlugin): number {
  if (plugin.enforce === 'pre') return 0
  if (plugin.enforce === 'post') return 2
  return 1
}
