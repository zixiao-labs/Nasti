import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import type { NastiConfig, ResolvedConfig, NastiPlugin } from '../types.js'
import { defaults } from './defaults.js'

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

  // 过滤插件 (apply)
  const filteredPlugins = rawPlugins.filter((p) => {
    if (!p.apply) return true
    if (typeof p.apply === 'function') return p.apply(resolved as ResolvedConfig, env)
    return p.apply === command
  })

  const resolved: ResolvedConfig = {
    root,
    base: merged.base ?? defaults.base,
    mode: (command === 'build' ? 'production' : 'development') as ResolvedConfig['mode'],
    framework: merged.framework ?? defaults.framework,
    command,
    resolve: {
      alias: { ...defaults.resolve.alias, ...merged.resolve?.alias },
      extensions: (merged.resolve?.extensions ?? defaults.resolve.extensions) as string[],
      conditions: (merged.resolve?.conditions ?? defaults.resolve.conditions) as string[],
      mainFields: (merged.resolve?.mainFields ?? defaults.resolve.mainFields) as string[],
    },
    plugins: filteredPlugins,
    server: { ...defaults.server, ...merged.server } as ResolvedConfig['server'],
    build: { ...defaults.build, ...merged.build } as ResolvedConfig['build'],
    envPrefix: (Array.isArray(merged.envPrefix)
      ? merged.envPrefix
      : merged.envPrefix
        ? [merged.envPrefix]
        : [...defaults.envPrefix]) as string[],
    logLevel: merged.logLevel ?? defaults.logLevel,
  }

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
