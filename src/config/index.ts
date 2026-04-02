import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import type { NastiConfig, ResolvedConfig, NastiPlugin } from '../types.js'
import { defaults } from './defaults.js'

/** 读取 tsconfig.json 中的 paths，转换为 Nasti alias 格式 */
function loadTsconfigPaths(root: string): Record<string, string> {
  const tsconfigPath = path.resolve(root, 'tsconfig.json')
  if (!fs.existsSync(tsconfigPath)) return {}

  try {
    const content = fs.readFileSync(tsconfigPath, 'utf-8')
    // 简单剥离注释后 JSON.parse（tsconfig 允许注释）
    const stripped = content.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    const tsconfig = JSON.parse(stripped)
    const paths: Record<string, string[]> = tsconfig?.compilerOptions?.paths ?? {}
    const baseUrl: string = tsconfig?.compilerOptions?.baseUrl ?? '.'

    const alias: Record<string, string> = {}
    for (const [pattern, targets] of Object.entries(paths)) {
      if (!targets.length) continue
      // 只处理简单别名（不含通配符 * 的键），通配符形式留给插件处理
      const cleanKey = pattern.replace(/\/\*$/, '')
      const cleanTarget = targets[0].replace(/\/\*$/, '')
      alias[cleanKey] = path.resolve(root, baseUrl, cleanTarget)
    }
    return alias
  } catch {
    return {}
  }
}

export function defineConfig(config: NastiConfig): NastiConfig {
  return config
}

const CONFIG_FILES = [
  'nasti.config.ts',
  'nasti.config.js',
  'nasti.config.mjs',
  'nasti.config.mts',
]

export async function loadConfigFromFile(root: string): Promise<NastiConfig> {
  for (const file of CONFIG_FILES) {
    const filePath = path.resolve(root, file)
    if (!fs.existsSync(filePath)) continue

    if (file.endsWith('.ts') || file.endsWith('.mts')) {
      return await loadTsConfig(filePath)
    }
    const mod = await import(pathToFileURL(filePath).href)
    return mod.default ?? mod
  }
  return {}
}

async function loadTsConfig(filePath: string): Promise<NastiConfig> {
  // 使用 oxc-transform 转译 TS 配置文件
  const { transformSync } = await import('oxc-transform')
  const code = fs.readFileSync(filePath, 'utf-8')
  const result = transformSync(filePath, code, {
    typescript: {},
  })

  // 写入临时 .mjs 文件然后 import
  const tmpFile = filePath + '.timestamp-' + Date.now() + '.mjs'
  try {
    fs.writeFileSync(tmpFile, result.code)
    const mod = await import(pathToFileURL(tmpFile).href)
    return mod.default ?? mod
  } finally {
    fs.unlinkSync(tmpFile)
  }
}

export async function resolveConfig(
  inlineConfig: NastiConfig = {},
  command: 'build' | 'serve',
): Promise<ResolvedConfig> {
  const root = path.resolve(inlineConfig.root ?? defaults.root)
  const fileConfig = await loadConfigFromFile(root)

  // 合并: fileConfig < inlineConfig
  const merged: NastiConfig = deepMerge(deepMerge({}, fileConfig), inlineConfig)

  // 收集插件
  const rawPlugins: NastiPlugin[] = [
    ...(fileConfig.plugins ?? []),
    ...(inlineConfig.plugins ?? []),
  ]

  // 执行插件 config 钩子
  const env = { mode: merged.mode ?? defaults.mode, command }
  for (const plugin of rawPlugins) {
    if (plugin.config) {
      const result = await plugin.config(merged, env)
      if (result) Object.assign(merged, result)
    }
  }

  // 先构建 resolved，plugins 稍后填入（避免过滤时引用未初始化变量）
  const resolved: ResolvedConfig = {
    root,
    base: merged.base ?? defaults.base,
    mode: (command === 'build' ? 'production' : 'development') as ResolvedConfig['mode'],
    framework: merged.framework ?? defaults.framework,
    command,
    resolve: {
      // tsconfig paths 优先级最低：tsconfig < defaults < user config
      alias: { ...loadTsconfigPaths(root), ...defaults.resolve.alias, ...merged.resolve?.alias },
      extensions: (merged.resolve?.extensions ?? defaults.resolve.extensions) as string[],
      conditions: (merged.resolve?.conditions ?? defaults.resolve.conditions) as string[],
      mainFields: (merged.resolve?.mainFields ?? defaults.resolve.mainFields) as string[],
    },
    plugins: [],
    server: { ...defaults.server, ...merged.server } as ResolvedConfig['server'],
    build: { ...defaults.build, ...merged.build } as ResolvedConfig['build'],
    envPrefix: (Array.isArray(merged.envPrefix)
      ? merged.envPrefix
      : merged.envPrefix
        ? [merged.envPrefix]
        : [...defaults.envPrefix]) as string[],
    logLevel: merged.logLevel ?? defaults.logLevel,
  }

  // 过滤插件（apply 为函数时可安全访问已初始化的 resolved）
  const filteredPlugins = rawPlugins.filter((p) => {
    if (!p.apply) return true
    if (typeof p.apply === 'function') return p.apply(resolved, env)
    return p.apply === command
  })
  resolved.plugins = filteredPlugins

  // 执行插件 configResolved 钩子
  for (const plugin of resolved.plugins) {
    if (plugin.configResolved) {
      await plugin.configResolved(resolved)
    }
  }

  return resolved
}

function deepMerge<T extends Record<string, any>>(target: T, source: Record<string, any>): T {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    const val = source[key]
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      result[key as keyof T] = deepMerge(
        (result[key as keyof T] as Record<string, any>) ?? {},
        val,
      ) as T[keyof T]
    } else if (val !== undefined) {
      result[key as keyof T] = val
    }
  }
  return result
}
