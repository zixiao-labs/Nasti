import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import type {
  NastiConfig,
  ResolvedConfig,
  NastiPlugin,
  EnvironmentOptions,
} from '../types.js'
import { defaults } from './defaults.js'
import { createLogger } from '../core/logger.js'

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

/**
 * Resolve the final configuration by loading file-based config, merging with inline config, and applying plugin hooks.
 *
 * Loads configuration from the project root (derived from `inlineConfig.root` or defaults), deep-merges file config with `inlineConfig` (inline takes precedence), runs each plugin's `config` hook and incorporates any returned partial config, constructs the complete `ResolvedConfig` (filling defaults for missing values and resolving tsconfig paths), filters plugins according to their `apply` field, and then invokes each included plugin's `configResolved` hook.
 *
 * @param inlineConfig - User-provided configuration that overrides file config and defaults
 * @param command - The current command, either `"build"` or `"serve"`, which influences mode and plugin filtering
 * @returns The fully resolved configuration with defaults applied, plugins filtered, and plugin hooks executed
 */
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

  // mode：merged.mode 优先，否则按 command 取默认。env（传给 plugin.config）
  // 与最终 resolved.mode 共用此值，避免二者分叉（否则 loadEnv 会按错误的
  // mode 加载 .env.<mode>，且插件看到的 env.mode 与 resolved.mode 不一致）
  const mode = (merged.mode ??
    (command === 'build' ? 'production' : 'development')) as ResolvedConfig['mode']

  // 执行插件 config 钩子
  const env = { mode, command }
  for (const plugin of rawPlugins) {
    if (plugin.config) {
      const result = await plugin.config(merged, env)
      if (result) Object.assign(merged, result)
    }
  }

  // 先构建 resolved，plugins 稍后填入（避免过滤时引用未初始化变量）
  const logLevel = merged.logLevel ?? defaults.logLevel
  const clearScreen = merged.clearScreen ?? defaults.clearScreen
  const logger = createLogger(logLevel, {
    allowClearScreen: clearScreen,
    customLogger: merged.customLogger,
  })
  const mergedBuild = { ...defaults.build, ...merged.build } as ResolvedConfig['build']
  // cssMinify 未显式配置时跟随 minify
  if (merged.build?.cssMinify === undefined) {
    mergedBuild.cssMinify = !!mergedBuild.minify
  }
  const resolved: ResolvedConfig = {
    root,
    base: merged.base ?? defaults.base,
    mode,
    target: (merged.target ?? defaults.target) as ResolvedConfig['target'],
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
    build: mergedBuild,
    electron: { ...defaults.electron, ...merged.electron } as ResolvedConfig['electron'],
    envPrefix: (Array.isArray(merged.envPrefix)
      ? merged.envPrefix
      : merged.envPrefix
        ? [merged.envPrefix]
        : [...defaults.envPrefix]) as string[],
    logLevel,
    clearScreen,
    logger,
    environments: {},
    experimental: {
      bundledDev: merged.experimental?.bundledDev ?? defaults.experimental.bundledDev,
    },
  }

  // ── Environment API：解析 environments map（默认 client + ssr）──────────
  // client 与 top-level resolve/build 精确镜像（同引用）；其余环境按 consumer
  // 取 per-consumer resolve 默认值。configEnvironment 钩子在最终化前调用。
  const userEnvironments: Record<string, EnvironmentOptions> = {
    client: {},
    ssr: {},
    ...(merged.environments ?? {}),
  }
  for (const [name, envOptions] of Object.entries(userEnvironments)) {
    for (const plugin of rawPlugins) {
      if (plugin.configEnvironment) {
        const result = await plugin.configEnvironment(name, envOptions, env)
        if (result) Object.assign(envOptions, deepMerge(envOptions, result))
      }
    }
  }
  for (const [name, envOptions] of Object.entries(userEnvironments)) {
    const consumer: 'client' | 'server' =
      envOptions.consumer ?? (name === 'client' ? 'client' : 'server')

    if (name === 'client') {
      // 用户对 environments.client 的覆盖写回 top-level（镜像语义：二者是同一份）
      if (envOptions.resolve) {
        Object.assign(resolved.resolve, {
          ...envOptions.resolve,
          alias: { ...resolved.resolve.alias, ...envOptions.resolve.alias },
        })
      }
      if (envOptions.build) Object.assign(resolved.build, envOptions.build)
      resolved.environments.client = {
        consumer,
        entry: [],
        // 同引用 —— 精确镜像（assertClientEnvironmentMirror 校验）
        resolve: resolved.resolve,
        build: resolved.build,
      }
      continue
    }

    resolved.environments[name] = {
      consumer,
      entry: (Array.isArray(envOptions.entry)
        ? envOptions.entry
        : envOptions.entry
          ? [envOptions.entry]
          : []
      ).map((e) => path.resolve(root, e)),
      resolve: {
        alias: { ...resolved.resolve.alias, ...envOptions.resolve?.alias },
        extensions: envOptions.resolve?.extensions ?? [...resolved.resolve.extensions],
        // server consumer：node conditions（去 'browser'）；client 非默认环境沿用 top-level
        conditions:
          envOptions.resolve?.conditions ??
          (consumer === 'server'
            ? ['node', ...resolved.resolve.conditions.filter((c) => c !== 'browser')]
            : [...resolved.resolve.conditions]),
        mainFields:
          envOptions.resolve?.mainFields ??
          (consumer === 'server' ? ['module', 'main'] : [...resolved.resolve.mainFields]),
      },
      build: {
        ...resolved.build,
        ...envOptions.build,
        // 非 client 环境默认产出到 <outDir>/<envName>（如 dist/ssr），可显式覆盖
        outDir: envOptions.build?.outDir ?? path.join(resolved.build.outDir, name),
        // server 产物默认不压缩（可调试性优先，与 Vite SSR 默认一致），可显式覆盖
        minify: envOptions.build?.minify ?? (consumer === 'server' ? false : resolved.build.minify),
      },
    }
  }

  assertClientEnvironmentMirror(resolved)

  // 过滤插件（apply 为函数时可安全访问已初始化的 resolved）
  const filteredPlugins = rawPlugins.filter((p) => {
    if (!p.apply) return true
    if (typeof p.apply === 'function') return p.apply(resolved, env)
    return p.apply === command
  })
  resolved.plugins = filteredPlugins

  // Electron 目标：扫描 dependencies 自动外部化 native 模块
  // （带 binding.gyp、gypfile:true，或 node_modules 内存在 *.node 的包）。
  // rolldown 尝试把 .node 打进 main 会直接爆，提前标为 external 才能正常 require。
  if (resolved.target === 'electron') {
    const autoExternal = detectNativeDeps(root)
    if (autoExternal.length > 0) {
      const current = new Set(resolved.electron.external ?? [])
      for (const dep of autoExternal) current.add(dep)
      resolved.electron.external = [...current]
    }
  }

  // 执行插件 configResolved 钩子
  for (const plugin of resolved.plugins) {
    if (plugin.configResolved) {
      await plugin.configResolved(resolved)
    }
  }

  return resolved
}

/**
 * 扫描项目 dependencies，返回需要从 Electron 主进程 bundle 中外部化的 native 模块列表。
 *
 * 判定依据（任一满足即视为 native）：
 *   - 包根目录存在 binding.gyp
 *   - package.json 有 gypfile: true
 *   - 包内存在 *.node 预编译产物
 *   - 常见已知 native 包白名单（对付有些包不走 node-gyp 但运行时仍需原生 addon 的场景）
 */
export function detectNativeDeps(root: string): string[] {
  const result = new Set<string>()
  const pkgJsonPath = path.resolve(root, 'package.json')
  if (!fs.existsSync(pkgJsonPath)) return []
  let pkg: Record<string, any>
  try {
    pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'))
  } catch {
    return []
  }
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
  }
  // 已知需要外部化的 Electron 生态 native 模块
  const KNOWN_NATIVE = new Set([
    'node-pty',
    'better-sqlite3',
    'sharp',
    'serialport',
    '@vscode/tree-sitter-wasm',
    'keytar',
    'nodegit',
    'sqlite3',
    'fsevents',
  ])
  for (const dep of Object.keys(deps)) {
    if (KNOWN_NATIVE.has(dep)) {
      result.add(dep)
      continue
    }
    const depDir = path.resolve(root, 'node_modules', dep)
    if (!fs.existsSync(depDir)) continue
    // binding.gyp
    if (fs.existsSync(path.join(depDir, 'binding.gyp'))) {
      result.add(dep)
      continue
    }
    // package.json: gypfile
    const subPkg = path.join(depDir, 'package.json')
    if (fs.existsSync(subPkg)) {
      try {
        const sub = JSON.parse(fs.readFileSync(subPkg, 'utf-8'))
        if (sub.gypfile === true || sub.binary?.module_name) {
          result.add(dep)
          continue
        }
      } catch {
        /* ignore */
      }
    }
    // 浅层扫 *.node 文件（build/Release 或 prebuilds 目录）
    if (hasDotNodeFile(depDir)) {
      result.add(dep)
    }
  }
  return [...result]
}

function hasDotNodeFile(dir: string, depth = 0): boolean {
  if (depth > 3) return false
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.node')) return true
      if (e.isDirectory() && (e.name === 'build' || e.name === 'prebuilds' || e.name === 'Release')) {
        if (hasDotNodeFile(path.join(dir, e.name), depth + 1)) return true
      }
    }
  } catch {
    /* ignore */
  }
  return false
}

/**
 * 运行时镜像断言（Phase 1 检查，NASTI_2.0_PLAN.md §1.2）：
 * top-level `resolve`/`build` 与 `environments.client` 必须**精确镜像**，
 * 否则读 flat config 的既有插件与 Environment API 会看到两份配置。
 *
 * 比较规则（文档化）：
 *   - 快路径：引用相等（resolveConfig 保证同引用，正常永远走这里）
 *   - 慢路径：JSON 序列化逐字节比较 resolve{alias,extensions,conditions,
 *     mainFields} 与 build 全字段（含 sourcemap）；函数值（如
 *     rolldownOptions.output.advancedChunks 的 test 回调）会被 JSON 丢弃，
 *     不参与比较 —— 不要在 per-env build 覆盖里只改函数字段
 *   - 设 NASTI_DISABLE_MIRROR_ASSERT=1 可关闭（不建议）
 */
export function assertClientEnvironmentMirror(config: ResolvedConfig): void {
  if (process.env.NASTI_DISABLE_MIRROR_ASSERT) return
  const client = config.environments.client
  if (!client) {
    throw new Error('[nasti] internal: environments.client missing after resolveConfig')
  }
  if (client.resolve === config.resolve && client.build === config.build) return
  const pairs: Array<[string, unknown, unknown]> = [
    ['resolve', config.resolve, client.resolve],
    ['build', config.build, client.build],
  ]
  for (const [field, top, env] of pairs) {
    const a = JSON.stringify(top)
    const b = JSON.stringify(env)
    if (a !== b) {
      throw new Error(
        `[nasti] config mirror violation: top-level \`${field}\` and ` +
          `\`environments.client.${field}\` diverged.\n  top-level: ${a}\n  client:    ${b}\n` +
          `top-level 与 client 环境必须精确镜像 —— 请通过 top-level 或 ` +
          `environments.client 之一配置，不要在解析后分别修改两者。`,
      )
    }
  }
}

/** 仅普通对象字面量返回 true —— 类实例 / 函数 / Date / Map 等不算，
 *  避免 deepMerge 递归剥掉它们的原型方法（如自定义 customLogger 实例）。 */
function isPlainObject(val: unknown): val is Record<string, any> {
  if (val === null || typeof val !== 'object') return false
  const proto = Object.getPrototypeOf(val)
  return proto === Object.prototype || proto === null
}

function deepMerge<T extends Record<string, any>>(target: T, source: Record<string, any>): T {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    const val = source[key]
    // 只对普通对象递归合并；其余（类实例/函数/数组…）整体按引用赋值，保留原型
    if (isPlainObject(val)) {
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
